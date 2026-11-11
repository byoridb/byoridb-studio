use crate::{
    editor::Editor,
    service::{private_write, Connection},
};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
    process::Stdio,
    sync::{Arc, OnceLock},
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::Command,
    sync::{watch, Mutex},
};
use uuid::Uuid;

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
#[derive(Clone)]
struct Job {
    value: Value,
    cancel: Option<watch::Sender<bool>>,
    /// A failed CLI printed a sign-in error. Only meaningful with a failing exit code.
    auth_hint: bool,
}
type Jobs = Arc<Mutex<HashMap<String, Job>>>;
/// Finished jobs kept in memory for status polling and `agent.list`.
pub const FINISHED_JOB_LIMIT: usize = 50;

/// Drops the oldest finished jobs beyond the limit; running jobs are never removed.
pub fn prune_finished(finished: Vec<(String, u64)>) -> Vec<String> {
    let mut finished = finished;
    finished.sort_by_key(|(_, at)| std::cmp::Reverse(*at));
    finished
        .into_iter()
        .skip(FINISHED_JOB_LIMIT)
        .map(|(id, _)| id)
        .collect()
}
fn prune_jobs(jobs: &mut HashMap<String, Job>) {
    let finished = jobs
        .iter()
        .filter_map(|(id, job)| Some((id.clone(), job.value["finishedAt"].as_u64()?)))
        .collect();
    for id in prune_finished(finished) {
        jobs.remove(&id);
    }
}

/// Process groups of running child tools, so none outlives the app.
#[derive(Clone, Default)]
pub struct ProcessGroups(Arc<std::sync::Mutex<HashSet<u32>>>);
impl ProcessGroups {
    pub fn add(&self, pid: Option<u32>) {
        if let Some(pid) = pid {
            self.0.lock().unwrap().insert(pid);
        }
    }
    pub fn remove(&self, pid: Option<u32>) {
        if let Some(pid) = pid {
            self.0.lock().unwrap().remove(&pid);
        }
    }
    pub fn kill_all(&self) {
        for pid in self.0.lock().unwrap().drain() {
            #[cfg(unix)]
            let _ = std::process::Command::new("kill")
                .args(["-KILL", "--", &format!("-{pid}")])
                .stderr(Stdio::null())
                .status();
            #[cfg(not(unix))]
            let _ = pid;
        }
    }
}
/// Force-stops the direct children of `parent` that are not tracked as process
/// groups (FFmpeg exports and renders). Only for process exit: nothing drops
/// those children once the app's event loop has ended.
pub fn kill_children_of(parent: u32) {
    #[cfg(unix)]
    let _ = std::process::Command::new("pkill")
        .args(["-KILL", "-P", &parent.to_string()])
        .stderr(Stdio::null())
        .status();
    #[cfg(not(unix))]
    let _ = parent;
}
/// Signals a whole process group; harmless when the group is already empty.
pub(crate) async fn signal_group(pid: Option<u32>, signal: &str) {
    #[cfg(unix)]
    if let Some(pid) = pid {
        let _ = Command::new("kill")
            .args([signal, "--", &format!("-{pid}")])
            .stderr(Stdio::null())
            .status()
            .await;
    }
    #[cfg(not(unix))]
    let _ = (pid, signal);
}
/// Stops a child and everything in its process group: a polite request first,
/// then a forced kill of whatever is left.
pub async fn stop_child(child: &mut tokio::process::Child) {
    let pid = child.id();
    signal_group(pid, "-TERM").await;
    let _ = tokio::time::timeout(Duration::from_secs(2), child.wait()).await;
    // Always: the leader exiting does not mean the rest of its group did.
    signal_group(pid, "-KILL").await;
    let _ = child.kill().await;
}

/// Whether a process is gone within a few seconds.
#[cfg(all(test, unix))]
pub(crate) async fn exits_soon(pid: &str) -> bool {
    for _ in 0..50 {
        // A killed process may linger as a zombie until its new parent reaps it.
        let state = std::process::Command::new("ps")
            .args(["-o", "stat=", "-p", pid])
            .output()
            .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_owned())
            .unwrap_or_default();
        if state.is_empty() || state.starts_with('Z') {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    false
}

/// Per-job bearer tokens handed to CLI agents. The service limits them to the
/// MCP allowlist and to the project that was open when the job started.
#[derive(Clone, Default)]
struct AgentTokens(Arc<std::sync::Mutex<HashMap<String, String>>>);
impl AgentTokens {
    fn issue(&self, project_id: &str) -> String {
        let token = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
        self.0
            .lock()
            .unwrap()
            .insert(token.clone(), project_id.to_owned());
        token
    }
    fn revoke(&self, token: &str) {
        self.0.lock().unwrap().remove(token);
    }
    fn project(&self, token: &str) -> Option<String> {
        self.0.lock().unwrap().get(token).cloned()
    }
}

const TOOLS_JSON: &str = include_str!("../../scripts/studio-tools.json");
/// Methods a CLI agent may call: the same definition the MCP bridge advertises.
pub fn agent_methods() -> &'static HashSet<String> {
    static METHODS: OnceLock<HashSet<String>> = OnceLock::new();
    METHODS.get_or_init(|| {
        let tools: Value = serde_json::from_str(TOOLS_JSON).expect("studio-tools.json");
        tools["tools"]
            .as_array()
            .into_iter()
            .flatten()
            .flat_map(|tool| tool["methods"].as_array().into_iter().flatten())
            .filter_map(|method| method.as_str().map(str::to_owned))
            .collect()
    })
}

pub struct Runtime {
    root: PathBuf,
    connection: Connection,
    editor: Arc<Mutex<Editor>>,
    jobs: Jobs,
    tokens: AgentTokens,
    children: ProcessGroups,
    database: Mutex<Option<tokio::process::Child>>,
    speech: crate::speech::Speech,
    mcp: crate::mcp_connections::McpConnections,
}
impl Runtime {
    pub fn new(
        root: PathBuf,
        connection: Connection,
        editor: Arc<Mutex<Editor>>,
    ) -> Result<Self, String> {
        std::fs::create_dir_all(root.join("tools")).map_err(|e| e.to_string())?;
        private_write(
            &root.join("tools/studio-mcp.py"),
            include_bytes!("../../scripts/studio-mcp.py"),
        )?;
        private_write(
            &root.join("tools/studio-cli.py"),
            include_bytes!("../../scripts/studio-cli.py"),
        )?;
        private_write(&root.join("tools/studio-tools.json"), TOOLS_JSON.as_bytes())?;
        // Nothing from a previous run is still in use: agent folders held revoked
        // tokens and install staging held downloaded archives.
        for stale in ["agent-workspaces", "downloads"] {
            let _ = std::fs::remove_dir_all(root.join(stale));
        }
        std::fs::create_dir_all(root.join("exports")).map_err(|e| e.to_string())?;
        let children = ProcessGroups::default();
        Ok(Self {
            root: root.clone(),
            connection,
            speech: crate::speech::Speech::new(root.clone(), editor.clone(), children.clone()),
            mcp: crate::mcp_connections::McpConnections::new(&root, children.clone())?,
            editor,
            jobs: Arc::new(Mutex::new(HashMap::new())),
            tokens: AgentTokens::default(),
            children,
            database: Mutex::new(None),
        })
    }
    #[cfg(test)]
    pub fn issue_agent_token(&self, project_id: &str) -> String {
        self.tokens.issue(project_id)
    }
    #[cfg(test)]
    pub fn revoke_agent_token(&self, token: &str) {
        self.tokens.revoke(token)
    }
    /// The project an agent token is bound to, or None for an unknown or revoked token.
    pub fn agent_project(&self, token: &str) -> Option<String> {
        self.tokens.project(token)
    }
    /// Stops every child process and revokes agent access. Called when the app exits.
    pub fn shutdown(&self) {
        self.children.kill_all();
        self.tokens.0.lock().unwrap().clear();
        if let Ok(mut database) = self.database.try_lock() {
            if let Some(child) = database.as_mut() {
                let _ = child.start_kill();
            }
        }
        let _ = std::fs::remove_dir_all(self.root.join("agent-workspaces"));
    }
    pub async fn dispatch(&self, method: &str, params: Value) -> Result<Value, String> {
        if method.starts_with("runtime.mcp") {
            if method == "runtime.mcpRemove"
                && self.jobs.lock().await.values().any(|job| {
                    job.value["higgsfieldConnected"] == true
                        && matches!(job.value["state"].as_str(), Some("running" | "cancelling"))
                })
            {
                return Err("Higgsfield를 사용하는 에이전트 작업이 진행 중입니다. 작업을 마치거나 취소한 뒤 연결을 삭제해주세요.".into());
            }
            return self.mcp.dispatch(method, params).await;
        }
        if method.starts_with("speech.") {
            return self.speech.dispatch(method, params).await;
        }
        match method {
            "runtime.status" => self.status().await,
            "runtime.checkUpdate" => self.check_update().await,
            "runtime.install" => self.install(params).await,
            "runtime.installStatus" | "agent.status" => self.job(&params).await,
            "runtime.start" => self.start_database().await,
            "agent.start" => self.agent_start(params).await,
            "agent.list" => Ok(self.agent_list().await),
            "agent.cancel" | "runtime.cancel" => self.cancel(&params).await,
            "memory.search" => self.memory_search(params).await,
            "memory.record" => self.memory_record(params).await,
            _ => Err(format!("지원하지 않는 런타임 명령: {method}")),
        }
    }
    async fn job(&self, params: &Value) -> Result<Value, String> {
        let id = params["id"].as_str().ok_or("작업 ID가 필요합니다")?;
        self.jobs
            .lock()
            .await
            .get(id)
            .map(|j| j.value.clone())
            .ok_or_else(|| "작업을 찾을 수 없습니다".into())
    }
    async fn agent_list(&self) -> Value {
        let jobs = self.jobs.lock().await;
        let mut list: Vec<Value> = jobs
            .values()
            .filter(|job| job.value["provider"].is_string())
            .map(|job| {
                let mut item = json!({"id":job.value["id"],"provider":job.value["provider"],"state":job.value["state"],"projectId":job.value["projectId"],"startedAt":job.value["startedAt"]});
                if !job.value["finishedAt"].is_null() {
                    item["finishedAt"] = job.value["finishedAt"].clone();
                }
                item
            })
            .collect();
        list.sort_by_key(|job| std::cmp::Reverse(job["startedAt"].as_u64().unwrap_or(0)));
        list.truncate(FINISHED_JOB_LIMIT);
        json!(list)
    }
    async fn cancel(&self, params: &Value) -> Result<Value, String> {
        let id = params["id"].as_str().ok_or("작업 ID가 필요합니다")?;
        let mut jobs = self.jobs.lock().await;
        let job = jobs.get_mut(id).ok_or("작업을 찾을 수 없습니다")?;
        if let Some(cancel) = job.cancel.as_ref() {
            let _ = cancel.send(true);
            job.value["state"] = json!("cancelling");
        }
        Ok(job.value.clone())
    }
    async fn status(&self) -> Result<Value, String> {
        let (claude, codex, gemini, ffmpeg) = tokio::join!(
            probe_provider("claude", "Claude Code"),
            probe_provider("codex", "Codex"),
            probe_provider("gemini", "Gemini CLI"),
            probe_executable("ffmpeg", &["-version"])
        );
        let db = Database::discover(&self.root);
        let healthy = db.healthy().await;
        let (connected, error) = if healthy {
            match db.login().await {
                Ok(session) => {
                    db.logout(session).await;
                    (true, None)
                }
                Err(e) => (false, Some(e)),
            }
        } else {
            (false, Some("ByoriDB가 실행 중이지 않습니다".to_owned()))
        };
        Ok(
            json!({"ffmpeg":ffmpeg,"providers":[claude,codex,gemini],"byoridb":{"installed":db.binary().is_file(),"home":db.home,"version":db.installed_version(),"running":healthy,"connected":connected,"url":db.url,"error":error,"managed":db.managed},"connection":{"url":self.connection.url}}),
        )
    }
    async fn check_update(&self) -> Result<Value, String> {
        let release = fetch_release(None).await?;
        let tag = release["tag_name"]
            .as_str()
            .ok_or("릴리스 버전 정보가 없습니다")?;
        let latest = parse_version(tag).ok_or("올바르지 않은 릴리스 버전입니다")?;
        let current = Database::discover(&self.root).installed_version();
        let update = current
            .as_deref()
            .and_then(parse_version)
            .map(|v| latest > v);
        Ok(
            json!({"installedVersion":current,"latestVersion":latest.to_string(),"tag":tag,"url":release["html_url"],"updateAvailable":update,"checkedAt":now_ms()}),
        )
    }
    async fn agent_start(&self, params: Value) -> Result<Value, String> {
        let provider = params["provider"]
            .as_str()
            .ok_or("에이전트를 선택해주세요")?;
        if !["claude", "codex", "gemini"].contains(&provider) {
            return Err("지원하지 않는 에이전트입니다".into());
        }
        let prompt = params["prompt"]
            .as_str()
            .filter(|s| !s.trim().is_empty())
            .ok_or("편집 요청을 입력해주세요")?;
        if prompt.len() > 65536 {
            return Err("편집 요청이 너무 깁니다".into());
        }
        let project = self
            .editor
            .lock()
            .await
            .dispatch("project.get", json!({}))
            .await?;
        let project_id = project["id"].as_str().unwrap_or("").to_owned();
        if [&params["projectId"], &params["_projectId"]]
            .iter()
            .any(|id| id.as_str().is_some_and(|id| id != project_id))
        {
            return Err("프로젝트가 변경되어 에이전트 작업을 시작하지 않았습니다".into());
        }
        let selection = clip_context(&project, params["clipId"].as_str())?;
        let executable = find_executable(provider).ok_or_else(|| {
            format!("{provider} CLI를 찾을 수 없습니다. CLI를 설치하고 로그인해주세요.")
        })?;
        let python =
            find_executable("python3").ok_or("MCP 연결에 필요한 Python 3을 찾을 수 없습니다")?;
        let higgsfield = self.mcp.agent_bridge().await?;
        let id = Uuid::new_v4().to_string();
        let work = self.root.join("agent-workspaces").join(&id);
        let token = self.tokens.issue(&project_id);
        let started = async {
            std::fs::create_dir_all(&work).map_err(|e| e.to_string())?;
            let connection = work.join("connection.json");
            private_write(&connection, &serde_json::to_vec(&json!({"url":self.connection.url,"token":token,"projectId":project_id})).unwrap())?;
            let command = agent_command(
                provider,
                &executable,
                &python,
                &self.root.join("tools/studio-mcp.py"),
                &connection,
                &work,
                higgsfield.as_ref(),
            )?;
            let instructions = agent_instructions(
                &project,
                &self.root.join("exports"),
                &selection,
                higgsfield.is_some(),
                prompt,
            );
            let run = AgentRun {
                id: id.clone(),
                provider: provider.to_owned(),
                project_id: project_id.clone(),
                token: token.clone(),
                work: work.clone(),
                higgsfield,
            };
            self.run_agent(command, instructions, run).await
        }
        .await;
        if started.is_err() {
            self.tokens.revoke(&token);
            let _ = std::fs::remove_dir_all(&work);
        }
        started
    }
    /// Runs one agent process to completion in the background. Its token and
    /// working folder do not outlive the process.
    async fn run_agent(
        &self,
        mut command: Command,
        instructions: String,
        run: AgentRun,
    ) -> Result<Value, String> {
        command
            .current_dir(&run.work)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        for key in ["BYORIDB_ROOT_PASSWORD", "BYORIDB_PASSWORD", "CLAUDECODE"] {
            command.env_remove(key);
        }
        if let Ok(path) = std::env::join_paths(search_paths()) {
            command.env("PATH", path);
        }
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            command.as_std_mut().process_group(0);
        }
        let mut child = command
            .spawn()
            .map_err(|e| format!("에이전트를 실행할 수 없습니다: {e}"))?;
        let pid = child.id();
        self.children.add(pid);
        if let Some(mut input) = child.stdin.take() {
            // A CLI that exits before reading reports the failure through its exit code.
            tokio::spawn(async move {
                let _ = input.write_all(instructions.as_bytes()).await;
            });
        }
        let stdout = child.stdout.take();
        let stderr = child.stderr.take();
        let (cancel_tx, mut cancel_rx) = watch::channel(false);
        let id = run.id.clone();
        self.jobs.lock().await.insert(id.clone(),Job{value:json!({"id":id,"provider":run.provider,"state":"running","logs":[],"startedAt":now_ms(),"projectId":run.project_id,"higgsfieldConnected":run.higgsfield.is_some()}),cancel:Some(cancel_tx),auth_hint:false});
        let jobs = self.jobs.clone();
        let mut readers = Vec::new();
        if let Some(out) = stdout {
            let jobs = jobs.clone();
            let id = id.clone();
            readers.push(tokio::spawn(async move {
                read_lines(jobs, id, "stdout", out).await;
            }));
        }
        if let Some(err) = stderr {
            let jobs = jobs.clone();
            let id = id.clone();
            readers.push(tokio::spawn(async move {
                read_lines(jobs, id, "stderr", err).await;
            }));
        }
        let tokens = self.tokens.clone();
        let children = self.children.clone();
        tokio::spawn(async move {
            // Keep authentication files leased until this session has stopped.
            let _mcp_lease = run.higgsfield;
            let exit = tokio::select! {
                status=child.wait()=>match status{Ok(s) if s.success()=>Exit::Success,Ok(s)=>Exit::Failed(s.code()),Err(e)=>Exit::Error(e.to_string())},
                _=tokio::time::sleep(Duration::from_secs(900))=>{stop_child(&mut child).await;Exit::Timeout}
                _=cancel_rx.changed()=>{stop_child(&mut child).await;Exit::Cancelled}
            };
            // Helpers the CLI started (MCP bridges) must not outlive it, however it ended.
            signal_group(pid, "-KILL").await;
            children.remove(pid);
            tokens.revoke(&run.token);
            for reader in readers {
                let _ = tokio::time::timeout(Duration::from_secs(2), reader).await;
            }
            let _ = tokio::fs::remove_dir_all(&run.work).await;
            let mut all = jobs.lock().await;
            if let Some(job) = all.get_mut(&run.id) {
                let (state, error, auth_required) = agent_result(exit, job.auth_hint);
                job.value["state"] = json!(state);
                job.value["finishedAt"] = json!(now_ms());
                if auth_required {
                    job.value["authRequired"] = json!(true);
                }
                if let Some(error) = error {
                    job.value["error"] = json!(error);
                }
                job.cancel = None;
            }
            prune_jobs(&mut all);
        });
        Ok(json!({"id":id}))
    }
    async fn memory_search(&self, params: Value) -> Result<Value, String> {
        let limit = params["limit"].as_u64().unwrap_or(30).clamp(1, 100);
        let text = params["text"].as_str().unwrap_or("");
        if text.len() > 4096 {
            return Err("검색어가 너무 깁니다".into());
        }
        let db = Database::discover(&self.root);
        let session = db.memory_session().await?;
        let project = params["projectId"].as_str().unwrap_or("");
        if project.len() > 128 {
            return Err("프로젝트 ID가 너무 깁니다".into());
        }
        let condition = memory_condition(text, project);
        let query=format!("MATCH (n:studio_note){condition} RETURN n.studio_note.id AS id, n.studio_note.body AS body, n.studio_note.kind AS kind, n.studio_note.project_id AS projectId, n.studio_note.clip_id AS clipId, n.studio_note.ts AS createdAt ORDER BY createdAt DESC LIMIT {limit}");
        let result = db.query(session, &query).await;
        db.logout(session).await;
        let value = result?;
        Ok(
            json!({"items":value["results"].as_array().cloned().unwrap_or_default(),"source":"byoridb"}),
        )
    }
    async fn memory_record(&self, params: Value) -> Result<Value, String> {
        let body = params["body"]
            .as_str()
            .filter(|s| !s.trim().is_empty())
            .ok_or("기억할 내용을 입력해주세요")?;
        if body.len() > 65536 {
            return Err("기억 내용은 64 KB 이내여야 합니다".into());
        }
        let kind = params["kind"].as_str().unwrap_or("feedback");
        if kind.len() > 64 {
            return Err("종류 값이 너무 깁니다".into());
        }
        let clip = params["clipId"].as_str().unwrap_or("");
        let project = self
            .editor
            .lock()
            .await
            .dispatch("project.get", json!({}))
            .await?;
        let project_id = project["id"].as_str().unwrap_or("");
        if params["_projectId"]
            .as_str()
            .is_some_and(|id| id != project_id)
        {
            return Err("프로젝트가 변경되어 기억 기록을 중단했습니다".into());
        }
        let id = Uuid::new_v4();
        let vid = (id.as_u128() as u64) & 0x7fffffffffffffff;
        let time = now_ms();
        let db = Database::discover(&self.root);
        let session = db.memory_session().await?;
        let query=format!("INSERT VERTEX studio_note(id, body, kind, project_id, clip_id, ts) VALUES {vid}:('{}', '{}', '{}', '{}', '{}', {time})",id,escape_ngql(body),escape_ngql(kind),escape_ngql(project_id),escape_ngql(clip));
        let result = db.query(session, &query).await;
        db.logout(session).await;
        result?;
        Ok(
            json!({"id":id.to_string(),"body":body,"kind":kind,"createdAt":time,"projectId":project_id,"clipId":clip,"source":"byoridb"}),
        )
    }
    async fn start_database(&self) -> Result<Value, String> {
        let db = Database::discover(&self.root);
        if db.healthy().await {
            return self.status().await;
        }
        if !db.binary().is_file() {
            return Err("먼저 ByoriDB를 설치해주세요".into());
        }
        if let Some(label) = db.label.as_ref() {
            #[cfg(target_os = "macos")]
            {
                let target = format!("gui/{}/{}", user_id().await?, label);
                let out = Command::new("launchctl")
                    .args(["kickstart", "-k", &target])
                    .output()
                    .await
                    .map_err(|e| e.to_string())?;
                if !out.status.success() {
                    return Err(
                        "Byori 서비스 시작에 실패했습니다. Byori 앱에서 서비스를 확인해주세요."
                            .into(),
                    );
                }
            }
        } else if db.managed {
            let secret = db.password().ok_or("ByoriDB 인증 설정이 없습니다")?;
            let log = std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(db.home.join("server.log"))
                .map_err(|e| e.to_string())?;
            let child = Command::new(db.binary())
                .current_dir(&db.home)
                .env("BYORIDB_ROOT_PASSWORD", secret)
                .env("BYORIDB__STORAGE__DATA_PATHS", db.home.join("data"))
                .env(
                    "BYORIDB__SERVER__HTTP_ADDR",
                    format!("127.0.0.1:{}", db.port),
                )
                .env(
                    "BYORIDB__SERVER__GRAPH_ADDR",
                    format!("127.0.0.1:{}", db.graph_port),
                )
                .stdout(Stdio::from(log.try_clone().map_err(|e| e.to_string())?))
                .stderr(Stdio::from(log))
                .kill_on_drop(true)
                .spawn()
                .map_err(|e| e.to_string())?;
            *self.database.lock().await = Some(child);
        } else {
            return Err("외부 설치입니다. Byori에서 데이터베이스를 시작해주세요.".into());
        }
        for _ in 0..30 {
            if db.healthy().await {
                return self.status().await;
            }
            tokio::time::sleep(Duration::from_millis(300)).await;
        }
        Err("ByoriDB 시작을 확인하지 못했습니다. 설정의 상태를 다시 확인해주세요.".into())
    }
    async fn install(&self, params: Value) -> Result<Value, String> {
        let tag = params["tag"]
            .as_str()
            .ok_or("먼저 최신 버전을 확인해주세요")?
            .to_owned();
        if parse_version(&tag).is_none() || tag.contains('/') {
            return Err("올바르지 않은 릴리스 버전입니다".into());
        }
        if self
            .jobs
            .lock()
            .await
            .values()
            .any(|j| j.value["kind"] == "install" && j.value["state"] == "running")
        {
            return Err("설치가 이미 진행 중입니다".into());
        }
        let db = Database::discover(&self.root);
        if let Some(installed) = db.installed_version().and_then(|v| parse_version(&v)) {
            if parse_version(&tag).unwrap() < installed {
                return Err("설치된 버전보다 이전 버전으로 내릴 수 없습니다".into());
            }
        }
        if db.healthy().await && !db.managed && db.label.is_none() {
            return Err("외부에서 실행 중인 데이터베이스는 Studio에서 교체하지 않습니다".into());
        }
        let id = Uuid::new_v4().to_string();
        let jobs = self.jobs.clone();
        jobs.lock().await.insert(id.clone(),Job{value:json!({"id":id,"kind":"install","state":"running","progress":0.0,"logs":[],"tag":tag}),cancel:None,auth_hint:false});
        let root = self.root.clone();
        let run_id = id.clone();
        tokio::spawn(async move {
            let result = install_engine(&db, &tag, &root, &jobs, &run_id).await;
            // The staged archive and the rollback copy are only needed during the install.
            let _ = tokio::fs::remove_dir_all(root.join("downloads").join(&run_id)).await;
            let mut all = jobs.lock().await;
            if let Some(job) = all.get_mut(&run_id) {
                job.value["finishedAt"] = json!(now_ms());
                match result {
                    Ok(()) => {
                        job.value["state"] = json!("completed");
                        job.value["progress"] = json!(1.0)
                    }
                    Err(error) => {
                        job.value["state"] = json!("failed");
                        job.value["error"] = json!(error)
                    }
                }
            }
            prune_jobs(&mut all);
        });
        Ok(json!({"id":id,"state":"running"}))
    }
}

struct AgentRun {
    id: String,
    provider: String,
    project_id: String,
    token: String,
    work: PathBuf,
    higgsfield: Option<crate::mcp_connections::Bridge>,
}
enum Exit {
    Success,
    Failed(Option<i32>),
    Error(String),
    Timeout,
    Cancelled,
}
/// Final job state, error text and whether the user must sign in to the CLI.
/// A sign-in hint counts only when the CLI itself failed, never for a completed
/// or cancelled job whose output merely mentions logging in.
fn agent_result(exit: Exit, auth_hint: bool) -> (&'static str, Option<String>, bool) {
    match exit {
        Exit::Success => ("completed", None, false),
        Exit::Cancelled => ("cancelled", None, false),
        Exit::Timeout => (
            "failed",
            Some("에이전트 실행 제한 시간(15분)을 초과했습니다".into()),
            false,
        ),
        Exit::Failed(_) if auth_hint => (
            "failed",
            Some("CLI 로그인이 필요합니다. 터미널에서 해당 CLI를 실행해 로그인한 뒤 다시 시도해주세요.".into()),
            true,
        ),
        Exit::Failed(code) => (
            "failed",
            Some(format!("에이전트가 종료 코드 {code:?}로 종료했습니다. 작업 로그를 확인해주세요.")),
            false,
        ),
        Exit::Error(error) => ("failed", Some(error), false),
    }
}
/// stdout carries model text and tool results (captions included), so only CLI
/// diagnostics count: stderr lines and structured error events.
fn auth_hint(stream: &str, line: &str) -> bool {
    let diagnostic = stream == "stderr"
        || serde_json::from_str::<Value>(line)
            .is_ok_and(|event| event["is_error"] == true || event["type"] == "error");
    let lower = line.to_ascii_lowercase();
    diagnostic
        && [
            "authentication cancelled",
            "not logged in",
            "please log in",
            "please run /login",
            "authentication required",
        ]
        .iter()
        .any(|pattern| lower.contains(pattern))
}
fn clip_context(project: &Value, clip_id: Option<&str>) -> Result<String, String> {
    let Some(id) = clip_id.filter(|id| !id.is_empty()) else {
        return Ok(String::new());
    };
    let clip = project["clips"]
        .as_array()
        .and_then(|clips| clips.iter().find(|clip| clip["id"] == id))
        .ok_or("선택한 클립을 찾을 수 없습니다. 클립을 다시 선택해주세요.")?;
    Ok(format!(
        " The user has clip {} selected (track {}, start {}s, duration {}s); \"this clip\" or \"the selected clip\" means that clip.",
        json!(id),
        clip["trackId"],
        clip["start"],
        clip["duration"]
    ))
}
fn agent_instructions(
    project: &Value,
    exports: &Path,
    selection: &str,
    higgsfield: bool,
    prompt: &str,
) -> String {
    let generation = if higgsfield {
        " Higgsfield MCP is connected for read-only model discovery, account credits and saved preferences. Only its explicitly allowed read-only tools are available in this headless session. Paid generation and remote mutations require a separate approval flow which this Studio session does not yet provide; explain that limitation honestly instead of claiming generation or trying another route. Follow the current tool descriptions and report actual supported models."
    } else {
        ""
    };
    format!("You are editing a video in Byori Studio. Use the studio MCP tools to inspect and change the OPEN project. Do not edit project files or run commands. First call studio_project with method project.get, inspect media, tracks, clips, concept and notes. Use studio_edit to apply real changes, preferably an atomic edit.batch with expectedRevision. Times are seconds; edit.split time and edit.trim start/end are absolute timeline times. Use edit.trim to shorten or extend clip edges; omit the unchanged boundary. Trim preserves source alignment and keyframes. Read relevant creative memory using studio_memory. Never claim an edit or render succeeded unless the tool confirms it. This session is limited to the open project: you cannot create, open, switch or delete projects, install software or change settings. Output files (export, captions, presets, project copies) can only be new files inside {} or the user's Movies, Documents, Desktop, Downloads or Music folders; existing files are never overwritten, so pick a new name on FILE_EXISTS.{generation} Report exact edits in Korean and explain unavailable capabilities honestly. Current project: {} (revision {}).{selection}\n\nUser request:\n{prompt}", exports.display(), project["name"].as_str().unwrap_or(""), project["revision"])
}
/// Every built-in Gemini CLI tool that reads or writes files, runs commands or
/// reaches the network. Studio's MCP tools are the only way to act.
const GEMINI_BUILTIN_TOOLS: [&str; 14] = [
    "run_shell_command",
    "write_file",
    "replace",
    "read_file",
    "read_many_files",
    "list_directory",
    "glob",
    "grep_search",
    "search_file_content",
    "web_fetch",
    "google_web_search",
    "save_memory",
    "activate_skill",
    "ask_user",
];
fn gemini_settings(servers: &Value) -> Value {
    let names: Vec<&String> = servers
        .as_object()
        .map(|servers| servers.keys().collect())
        .unwrap_or_default();
    json!({"mcpServers":servers,"mcp":{"allowed":names},"tools":{"exclude":GEMINI_BUILTIN_TOOLS}})
}
fn agent_command(
    provider: &str,
    executable: &Path,
    python: &Path,
    mcp: &Path,
    connection: &Path,
    work: &Path,
    higgsfield: Option<&crate::mcp_connections::Bridge>,
) -> Result<Command, String> {
    let server = json!({"command":python,"args":[mcp,"--connection",connection],"trust":true});
    let mut servers = json!({"studio":server});
    if let Some(bridge) = higgsfield {
        servers["higgsfield"] = bridge.server();
    }
    let mcp_file = work.join("studio-mcp.json");
    private_write(
        &mcp_file,
        &serde_json::to_vec(&json!({"mcpServers":servers})).unwrap(),
    )?;
        let mut command = Command::new(executable);
        let allowed_tools = if let Some(bridge) = higgsfield {
            std::iter::once("mcp__studio__*".to_owned())
                .chain(
                    bridge
                        .tools
                        .iter()
                        .map(|tool| format!("mcp__higgsfield__{tool}")),
                )
                .collect::<Vec<_>>()
                .join(",")
        } else {
            "mcp__studio__*".to_owned()
        };
        match provider {
            "claude" => {
                command
                    .args([
                        "--print",
                        "--verbose",
                        "--output-format",
                        "stream-json",
                        "--permission-mode",
                        "dontAsk",
                        "--allowedTools",
                        &allowed_tools,
                        "--tools",
                        "",
                        "--strict-mcp-config",
                        "--mcp-config",
                    ])
                    .arg(&mcp_file)
                    .args(["--setting-sources", ""]);
            }
            "codex" => {
                command
                    .args([
                        "exec",
                        "--json",
                        "--color",
                        "never",
                        "--skip-git-repo-check",
                        "--ignore-user-config",
                        "--ignore-rules",
                        "--sandbox",
                        "read-only",
                        "-c",
                    ])
                    .arg(format!(
                        "mcp_servers.studio.command={}",
                        serde_json::to_string(&python.to_string_lossy()).unwrap()
                    ))
                    .arg("-c")
                    .arg(format!(
                        "mcp_servers.studio.args={}",
                        json!([mcp, "--connection", connection])
                    ))
                    .arg("-c")
                    .arg("mcp_servers.studio.startup_timeout_sec=20")
                    .arg("-c").arg("mcp_servers.studio.default_tools_approval_mode=\"approve\"")
                    .arg("-c").arg("mcp_servers.studio.enabled_tools=[\"studio_project\",\"studio_edit\",\"studio_export\",\"studio_memory\",\"studio_speech\",\"studio_assets\"]");
                if let Some(bridge) = higgsfield {
                    command.arg("-c").arg(format!(
                        "mcp_servers.higgsfield.command={}",
                        json!(bridge.command)
                    ));
                    command.arg("-c").arg(format!(
                        "mcp_servers.higgsfield.args={}",
                        json!(bridge.args)
                    ));
                    for (key, value) in &bridge.env {
                        command
                            .arg("-c")
                            .arg(format!("mcp_servers.higgsfield.env.{key}={value}"));
                    }
                    command
                        .arg("-c")
                        .arg("mcp_servers.higgsfield.startup_timeout_sec=45");
                    command
                        .arg("-c")
                        .arg("mcp_servers.higgsfield.default_tools_approval_mode=\"approve\"");
                    command.arg("-c").arg(format!(
                        "mcp_servers.higgsfield.enabled_tools={}",
                        json!(bridge.tools)
                    ));
                }
                command.arg("-");
            }
            "gemini" => {
                std::fs::create_dir_all(work.join(".gemini")).map_err(|e| e.to_string())?;
                private_write(
                    &work.join(".gemini/settings.json"),
                    &serde_json::to_vec(&gemini_settings(&servers)).unwrap(),
                )?;
                command.args([
                    "--prompt",
                    "Complete the editing request provided on stdin.",
                    "--output-format",
                    "stream-json",
                    "--extensions",
                    "none",
                    "--allowed-mcp-server-names",
                    "studio",
                ]);
                if higgsfield.is_some() {
                    command.arg("higgsfield");
                }
                command.arg("--skip-trust");
            }
            _ => unreachable!(),
        }
    Ok(command)
}

async fn append_log(jobs: &Jobs, id: &str, stream: &str, text: String) {
    let mut all = jobs.lock().await;
    if let Some(job) = all.get_mut(id) {
        let logs = job.value["logs"].as_array_mut().unwrap();
        logs.push(json!({"at":now_ms(),"stream":stream,"text":text.chars().take(16384).collect::<String>()}));
        if logs.len() > 500 {
            logs.remove(0);
        }
    }
}
async fn read_lines<R: tokio::io::AsyncRead + Unpin>(
    jobs: Jobs,
    id: String,
    stream: &str,
    reader: R,
) {
    let mut lines = BufReader::new(reader).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        if auth_hint(stream, &line) {
            let mut all = jobs.lock().await;
            if let Some(job) = all.get_mut(&id) {
                job.auth_hint = true;
            }
        }
        if let Ok(event) = serde_json::from_str::<Value>(&line) {
            if let Some(result) = event.get("result").and_then(Value::as_str) {
                let mut all = jobs.lock().await;
                if let Some(job) = all.get_mut(&id) {
                    job.value["result"] = json!(result);
                }
            }
            if event["type"] == "item.completed" && event["item"]["type"] == "agent_message" {
                let mut all = jobs.lock().await;
                if let Some(job) = all.get_mut(&id) {
                    job.value["result"] = event["item"]["text"].clone();
                }
            }
            if event["type"] == "message" && event["role"] == "assistant" {
                if let Some(text) = event["content"].as_str() {
                    let mut all = jobs.lock().await;
                    if let Some(job) = all.get_mut(&id) {
                        let prev = job.value["result"].as_str().unwrap_or("");
                        job.value["result"] = json!(format!("{prev}{text}"));
                    }
                }
            }
        }
        append_log(&jobs, &id, stream, line).await;
    }
}

/// Where command-line tools live. An app opened from Finder does not inherit
/// the shell PATH, so the usual install locations are searched as well.
fn search_paths_from(path: Option<std::ffi::OsString>, home: &Path) -> Vec<PathBuf> {
    let mut paths: Vec<PathBuf> = std::env::split_paths(&path.unwrap_or_default()).collect();
    paths.extend(
        [
            ".local/bin",
            ".volta/bin",
            ".bun/bin",
            ".deno/bin",
            ".cargo/bin",
            ".npm-global/bin",
            ".asdf/shims",
            ".pyenv/shims",
            ".local/share/mise/shims",
            ".local/share/fnm/aliases/default/bin",
            "Library/pnpm",
        ]
        .map(|relative| home.join(relative)),
    );
    // nvm keeps one folder per Node version; prefer the newest.
    let mut node: Vec<(semver::Version, PathBuf)> = std::fs::read_dir(home.join(".nvm/versions/node"))
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|entry| {
            Some((
                parse_version(&entry.file_name().to_string_lossy())?,
                entry.path().join("bin"),
            ))
        })
        .collect();
    node.sort_by(|a, b| b.0.cmp(&a.0));
    paths.extend(node.into_iter().map(|(_, path)| path));
    paths.extend(
        [
            "/opt/homebrew/bin",
            "/usr/local/bin",
            "/opt/local/bin",
            "/usr/bin",
            "/bin",
            "/usr/sbin",
            "/sbin",
        ]
        .map(PathBuf::from),
    );
    let mut seen = HashSet::new();
    paths.retain(|path| !path.as_os_str().is_empty() && seen.insert(path.clone()));
    paths
}
pub fn search_paths() -> Vec<PathBuf> {
    search_paths_from(
        std::env::var_os("PATH"),
        &dirs::home_dir().unwrap_or_default(),
    )
}
/// Makes every child process (CLI agents, FFmpeg, Whisper, npx) see the same
/// tool locations as `find_executable`. Call once at startup, before threads start.
pub fn extend_process_path() {
    if let Ok(path) = std::env::join_paths(search_paths()) {
        std::env::set_var("PATH", path);
    }
}
pub fn find_executable(name: &str) -> Option<PathBuf> {
    search_paths()
        .into_iter()
        .map(|p| p.join(name))
        .find(|p| p.is_file())
}
async fn output(executable: &Path, args: &[&str]) -> Result<std::process::Output, String> {
    let mut cmd = Command::new(executable);
    cmd.args(args).kill_on_drop(true);
    if let Ok(path) = std::env::join_paths(search_paths()) {
        cmd.env("PATH", path);
    }
    tokio::time::timeout(Duration::from_secs(6), cmd.output())
        .await
        .map_err(|_| "명령 확인 시간이 초과되었습니다".to_owned())?
        .map_err(|e| e.to_string())
}
async fn probe_executable(name: &str, args: &[&str]) -> Value {
    let path = find_executable(name);
    let mut version = None;
    if let Some(path) = path.as_ref() {
        if let Ok(out) = output(path, args).await {
            if out.status.success() {
                version = String::from_utf8_lossy(&out.stdout)
                    .lines()
                    .next()
                    .map(|s| s.chars().take(180).collect::<String>());
            }
        }
    }
    json!({"available":path.is_some(),"path":path,"version":version})
}
async fn probe_provider(id: &str, name: &str) -> Value {
    let mut value = probe_executable(id, &["--version"]).await;
    value["id"] = json!(id);
    value["name"] = json!(name);
    value["authStatus"] = json!("unknown");
    if let Some(path) = value["path"].as_str().map(str::to_owned) {
        if id == "claude" {
            if let Ok(out) = output(Path::new(&path), &["auth", "status", "--json"]).await {
                if let Ok(auth) = serde_json::from_slice::<Value>(&out.stdout) {
                    value["authStatus"] = json!(if auth["loggedIn"] == true {
                        "authenticated"
                    } else {
                        "missing"
                    });
                }
            }
        }
        if id == "codex" {
            if let Ok(out) = output(Path::new(&path), &["login", "status"]).await {
                value["authStatus"] = json!(if out.status.success() {
                    "authenticated"
                } else {
                    "missing"
                });
            }
        }
        if id == "gemini" {
            let home = dirs::home_dir().unwrap_or_default();
            value["authStatus"] = json!(if home.join(".gemini/oauth_creds.json").is_file()
                || std::env::var_os("GEMINI_API_KEY").is_some()
            {
                "configured"
            } else {
                "unknown"
            });
        }
    }
    value
}
fn parse_version(value: &str) -> Option<semver::Version> {
    semver::Version::parse(
        value
            .trim()
            .trim_start_matches('v')
            .split_whitespace()
            .next()?,
    )
    .ok()
}
/// The WHERE clause of a note search: body text and, when given, one project.
fn memory_condition(text: &str, project: &str) -> String {
    let mut parts = Vec::new();
    if !text.is_empty() {
        parts.push(format!("n.studio_note.body CONTAINS '{}'", escape_ngql(text)));
    }
    if !project.is_empty() {
        parts.push(format!("n.studio_note.project_id == '{}'", escape_ngql(project)));
    }
    if parts.is_empty() {
        String::new()
    } else {
        format!(" WHERE {}", parts.join(" AND "))
    }
}

fn escape_ngql(value: &str) -> String {
    value
        .replace('\\', "\\\\")
        .replace('\'', "\\'")
        .replace('\n', "\\n")
        .replace('\r', "\\r")
        .replace('\0', "")
}
fn client() -> reqwest::Client {
    reqwest::Client::builder()
        .user_agent("Byori-Studio/0.1")
        .timeout(Duration::from_secs(15))
        .build()
        .unwrap()
}
async fn fetch_release(tag: Option<&str>) -> Result<Value, String> {
    let suffix = tag
        .map(|t| format!("tags/{t}"))
        .unwrap_or_else(|| "latest".into());
    let response = client()
        .get(format!(
            "https://api.github.com/repos/byoridb/byoridb/releases/{suffix}"
        ))
        .send()
        .await
        .map_err(|e| format!("최신 버전을 확인할 수 없습니다: {e}"))?;
    if !response.status().is_success() {
        return Err(format!("릴리스 조회 실패 (HTTP {})", response.status()));
    }
    let value: Value = response.json().await.map_err(|e| e.to_string())?;
    if value["draft"] == true || value["prerelease"] == true {
        return Err("안정 릴리스만 설치할 수 있습니다".into());
    }
    Ok(value)
}

#[derive(Clone)]
struct Database {
    home: PathBuf,
    port: u16,
    graph_port: u16,
    url: String,
    label: Option<String>,
    plist: Option<PathBuf>,
    managed: bool,
}
impl Database {
    fn discover(root: &Path) -> Self {
        let home = dirs::home_dir().unwrap_or_default();
        let explicit = std::env::var_os("BYORIDB_HOME").map(PathBuf::from);
        let mut discovered: Option<(PathBuf, String, PathBuf)> = None;
        if let Ok(entries) = std::fs::read_dir(home.join("Library/LaunchAgents")) {
            let mut entries: Vec<_> = entries
                .filter_map(Result::ok)
                .map(|e| e.path())
                .filter(|p| p.extension().is_some_and(|x| x == "plist"))
                .collect();
            entries.sort_by_key(|p| {
                if p.file_name()
                    .is_some_and(|v| v == "com.byoridb.local.plist")
                {
                    0
                } else {
                    1
                }
            });
            for file in entries {
                let Ok(plist::Value::Dictionary(value)) = plist::Value::from_file(&file) else {
                    continue;
                };
                let Some(work) = value
                    .get("WorkingDirectory")
                    .and_then(plist::Value::as_string)
                else {
                    continue;
                };
                let Some(label) = value.get("Label").and_then(plist::Value::as_string) else {
                    continue;
                };
                if !label
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || "._-".contains(c))
                {
                    continue;
                }
                let expected = PathBuf::from(work).join("bin/run-server.sh");
                let valid = value
                    .get("ProgramArguments")
                    .and_then(plist::Value::as_array)
                    .is_some_and(|args| {
                        args.iter()
                            .any(|v| v.as_string().is_some_and(|v| Path::new(v) == expected))
                    });
                if !valid || !expected.is_file() {
                    continue;
                }
                if explicit.as_ref().is_some_and(|p| p != Path::new(work)) {
                    continue;
                }
                discovered = Some((PathBuf::from(work), label.into(), file));
                break;
            }
        }
        let dbhome = explicit
            .or_else(|| discovered.as_ref().map(|v| v.0.clone()))
            .unwrap_or_else(|| {
                let old = home.join(".byoridb");
                if old.join("bin/byoridb-server").is_file() {
                    old
                } else {
                    root.join("byoridb")
                }
            });
        let script = std::fs::read_to_string(dbhome.join("bin/run-server.sh")).unwrap_or_default();
        fn port_from(script: &str, key: &str) -> Option<u16> {
            script
                .lines()
                .find(|l| l.contains(key))
                .and_then(|l| l.rsplit(':').next())
                .and_then(|s| {
                    s.chars()
                        .take_while(char::is_ascii_digit)
                        .collect::<String>()
                        .parse()
                        .ok()
                })
        }
        let port = std::env::var("BYORIDB_HTTP_PORT")
            .ok()
            .and_then(|v| v.parse().ok())
            .or_else(|| port_from(&script, "BYORIDB__SERVER__HTTP_ADDR"))
            .unwrap_or(19669);
        let graph_port = port_from(&script, "BYORIDB__SERVER__GRAPH_ADDR").unwrap_or(9669);
        let managed = dbhome == root.join("byoridb") || discovered.is_some();
        Self {
            home: dbhome,
            port,
            graph_port,
            url: format!("http://127.0.0.1:{port}"),
            label: discovered.as_ref().map(|v| v.1.clone()),
            plist: discovered.map(|v| v.2),
            managed,
        }
    }
    fn binary(&self) -> PathBuf {
        self.home.join("bin/byoridb-server")
    }
    fn installed_version(&self) -> Option<String> {
        std::fs::read(self.home.join("engine.json"))
            .ok()
            .and_then(|b| serde_json::from_slice::<Value>(&b).ok())
            .and_then(|v| v["tag"].as_str().map(str::to_owned))
    }
    fn password(&self) -> Option<String> {
        std::env::var("BYORIDB_ROOT_PASSWORD")
            .ok()
            .filter(|v| !v.is_empty())
            .or_else(|| {
                std::fs::read_to_string(self.home.join("env"))
                    .ok()
                    .and_then(|text| {
                        text.lines().find_map(|l| {
                            l.strip_prefix("BYORIDB_ROOT_PASSWORD=")
                                .map(|v| v.trim().trim_matches(['\'', '"']).to_owned())
                        })
                    })
            })
            .filter(|v| !v.is_empty())
    }
    async fn healthy(&self) -> bool {
        client()
            .get(format!("{}/health", self.url))
            .timeout(Duration::from_secs(2))
            .send()
            .await
            .map(|r| r.status().is_success())
            .unwrap_or(false)
    }
    async fn owned_listener(&self) -> bool {
        let Some(lsof) = find_executable("lsof") else {
            return false;
        };
        let out = match output(
            &lsof,
            &["-nP", &format!("-iTCP:{}", self.port), "-sTCP:LISTEN", "-t"],
        )
        .await
        {
            Ok(v) => v,
            Err(_) => return false,
        };
        let pids = String::from_utf8_lossy(&out.stdout);
        let expected = self.binary().canonicalize().unwrap_or(self.binary());
        for pid in pids
            .lines()
            .filter(|v| v.chars().all(|c| c.is_ascii_digit()))
        {
            if let Ok(out) = output(&lsof, &["-a", "-p", pid, "-d", "txt", "-Fn"]).await {
                if String::from_utf8_lossy(&out.stdout)
                    .lines()
                    .filter_map(|l| l.strip_prefix('n'))
                    .any(|p| Path::new(p).canonicalize().ok().as_ref() == Some(&expected))
                {
                    return true;
                }
            }
        }
        false
    }
    async fn login(&self) -> Result<i64, String> {
        if !self.owned_listener().await {
            return Err("연결된 포트가 선택한 ByoriDB 설치의 프로세스인지 확인할 수 없습니다. Byori 서비스 설정을 확인해주세요.".into());
        }
        let password = self
            .password()
            .ok_or("ByoriDB 인증 정보가 없습니다. Byori에서 설치를 완료해주세요.")?;
        let response = client()
            .post(format!("{}/api/v1/session", self.url))
            .json(&json!({"username":"root","password":password}))
            .send()
            .await
            .map_err(|e| e.to_string())?;
        if !response.status().is_success() {
            return Err(format!("ByoriDB 인증 실패 (HTTP {})", response.status()));
        }
        let value: Value = response.json().await.map_err(|e| e.to_string())?;
        value["session_id"]
            .as_i64()
            .or_else(|| {
                value["session_id"]
                    .as_str()
                    .and_then(|s| s.parse::<i64>().ok())
            })
            .ok_or_else(|| "ByoriDB 세션 응답을 읽을 수 없습니다".into())
    }
    async fn logout(&self, session: i64) {
        let response = client()
            .delete(format!("{}/api/v1/session", self.url))
            .header("x-byoridb-session-id", session.to_string())
            .send()
            .await;
        if response
            .as_ref()
            .is_ok_and(|r| r.status() == reqwest::StatusCode::NOT_FOUND)
        {
            let _ = client()
                .delete(format!("{}/api/v1/session/{session}", self.url))
                .send()
                .await;
        }
    }
    async fn query(&self, session: i64, query: &str) -> Result<Value, String> {
        let response = client()
            .post(format!("{}/api/v1/query", self.url))
            .json(&json!({"session_id":session,"query":query}))
            .send()
            .await
            .map_err(|e| e.to_string())?;
        let status = response.status();
        let value: Value = response.json().await.map_err(|e| e.to_string())?;
        if !status.is_success() {
            return Err(value["error"]
                .as_str()
                .unwrap_or("ByoriDB 쿼리 실패")
                .to_owned());
        }
        Ok(value)
    }
    async fn memory_session(&self) -> Result<i64, String> {
        let session = self.login().await?;
        for q in ["CREATE SPACE IF NOT EXISTS studio_creative (vid_type = INT64)","USE studio_creative","CREATE TAG IF NOT EXISTS studio_note(id STRING, body STRING, kind STRING, project_id STRING, clip_id STRING, ts INT64)"] {
            if let Err(e)=self.query(session,q).await{self.logout(session).await;return Err(e);}
        }
        Ok(session)
    }
}

async fn user_id() -> Result<String, String> {
    let o = Command::new("id")
        .arg("-u")
        .output()
        .await
        .map_err(|e| e.to_string())?;
    Ok(String::from_utf8_lossy(&o.stdout).trim().to_owned())
}
async fn install_log(jobs: &Jobs, id: &str, progress: f64, message: &str) {
    append_log(jobs, id, "info", message.into()).await;
    let mut all = jobs.lock().await;
    if let Some(job) = all.get_mut(id) {
        job.value["progress"] = json!(progress);
    }
}
/// LaunchAgent label for a database installed by Studio, distinct from the
/// app's own bundle identifier.
#[cfg(target_os = "macos")]
const DATABASE_LABEL: &str = "com.byori.studio.database";
fn platform_target() -> Result<&'static str, String> {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("macos", "aarch64") => Ok("aarch64-apple-darwin"),
        ("macos", "x86_64") => Ok("x86_64-apple-darwin"),
        ("linux", "x86_64") => Ok("x86_64-unknown-linux-gnu"),
        ("linux", "aarch64") => Ok("aarch64-unknown-linux-gnu"),
        _ => Err("이 운영체제의 ByoriDB 자동 설치는 아직 지원되지 않습니다".into()),
    }
}
fn sha256_hex(value: &str) -> Option<String> {
    let value = value.trim().to_ascii_lowercase();
    (value.len() == 64 && value.chars().all(|c| c.is_ascii_hexdigit())).then_some(value)
}
/// Reads the SHA-256 of `asset_name` from a checksum file: either a bare digest
/// or `sha256sum` lines (`<digest>  <name>`).
fn checksum_from(text: &str, asset_name: &str) -> Option<String> {
    if let Some(digest) = sha256_hex(text) {
        return Some(digest);
    }
    text.lines().find_map(|line| {
        let mut parts = line.split_whitespace();
        let digest = sha256_hex(parts.next()?)?;
        let name = parts.next()?.trim_start_matches(['*', '.', '/']);
        (name == asset_name).then_some(digest)
    })
}
/// The checksum the release publishes for an asset. Installation never proceeds
/// without one: GitHub's own asset digest, or a checksum file in the same release.
async fn release_checksum(
    release: &Value,
    asset: &Value,
    asset_name: &str,
    tag: &str,
) -> Result<String, String> {
    if let Some(digest) = asset["digest"]
        .as_str()
        .and_then(|d| d.strip_prefix("sha256:"))
        .and_then(sha256_hex)
    {
        return Ok(digest);
    }
    let prefix = format!("https://github.com/byoridb/byoridb/releases/download/{tag}/");
    let names = [
        format!("{asset_name}.sha256"),
        "SHA256SUMS".to_owned(),
        "SHA256SUMS.txt".to_owned(),
        "checksums.txt".to_owned(),
    ];
    for name in names {
        let Some(url) = release["assets"]
            .as_array()
            .and_then(|assets| assets.iter().find(|a| a["name"] == name.as_str()))
            .and_then(|a| a["browser_download_url"].as_str())
            .filter(|url| url.starts_with(&prefix))
        else {
            continue;
        };
        let response = client().get(url).send().await.map_err(|e| e.to_string())?;
        if !response.status().is_success() {
            continue;
        }
        let text = response.text().await.map_err(|e| e.to_string())?;
        if let Some(digest) = checksum_from(&text, asset_name) {
            return Ok(digest);
        }
    }
    Err("릴리스에 체크섬이 없어 설치 파일을 검증할 수 없습니다. 설치를 중단했습니다.".into())
}
fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

async fn install_engine(
    db: &Database,
    tag: &str,
    root: &Path,
    jobs: &Jobs,
    id: &str,
) -> Result<(), String> {
    install_log(jobs, id, 0.05, "공식 릴리스 확인 중").await;
    let release = fetch_release(Some(tag)).await?;
    let target = platform_target()?;
    let asset_name = format!("byoridb-{tag}-{target}.tar.gz");
    let asset = release["assets"]
        .as_array()
        .and_then(|a| a.iter().find(|a| a["name"] == asset_name))
        .ok_or_else(|| format!("현재 플랫폼용 릴리스 파일이 없습니다: {asset_name}"))?;
    let url = asset["browser_download_url"]
        .as_str()
        .ok_or("릴리스 다운로드 주소가 없습니다")?;
    if !url.starts_with(&format!(
        "https://github.com/byoridb/byoridb/releases/download/{tag}/"
    )) {
        return Err("공식 릴리스 주소가 아닙니다".into());
    }
    let staging = root.join("downloads").join(id);
    tokio::fs::create_dir_all(&staging)
        .await
        .map_err(|e| e.to_string())?;
    install_log(jobs, id, 0.15, "ByoriDB 다운로드 중").await;
    let mut response = reqwest::Client::builder()
        .timeout(Duration::from_secs(180))
        .user_agent("Byori-Studio")
        .build()
        .unwrap()
        .get(url)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !response.status().is_success() {
        return Err(format!("다운로드 실패: {}", response.status()));
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|e| e.to_string())? {
        if bytes.len().saturating_add(chunk.len()) > 512 * 1024 * 1024 {
            return Err("릴리스 파일이 허용 크기를 초과했습니다".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    let archive = staging.join("engine.tar.gz");
    let expected = release_checksum(&release, asset, &asset_name, tag).await?;
    if format!("{:x}", Sha256::digest(&bytes)) != expected {
        return Err("릴리스 파일 검증에 실패했습니다".into());
    }
    tokio::fs::write(&archive, &bytes)
        .await
        .map_err(|e| e.to_string())?;
    let listing = Command::new("tar")
        .args(["-tzf"])
        .arg(&archive)
        .output()
        .await
        .map_err(|e| e.to_string())?;
    if !listing.status.success() {
        return Err("릴리스 압축 파일을 읽을 수 없습니다".into());
    }
    let files = String::from_utf8_lossy(&listing.stdout);
    if files.lines().any(|p| {
        Path::new(p).is_absolute()
            || Path::new(p)
                .components()
                .any(|c| matches!(c, std::path::Component::ParentDir))
    }) {
        return Err("안전하지 않은 압축 파일 경로입니다".into());
    }
    let staged = staging.join("byoridb-server");
    let member = files
        .lines()
        .find(|p| *p == "byoridb-server" || *p == "./byoridb-server")
        .ok_or("릴리스에 실행 파일이 없습니다")?;
    extract_binary(&archive, member, &staged).await?;
    #[cfg(target_os = "macos")]
    {
        let verified = Command::new("codesign")
            .args(["--verify", "--strict"])
            .arg(&staged)
            .output()
            .await
            .map_err(|e| e.to_string())?;
        if !verified.status.success() {
            return Err("다운로드한 실행 파일의 서명을 검증할 수 없습니다".into());
        }
    }
    install_log(jobs, id, 0.6, "실행 파일 검증 완료 · 기존 데이터 유지").await;
    tokio::fs::create_dir_all(db.home.join("bin"))
        .await
        .map_err(|e| e.to_string())?;
    tokio::fs::create_dir_all(db.home.join("data"))
        .await
        .map_err(|e| e.to_string())?;
    let was_running = db.healthy().await;
    if was_running && !db.owned_listener().await {
        return Err("다른 프로세스가 사용하는 데이터베이스 포트를 변경할 수 없습니다".into());
    }
    if was_running && db.label.is_none() {
        return Err(
            "실행 중인 외부 서비스는 자동 교체할 수 없습니다. Byori에서 중지 후 다시 시도해주세요."
                .into(),
        );
    }
    let destination = db.binary();
    // Prepare every fallible file operation before stopping the existing service.
    // A per-job backup can never be confused with an earlier failed installation.
    let backup = staging.join("previous-server");
    if destination.is_file() {
        tokio::fs::copy(&destination, &backup)
            .await
            .map_err(|e| e.to_string())?;
    }
    let old_manifest = tokio::fs::read(db.home.join("engine.json")).await.ok();
    let next = db.home.join("bin/byoridb-server.next");
    tokio::fs::copy(&staged, &next)
        .await
        .map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        tokio::fs::set_permissions(&next, std::fs::Permissions::from_mode(0o755))
            .await
            .map_err(|e| e.to_string())?;
    }
    if db.password().is_none() {
        if db.home.join("env").exists() || destination.exists() {
            return Err(
                "기존 ByoriDB 인증 설정을 읽을 수 없습니다. Byori에서 인증 설정을 확인해주세요."
                    .into(),
            );
        }
        private_write(
            &db.home.join("env"),
            format!(
                "BYORIDB_ROOT_PASSWORD={}{}\n",
                Uuid::new_v4().simple(),
                Uuid::new_v4().simple()
            )
            .as_bytes(),
        )?;
    }
    let binary_bytes = tokio::fs::read(&staged).await.map_err(|e| e.to_string())?;
    let manifest = serde_json::to_vec_pretty(&json!({"tag":tag,"target":target,"sha256":format!("{:x}",Sha256::digest(binary_bytes)),"source":url,"installedAt":now_ms()})).unwrap();
    #[cfg(target_os = "macos")]
    {
        let label = db
            .label
            .clone()
            .unwrap_or_else(|| DATABASE_LABEL.into());
        let plist_path = prepare_launch_agent(db, &label)?;
        let domain = format!("gui/{}", user_id().await?);
        let service = format!("{domain}/{label}");
        let mut stopped = false;
        let mut replaced = false;
        let mut launched = false;
        let transaction: Result<(), String> = async {
            if db.label.is_some() {
                let out = Command::new("launchctl")
                    .args(["bootout", &service])
                    .output()
                    .await
                    .map_err(|e| e.to_string())?;
                if was_running && !out.status.success() {
                    return Err("기존 ByoriDB 서비스를 중지할 수 없습니다".into());
                }
                stopped = out.status.success();
            }
            tokio::fs::rename(&next, &destination)
                .await
                .map_err(|e| e.to_string())?;
            replaced = true;
            private_write(&db.home.join("engine.json"), &manifest)?;
            install_log(jobs, id, 0.85, "ByoriDB 설치 완료 · 연결 확인 중").await;
            let launch = Command::new("launchctl")
                .arg("bootstrap")
                .arg(&domain)
                .arg(&plist_path)
                .output()
                .await
                .map_err(|e| e.to_string())?;
            if !launch.status.success() {
                return Err("설치 후 서비스 시작에 실패했습니다".into());
            }
            launched = true;
            for _ in 0..40 {
                if db.healthy().await {
                    if let Ok(session) = db.login().await {
                        db.logout(session).await;
                        return Ok(());
                    }
                }
                tokio::time::sleep(Duration::from_millis(500)).await;
            }
            Err("설치 후 연결 검증에 실패했습니다".into())
        }
        .await;
        if let Err(error) = transaction {
            if launched {
                let _ = Command::new("launchctl")
                    .args(["bootout", &service])
                    .output()
                    .await;
            }
            if replaced {
                restore_binary(db, &backup, old_manifest.as_deref()).await?;
            }
            if stopped && was_running {
                let restored = Command::new("launchctl")
                    .arg("bootstrap")
                    .arg(&domain)
                    .arg(&plist_path)
                    .output()
                    .await;
                if !restored.is_ok_and(|o| o.status.success()) {
                    return Err(format!("{error}. 이전 실행 파일은 복원했지만 서비스 재시작에 실패했습니다. Byori에서 다시 시작해주세요."));
                }
            }
            if db.plist.is_none() {
                let _ = tokio::fs::remove_file(&plist_path).await;
            }
            return Err(format!("{error}. 설치 이전 상태로 복원했습니다."));
        }
        Ok(())
    }
    #[cfg(not(target_os = "macos"))]
    {
        tokio::fs::rename(&next, &destination)
            .await
            .map_err(|e| e.to_string())?;
        if let Err(error) = private_write(&db.home.join("engine.json"), &manifest) {
            restore_binary(db, &backup, old_manifest.as_deref()).await?;
            return Err(error);
        }
        Ok(())
    }
}

async fn extract_binary(archive: &Path, member: &str, destination: &Path) -> Result<(), String> {
    use tokio::io::AsyncReadExt;
    // Read only the known binary to stdout: tar never creates archive paths or symlinks.
    let mut child = Command::new("tar")
        .arg("-xOzf")
        .arg(archive)
        .arg(member)
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| e.to_string())?;
    let mut stream = child
        .stdout
        .take()
        .ok_or("압축 파일을 읽을 수 없습니다")?
        .take(512 * 1024 * 1024 + 1);
    let mut file = tokio::fs::File::create(destination)
        .await
        .map_err(|e| e.to_string())?;
    let size = tokio::io::copy(&mut stream, &mut file)
        .await
        .map_err(|e| e.to_string())?;
    if size == 0 || size > 512 * 1024 * 1024 {
        let _ = child.kill().await;
        return Err("릴리스 실행 파일의 크기가 올바르지 않습니다".into());
    }
    if !child.wait().await.map_err(|e| e.to_string())?.success() {
        return Err("릴리스 실행 파일 추출에 실패했습니다".into());
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn prepare_launch_agent(db: &Database, label: &str) -> Result<PathBuf, String> {
    if let Some(path) = db.plist.as_ref() {
        return Ok(path.clone());
    }
    let path = dirs::home_dir()
        .ok_or("사용자 홈 폴더를 찾을 수 없습니다")?
        .join(format!("Library/LaunchAgents/{label}.plist"));
    if path.exists() {
        return Err("다른 Studio 데이터베이스 서비스가 이미 등록되어 있습니다".into());
    }
    let script_path = db.home.join("bin/run-server.sh");
    let script = format!("#!/bin/sh\nset -a\n. {}\nset +a\nexport BYORIDB__STORAGE__DATA_PATHS={}\nexport BYORIDB__SERVER__HTTP_ADDR=127.0.0.1:{}\nexport BYORIDB__SERVER__GRAPH_ADDR=127.0.0.1:{}\numask 077\nexec {}\n", shell_quote(&db.home.join("env").to_string_lossy()),shell_quote(&db.home.join("data").to_string_lossy()),db.port,db.graph_port,shell_quote(&db.binary().to_string_lossy()));
    private_write(&script_path, script.as_bytes())?;
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(&script_path, std::fs::Permissions::from_mode(0o700))
        .map_err(|e| e.to_string())?;
    let mut values = plist::Dictionary::new();
    values.insert("Label".into(), label.into());
    values.insert(
        "WorkingDirectory".into(),
        db.home.to_string_lossy().into_owned().into(),
    );
    values.insert(
        "ProgramArguments".into(),
        plist::Value::Array(vec![
            "/bin/sh".into(),
            script_path.to_string_lossy().into_owned().into(),
        ]),
    );
    values.insert("RunAtLoad".into(), true.into());
    values.insert("KeepAlive".into(), true.into());
    for key in ["StandardOutPath", "StandardErrorPath"] {
        values.insert(
            key.into(),
            db.home
                .join("server.log")
                .to_string_lossy()
                .into_owned()
                .into(),
        );
    }
    std::fs::create_dir_all(path.parent().unwrap()).map_err(|e| e.to_string())?;
    plist::Value::Dictionary(values)
        .to_file_xml(&path)
        .map_err(|e| e.to_string())?;
    Ok(path)
}
async fn restore_binary(
    db: &Database,
    backup: &Path,
    manifest: Option<&[u8]>,
) -> Result<(), String> {
    if backup.is_file() {
        tokio::fs::copy(backup, db.binary())
            .await
            .map_err(|e| format!("이전 실행 파일 복원 실패: {e}"))?;
    } else if db.binary().exists() {
        tokio::fs::remove_file(db.binary())
            .await
            .map_err(|e| e.to_string())?;
    }
    if let Some(data) = manifest {
        private_write(&db.home.join("engine.json"), data)?;
    } else if db.home.join("engine.json").exists() {
        tokio::fs::remove_file(db.home.join("engine.json"))
            .await
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn runtime_fixture() -> (Runtime, PathBuf) {
        let root = std::env::temp_dir().join(format!("studio-runtime-{}", Uuid::new_v4()));
        let editor = Arc::new(Mutex::new(Editor::new(root.clone()).unwrap()));
        let connection = Connection {
            url: "http://127.0.0.1:1".into(),
            token: "ui".into(),
        };
        (Runtime::new(root.clone(), connection, editor).unwrap(), root)
    }
    #[cfg(unix)]
    fn pid_file() -> PathBuf {
        std::env::temp_dir().join(format!("studio-pid-{}", Uuid::new_v4()))
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn stopping_kills_helpers_that_outlive_the_group_leader() {
        use std::os::unix::process::CommandExt;
        let file = pid_file();
        // The leader dies on TERM at once; its helper ignores TERM.
        let script = format!(
            "(trap '' TERM; echo $$ >/dev/null; sleep 30 </dev/null >/dev/null 2>&1 & echo $! > '{}'; wait) & wait",
            file.display()
        );
        let mut command = Command::new("/bin/sh");
        command.args(["-c", &script]);
        command.as_std_mut().process_group(0);
        let mut child = command.spawn().unwrap();
        for _ in 0..50 {
            if std::fs::read_to_string(&file).is_ok_and(|s| !s.trim().is_empty()) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        let helper = std::fs::read_to_string(&file).unwrap();
        stop_child(&mut child).await;
        std::fs::remove_file(&file).unwrap();
        assert!(exits_soon(helper.trim()).await, "helper survived the stop");
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn exit_sweep_kills_untracked_direct_children() {
        let file = pid_file();
        // Stands in for the app: a parent whose child (an FFmpeg export) is not in a tracked group.
        let script = format!("sleep 30 & echo $! > '{}'; wait", file.display());
        let mut parent = Command::new("/bin/sh");
        parent.args(["-c", &script]).kill_on_drop(true);
        let mut parent = parent.spawn().unwrap();
        for _ in 0..50 {
            if std::fs::read_to_string(&file).is_ok_and(|s| !s.trim().is_empty()) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        let export = std::fs::read_to_string(&file).unwrap();
        kill_children_of(parent.id().unwrap());
        std::fs::remove_file(&file).unwrap();
        assert!(exits_soon(export.trim()).await, "child survived the sweep");
        let _ = parent.kill().await;
    }
    fn shell(script: &str) -> Command {
        let mut command = Command::new("/bin/sh");
        command.args(["-c", script]);
        command
    }
    async fn start_script(runtime: &Runtime, root: &Path, script: &str) -> (String, String, PathBuf) {
        let id = Uuid::new_v4().to_string();
        let work = root.join("agent-workspaces").join(&id);
        std::fs::create_dir_all(&work).unwrap();
        let token = runtime.tokens.issue("project-a");
        private_write(&work.join("connection.json"), token.as_bytes()).unwrap();
        let run = AgentRun {
            id: id.clone(),
            provider: "claude".into(),
            project_id: "project-a".into(),
            token: token.clone(),
            work: work.clone(),
            higgsfield: None,
        };
        runtime
            .run_agent(shell(script), "request".into(), run)
            .await
            .unwrap();
        (id, token, work)
    }
    async fn finished(runtime: &Runtime, id: &str) -> Value {
        for _ in 0..200 {
            let job = runtime.dispatch("agent.status", json!({"id":id})).await.unwrap();
            if !matches!(job["state"].as_str(), Some("running" | "cancelling")) {
                return job;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        panic!("agent job did not finish");
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn cancelled_agent_ends_cancelled_and_loses_its_token_and_workspace() {
        let (runtime, root) = runtime_fixture();
        // The output mentions logging in; a cancelled job must not turn into a sign-in failure.
        let (id, token, work) =
            start_script(&runtime, &root, "echo 'Please log in' >&2; sleep 30").await;
        assert_eq!(runtime.agent_project(&token).as_deref(), Some("project-a"));
        tokio::time::sleep(Duration::from_millis(200)).await;
        let cancelling = runtime.dispatch("agent.cancel", json!({"id":id})).await.unwrap();
        assert_eq!(cancelling["state"], "cancelling");
        let job = finished(&runtime, &id).await;
        assert_eq!(job["state"], "cancelled");
        assert!(job["authRequired"].is_null());
        assert!(job["finishedAt"].is_u64());
        assert!(runtime.agent_project(&token).is_none());
        assert!(!work.exists());
        assert!(runtime.children.0.lock().unwrap().is_empty());
        // Cancelling again is a no-op on a finished job.
        let again = runtime.dispatch("agent.cancel", json!({"id":id})).await.unwrap();
        assert_eq!(again["state"], "cancelled");
        std::fs::remove_dir_all(&root).unwrap();
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn sign_in_is_reported_only_for_a_failed_cli() {
        let (runtime, root) = runtime_fixture();
        let (ok, ..) = start_script(
            &runtime,
            &root,
            r#"echo '{"type":"assistant","text":"자막: Please log in / not logged in"}'; echo 'authentication required' >&2"#,
        )
        .await;
        let job = finished(&runtime, &ok).await;
        assert_eq!(job["state"], "completed");
        assert!(job["authRequired"].is_null() && job["error"].is_null());

        let (failed, ..) = start_script(
            &runtime,
            &root,
            r#"echo '{"type":"result","is_error":true,"result":"Not logged in · Please run /login"}'; exit 1"#,
        )
        .await;
        let job = finished(&runtime, &failed).await;
        assert_eq!(job["state"], "failed");
        assert_eq!(job["authRequired"], true);
        assert!(job["error"].as_str().unwrap().contains("로그인"));

        let (crashed, ..) = start_script(&runtime, &root, "echo '자막에 please log in 문구' ; exit 3").await;
        let job = finished(&runtime, &crashed).await;
        assert_eq!(job["state"], "failed");
        assert!(job["authRequired"].is_null());
        assert!(job["error"].as_str().unwrap().contains("종료 코드"));

        let list = runtime.dispatch("agent.list", json!({})).await.unwrap();
        let list = list.as_array().unwrap();
        assert_eq!(list.len(), 3);
        assert_eq!(list[0]["id"], crashed.as_str(), "newest first");
        assert_eq!(list[2]["id"], ok.as_str());
        for item in list {
            assert_eq!(item["provider"], "claude");
            assert_eq!(item["projectId"], "project-a");
            assert!(item["startedAt"].is_u64() && item["finishedAt"].is_u64());
            assert!(item.get("logs").is_none());
        }
        std::fs::remove_dir_all(&root).unwrap();
    }
    #[test]
    fn auth_hints_ignore_model_output() {
        assert!(auth_hint("stderr", "Error: Not logged in"));
        assert!(auth_hint("stdout", r#"{"type":"error","message":"Authentication required"}"#));
        assert!(!auth_hint("stdout", "Please log in"));
        assert!(!auth_hint("stdout", r#"{"type":"assistant","text":"please log in"}"#));
        assert!(!auth_hint("stderr", "warning: slow network"));
        assert_eq!(agent_result(Exit::Success, true).0, "completed");
        assert_eq!(agent_result(Exit::Cancelled, true), ("cancelled", None, false));
        assert!(!agent_result(Exit::Timeout, true).2);
        assert!(agent_result(Exit::Failed(Some(1)), true).2);
        assert!(!agent_result(Exit::Failed(Some(1)), false).2);
    }
    #[tokio::test]
    async fn agent_start_binds_to_the_open_project_and_selected_clip() {
        let (runtime, root) = runtime_fixture();
        let stale = runtime
            .dispatch("agent.start", json!({"provider":"claude","prompt":"자르기","projectId":"other"}))
            .await
            .unwrap_err();
        assert!(stale.contains("프로젝트가 변경"), "{stale}");
        let missing = runtime
            .dispatch("agent.start", json!({"provider":"claude","prompt":"자르기","clipId":"nope"}))
            .await
            .unwrap_err();
        assert!(missing.contains("클립"), "{missing}");
        assert!(runtime.tokens.0.lock().unwrap().is_empty());

        let project = json!({"name":"데모","revision":4,"clips":[{"id":"c1","trackId":"v1","start":2.5,"duration":4.0}]});
        assert_eq!(clip_context(&project, None).unwrap(), "");
        assert_eq!(clip_context(&project, Some("")).unwrap(), "");
        let selection = clip_context(&project, Some("c1")).unwrap();
        let instructions = agent_instructions(&project, &root.join("exports"), &selection, false, "이 클립 줄여줘");
        assert!(instructions.contains(r#"clip "c1" selected (track "v1", start 2.5s, duration 4.0s)"#), "{instructions}");
        assert!(instructions.contains("(revision 4)"));
        assert!(instructions.ends_with("User request:\n이 클립 줄여줘"));
        std::fs::remove_dir_all(&root).unwrap();
    }
    #[test]
    fn startup_removes_stale_agent_and_install_folders() {
        let (runtime, root) = runtime_fixture();
        drop(runtime);
        for folder in ["agent-workspaces/old", "downloads/old"] {
            std::fs::create_dir_all(root.join(folder)).unwrap();
            std::fs::write(root.join(folder).join("connection.json"), "token").unwrap();
        }
        let editor = Arc::new(Mutex::new(Editor::new(root.clone()).unwrap()));
        let connection = Connection { url: "http://127.0.0.1:1".into(), token: "ui".into() };
        let runtime = Runtime::new(root.clone(), connection, editor).unwrap();
        assert!(!root.join("agent-workspaces").exists());
        assert!(!root.join("downloads").exists());
        assert!(root.join("tools/studio-tools.json").is_file());
        runtime.shutdown();
        std::fs::remove_dir_all(&root).unwrap();
    }
    #[test]
    fn finished_jobs_are_capped_but_running_jobs_stay() {
        let finished: Vec<(String, u64)> = (0..FINISHED_JOB_LIMIT as u64 + 5)
            .map(|at| (format!("job-{at}"), at))
            .collect();
        let mut removed = prune_finished(finished);
        removed.sort();
        assert_eq!(removed, ["job-0", "job-1", "job-2", "job-3", "job-4"]);
        let mut jobs: HashMap<String, Job> = (0..FINISHED_JOB_LIMIT as u64 + 2)
            .map(|at| (format!("done-{at}"), Job { value: json!({"finishedAt":at + 1}), cancel: None, auth_hint: false }))
            .collect();
        jobs.insert("running".into(), Job { value: json!({"state":"running"}), cancel: None, auth_hint: false });
        prune_jobs(&mut jobs);
        assert_eq!(jobs.len(), FINISHED_JOB_LIMIT + 1);
        assert!(jobs.contains_key("running") && !jobs.contains_key("done-0"));
    }
    #[test]
    fn agent_allowlist_matches_the_editor_contract() {
        let methods = agent_methods();
        for method in [
            "project.get", "project.save", "project.notice", "media.relink", "edit.trackDelete",
            "edit.trackMove", "edit.markerUpdate", "edit.markerDelete", "edit.paste", "edit.batch",
            "export.start", "captions.export", "preview.frame", "memory.record", "speech.transcribe",
        ] {
            assert!(methods.contains(method), "{method}");
        }
        for method in [
            "project.delete", "project.open", "project.new", "project.demo", "project.duplicate",
            "project.rename", "agent.start", "agent.list", "runtime.install", "runtime.mcpSave",
        ] {
            assert!(!methods.contains(method), "{method}");
        }
    }
    #[test]
    fn tool_search_covers_finder_launches() {
        let home = std::env::temp_dir().join(format!("studio-home-{}", Uuid::new_v4()));
        for version in ["v18.20.4", "v22.3.0", "v9.11.2", "not-a-version"] {
            std::fs::create_dir_all(home.join(".nvm/versions/node").join(version).join("bin")).unwrap();
        }
        let paths = search_paths_from(Some("/usr/bin:/custom/bin:/usr/bin".into()), &home);
        let position = |path: PathBuf| paths.iter().position(|p| *p == path).unwrap_or_else(|| panic!("{path:?}"));
        assert_eq!(position("/usr/bin".into()), 0, "the user's PATH wins");
        assert_eq!(paths.iter().filter(|p| p.as_os_str() == "/usr/bin").count(), 1);
        for path in ["/custom/bin", "/opt/homebrew/bin", "/usr/local/bin"] {
            position(path.into());
        }
        for path in [".local/bin", ".volta/bin"] {
            position(home.join(path));
        }
        let node = |version: &str| position(home.join(".nvm/versions/node").join(version).join("bin"));
        assert!(node("v22.3.0") < node("v18.20.4") && node("v18.20.4") < node("v9.11.2"));
        assert!(!paths.iter().any(|p| p.to_string_lossy().contains("not-a-version")));
        // A Finder launch has no shell PATH at all.
        assert!(search_paths_from(None, &home).contains(&PathBuf::from("/opt/homebrew/bin")));
        std::fs::remove_dir_all(&home).unwrap();
    }
    #[test]
    fn release_checksums_are_read_strictly() {
        let digest = "a".repeat(64);
        let name = "byoridb-v1.0.0-aarch64-apple-darwin.tar.gz";
        assert_eq!(checksum_from(&format!("{digest}\n"), name), Some(digest.clone()));
        let sums = format!("{}  other.tar.gz\n{}  *{name}\n", "b".repeat(64), digest.to_uppercase());
        assert_eq!(checksum_from(&sums, name), Some(digest.clone()));
        assert_eq!(checksum_from(&format!("{}  other.tar.gz\n", "b".repeat(64)), name), None);
        assert_eq!(checksum_from("not a checksum", name), None);
        assert_eq!(sha256_hex("abc"), None);
    }
    #[tokio::test]
    async fn install_refuses_a_release_without_a_checksum() {
        let name = "byoridb-v1.0.0-aarch64-apple-darwin.tar.gz";
        let asset = json!({"name":name,"browser_download_url":"https://github.com/byoridb/byoridb/releases/download/v1.0.0/x"});
        let release = json!({"assets":[asset.clone()]});
        let error = release_checksum(&release, &asset, name, "v1.0.0").await.unwrap_err();
        assert!(error.contains("체크섬"), "{error}");
        let digest = "c".repeat(64);
        let with_digest = json!({"name":name,"digest":format!("sha256:{digest}")});
        assert_eq!(release_checksum(&release, &with_digest, name, "v1.0.0").await.unwrap(), digest);
        // A checksum file hosted anywhere but the official release is ignored.
        let foreign = json!({"assets":[asset.clone(),{"name":"SHA256SUMS","browser_download_url":"https://example.com/SHA256SUMS"}]});
        assert!(release_checksum(&foreign, &asset, name, "v1.0.0").await.is_err());
    }
    #[test]
    fn gemini_is_limited_to_studio_mcp_tools() {
        let settings = gemini_settings(&json!({"studio":{"command":"python3"}}));
        assert_eq!(settings["mcp"]["allowed"], json!(["studio"]));
        let excluded = settings["tools"]["exclude"].as_array().unwrap();
        for tool in ["run_shell_command", "write_file", "replace", "read_file", "read_many_files", "list_directory", "glob", "grep_search", "web_fetch", "google_web_search", "save_memory"] {
            assert!(excluded.contains(&json!(tool)), "{tool}");
        }
        let work = std::env::temp_dir().join(format!("studio-gemini-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&work).unwrap();
        let command = agent_command("gemini", Path::new("gemini"), Path::new("python3"), Path::new("studio-mcp.py"), &work.join("connection.json"), &work, None).unwrap();
        let args: Vec<String> = command.as_std().get_args().map(|a| a.to_string_lossy().into_owned()).collect();
        let at = |flag: &str| args.iter().position(|a| a == flag).unwrap_or_else(|| panic!("{flag}"));
        assert_eq!(args[at("--extensions") + 1], "none");
        assert_eq!(args[at("--allowed-mcp-server-names") + 1], "studio");
        assert!(!args.iter().any(|a| a == "--approval-mode" || a == "--yolo"));
        let written: Value = serde_json::from_slice(&std::fs::read(work.join(".gemini/settings.json")).unwrap()).unwrap();
        assert_eq!(written["tools"], settings["tools"]);
        assert_eq!(written["mcp"], settings["mcp"]);
        assert_eq!(written["mcpServers"]["studio"]["command"], "python3");
        std::fs::remove_dir_all(&work).unwrap();
    }
    #[test]
    fn semantic_version_ordering() {
        assert!(parse_version("v0.10.0") > parse_version("v0.9.9"));
        assert!(parse_version("v1.2.3/../x").is_none());
        assert!(parse_version("latest").is_none());
    }
    #[test]
    fn query_values_cannot_break_literals() {
        assert_eq!(escape_ngql("a'\\b\n"), "a\\'\\\\b\\n");
        assert_eq!(memory_condition("", ""), "");
        assert_eq!(
            memory_condition("it's", "p1"),
            " WHERE n.studio_note.body CONTAINS 'it\\'s' AND n.studio_note.project_id == 'p1'"
        );
        assert_eq!(
            memory_condition("", "p'1"),
            " WHERE n.studio_note.project_id == 'p\\'1'"
        );
    }
    #[test]
    fn shell_path_quotes_are_preserved() {
        assert_eq!(shell_quote("a'b"), "'a'\\''b'");
    }
    #[tokio::test]
    async fn executable_probe_reports_missing() {
        let v = probe_executable("not-a-studio-program-123", &["--version"]).await;
        assert_eq!(v["available"], false);
        assert!(v["version"].is_null());
    }
    #[tokio::test]
    async fn archive_extracts_only_binary_and_never_symlinks() {
        let root = std::env::temp_dir().join(format!("studio-archive-{}", Uuid::new_v4()));
        let source = root.join("source");
        std::fs::create_dir_all(&source).unwrap();
        std::fs::write(source.join("byoridb-server"), b"synthetic binary").unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(root.join("outside"), source.join("escape")).unwrap();
        let archive = root.join("release.tar.gz");
        let status = Command::new("tar")
            .arg("-czf")
            .arg(&archive)
            .arg("-C")
            .arg(&source)
            .arg(".")
            .status()
            .await
            .unwrap();
        assert!(status.success());
        let output = root.join("output");
        extract_binary(&archive, "./byoridb-server", &output)
            .await
            .unwrap();
        assert_eq!(std::fs::read(output).unwrap(), b"synthetic binary");
        assert!(!root.join("escape").exists());
        assert!(!root.join("outside").exists());
        std::fs::remove_dir_all(root).unwrap();
    }
    #[tokio::test]
    async fn rollback_restores_existing_install_and_removes_failed_fresh_install() {
        let root = std::env::temp_dir().join(format!("studio-rollback-{}", Uuid::new_v4()));
        std::fs::create_dir_all(root.join("bin")).unwrap();
        let db = Database {
            home: root.clone(),
            port: 1,
            graph_port: 2,
            url: "http://127.0.0.1:1".into(),
            label: None,
            plist: None,
            managed: true,
        };
        let backup = root.join("old");
        std::fs::write(&backup, b"old binary").unwrap();
        std::fs::write(db.binary(), b"new binary").unwrap();
        std::fs::write(root.join("engine.json"), b"new manifest").unwrap();
        restore_binary(&db, &backup, Some(b"old manifest"))
            .await
            .unwrap();
        assert_eq!(std::fs::read(db.binary()).unwrap(), b"old binary");
        assert_eq!(
            std::fs::read(root.join("engine.json")).unwrap(),
            b"old manifest"
        );
        std::fs::remove_file(&backup).unwrap();
        restore_binary(&db, &backup, None).await.unwrap();
        assert!(!db.binary().exists());
        assert!(!root.join("engine.json").exists());
        std::fs::remove_dir_all(root).unwrap();
    }
}
