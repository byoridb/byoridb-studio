//! Studio-owned remote MCP connection. The bridge owns OAuth; no tokens enter RPCs,
//! project files, agent arguments, or Studio logs.
use crate::{
    runtime::{find_executable, now_ms, stop_child, ProcessGroups},
    service::private_write,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    path::{Path, PathBuf},
    process::Stdio,
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    },
    time::Duration,
};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::Command,
    sync::{watch, Mutex},
};

pub const HIGGSFIELD_URL: &str = "https://mcp.higgsfield.ai/mcp";
const BRIDGE_PACKAGE: &str = "mcp-remote@0.15.2";
// Headless sessions cannot relay a per-generation quote/approval interaction yet.
// Keep paid and account-mutating tools out of all three CLI adapters.
// The server's tool names have changed between versions, so these are candidates:
// only the ones the connected server actually lists are passed to an agent.
pub const READ_ONLY_TOOLS: &[&str] = &[
    "models_explore",
    "models_list",
    "models_get",
    "models_search",
    "models_recommend",
    "balance",
    "get_preferences",
];

/// The read-only tools the server really offers, in allowlist order.
fn available_tools(listed: &[String]) -> Vec<String> {
    let (found, missing): (Vec<&str>, Vec<&str>) = READ_ONLY_TOOLS
        .iter()
        .partition(|tool| listed.iter().any(|name| name == *tool));
    if !missing.is_empty() {
        tracing::info!(
            "Higgsfield MCP does not offer {}; using {}",
            missing.join(", "),
            if found.is_empty() { "no tools".to_owned() } else { found.join(", ") }
        );
    }
    found.into_iter().map(String::from).collect()
}

#[derive(Clone, Serialize, Deserialize)]
struct Config {
    enabled: bool,
}

struct State {
    config: Option<Config>,
    phase: &'static str,
    tools: usize,
    /// Allowlisted tools found on the server at the last successful check.
    allowed: Vec<String>,
    checked_at: Option<u64>,
    error: Option<String>,
    cancel: Option<watch::Sender<bool>>,
}

pub struct McpConnections {
    root: PathBuf,
    state: Arc<Mutex<State>>,
    active_agents: Arc<AtomicUsize>,
    children: ProcessGroups,
}

struct AgentLease(Arc<AtomicUsize>);
impl Drop for AgentLease {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::SeqCst);
    }
}

#[derive(Clone)]
pub struct Bridge {
    pub command: PathBuf,
    pub args: Vec<String>,
    pub env: serde_json::Map<String, Value>,
    /// The only tools an agent may call through this bridge.
    pub tools: Vec<String>,
    _lease: Option<Arc<AgentLease>>,
}
impl Bridge {
    pub fn server(&self) -> Value {
        json!({"command":self.command,"args":self.args,"env":self.env,"trust":true,"includeTools":self.tools})
    }
    fn process(&self) -> Command {
        let mut command = Command::new(&self.command);
        command.args(&self.args);
        for (key, value) in &self.env {
            command.env(key, value.as_str().unwrap_or(""));
        }
        command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            command.as_std_mut().process_group(0);
        }
        command
    }
}

fn private_dir(path: &Path) -> Result<(), String> {
    std::fs::create_dir_all(path).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700))
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

impl McpConnections {
    pub fn new(root: &Path, children: ProcessGroups) -> Result<Self, String> {
        let root = root.join("mcp/higgsfield");
        let path = root.join("connection.json");
        let config = if path.is_file() {
            Some(
                serde_json::from_slice(&std::fs::read(path).map_err(|e| e.to_string())?)
                    .map_err(|_| "Higgsfield 연결 설정을 읽을 수 없습니다")?,
            )
        } else {
            None
        };
        Ok(Self {
            root,
            children,
            active_agents: Arc::new(AtomicUsize::new(0)),
            state: Arc::new(Mutex::new(State {
                config,
                phase: "unchecked",
                tools: 0,
                allowed: Vec::new(),
                checked_at: None,
                error: None,
                cancel: None,
            })),
        })
    }
    pub async fn dispatch(&self, method: &str, params: Value) -> Result<Value, String> {
        match method {
            "runtime.mcpGet" | "runtime.mcpStatus" => Ok(self.status().await),
            "runtime.mcpSave" => {
                let enabled = params["enabled"]
                    .as_bool()
                    .ok_or("사용 여부를 지정해주세요")?;
                let mut state = self.state.lock().await;
                if state.cancel.is_some() {
                    return Err("진행 중인 연결 확인을 먼저 취소해주세요".into());
                }
                private_dir(&self.root)?;
                let config = Config { enabled };
                private_write(
                    &self.root.join("connection.json"),
                    &serde_json::to_vec(&config).unwrap(),
                )?;
                state.config = Some(config);
                drop(state);
                Ok(self.status().await)
            }
            "runtime.mcpRemove" => {
                let mut state = self.state.lock().await;
                if self.active_agents.load(Ordering::SeqCst) > 0 {
                    return Err("Higgsfield를 사용하는 에이전트 작업을 마치거나 취소한 뒤 연결을 삭제해주세요.".into());
                }
                if state.cancel.is_some() {
                    return Err("진행 중인 연결 확인을 먼저 취소해주세요".into());
                }
                if self.root.is_dir() {
                    std::fs::remove_dir_all(&self.root).map_err(|e| e.to_string())?;
                }
                state.config = None;
                state.phase = "unchecked";
                state.tools = 0;
                state.allowed.clear();
                state.checked_at = None;
                state.error = None;
                drop(state);
                Ok(self.status().await)
            }
            "runtime.mcpConnect" => self.connect().await,
            "runtime.mcpCancel" => {
                let mut state = self.state.lock().await;
                if let Some(cancel) = state.cancel.as_ref() {
                    let _ = cancel.send(true);
                    state.phase = "cancelling";
                }
                drop(state);
                Ok(self.status().await)
            }
            _ => Err("지원하지 않는 MCP 연결 명령입니다".into()),
        }
    }
    pub async fn status(&self) -> Value {
        let state = self.state.lock().await;
        json!({"id":"higgsfield","name":"Higgsfield","url":HIGGSFIELD_URL,"added":state.config.is_some(),"enabled":state.config.as_ref().is_some_and(|c|c.enabled),"phase":state.phase,"toolCount":state.tools,"allowedTools":state.allowed,"checkedAt":state.checked_at,"error":state.error,"bridgeAvailable":find_executable("npx").is_some()&&find_executable("node").is_some(),"bridgePackage":BRIDGE_PACKAGE})
    }
    fn bridge(&self) -> Result<Bridge, String> {
        let npx=find_executable("npx").ok_or("Higgsfield 연결에는 Node.js와 npx가 필요합니다. Node.js를 설치한 뒤 다시 연결해주세요.")?;
        let node = find_executable("node").ok_or("Higgsfield 연결에는 Node.js가 필요합니다")?;
        private_dir(&self.root)?;
        private_dir(&self.root.join("auth"))?;
        private_dir(&self.root.join("npm-cache"))?;
        let mut path = crate::runtime::search_paths();
        if let Some(parent) = node.parent() {
            path.insert(0, parent.to_owned());
        }
        let env=json!({"MCP_REMOTE_CONFIG_DIR":self.root.join("auth"),"npm_config_cache":self.root.join("npm-cache"),"npm_config_ignore_scripts":"true","PATH":std::env::join_paths(path).map_err(|_|"Node.js 경로를 구성할 수 없습니다")?.to_string_lossy()}).as_object().unwrap().clone();
        Ok(Bridge {
            command: npx,
            args: vec![
                "--yes".into(),
                BRIDGE_PACKAGE.into(),
                HIGGSFIELD_URL.into(),
                "--silent".into(),
                "--auth-timeout".into(),
                "180".into(),
            ],
            env,
            tools: Vec::new(),
            _lease: None,
        })
    }
    pub async fn agent_bridge(&self) -> Result<Option<Bridge>, String> {
        let state = self.state.lock().await;
        if !state.config.as_ref().is_some_and(|c| c.enabled) {
            return Ok(None);
        }
        // An optional connection that has not authenticated must not prevent editing.
        // Nor one whose server offers none of the tools Studio allows.
        if state.phase != "connected" || state.allowed.is_empty() {
            return Ok(None);
        }
        let mut bridge = self.bridge()?;
        bridge.tools = state.allowed.clone();
        self.active_agents.fetch_add(1, Ordering::SeqCst);
        bridge._lease = Some(Arc::new(AgentLease(self.active_agents.clone())));
        Ok(Some(bridge))
    }
    async fn connect(&self) -> Result<Value, String> {
        let mut state = self.state.lock().await;
        if state.cancel.is_some() {
            return Err("이미 연결을 확인하고 있습니다".into());
        }
        if state.config.is_none() {
            return Err("먼저 Higgsfield MCP를 추가해주세요".into());
        }
        let bridge = self.bridge()?;
        let (cancel, mut rx) = watch::channel(false);
        state.phase = "connecting";
        state.error = None;
        state.tools = 0;
        state.allowed.clear();
        state.cancel = Some(cancel);
        drop(state);
        let all = self.state.clone();
        let children = self.children.clone();
        tokio::spawn(async move {
            let result = probe(bridge.process(), &mut rx, &children).await;
            let mut state = all.lock().await;
            state.cancel = None;
            state.checked_at = Some(now_ms());
            match result {
                Ok(listed) => {
                    state.phase = "connected";
                    state.tools = listed.len();
                    state.allowed = available_tools(&listed);
                }
                Err(error) if *rx.borrow() => {
                    state.phase = "cancelled";
                    state.error = None;
                    let _ = error;
                }
                Err(error) => {
                    state.phase = "failed";
                    state.error = Some(error);
                }
            }
        });
        Ok(self.status().await)
    }
}

async fn probe(
    mut command: Command,
    cancel: &mut watch::Receiver<bool>,
    children: &ProcessGroups,
) -> Result<Vec<String>, String> {
    let mut child = command
        .spawn()
        .map_err(|_| "연결 프로그램을 실행하지 못했습니다. Node.js 설치 상태를 확인해주세요.")?;
    let pid = child.id();
    children.add(pid); // so quitting the app also stops a probe waiting for sign-in
    let mut input = child.stdin.take().ok_or("연결 입력을 열 수 없습니다")?;
    let output = child.stdout.take().ok_or("연결 출력을 열 수 없습니다")?;
    let mut reader = BufReader::new(output);
    let exchange = async {
        send(&mut input,json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"byori-studio","version":env!("CARGO_PKG_VERSION")}}})).await?;
        let init = receive(&mut reader, 1).await?;
        if !init["capabilities"].is_object() {
            return Err("MCP 초기화 응답을 확인할 수 없습니다".into());
        }
        send(
            &mut input,
            json!({"jsonrpc":"2.0","method":"notifications/initialized"}),
        )
        .await?;
        send(
            &mut input,
            json!({"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}),
        )
        .await?;
        let tools = receive(&mut reader, 2).await?;
        tools["tools"]
            .as_array()
            .map(|tools| {
                tools
                    .iter()
                    .filter_map(|tool| tool["name"].as_str().map(str::to_owned))
                    .collect()
            })
            .ok_or_else(|| "MCP 도구 목록을 확인할 수 없습니다".to_owned())
    };
    let result = tokio::select! {
        value=exchange=>value,
        _=cancel.changed()=>Err("연결 확인을 취소했습니다".into()),
        _=tokio::time::sleep(Duration::from_secs(240))=>Err("연결 시간이 초과되었습니다. 브라우저 로그인을 완료한 뒤 다시 시도해주세요.".into()),
    };
    stop_child(&mut child).await;
    let _ = child.wait().await;
    children.remove(pid);
    result
}
async fn send(writer: &mut tokio::process::ChildStdin, message: Value) -> Result<(), String> {
    writer
        .write_all(format!("{message}\n").as_bytes())
        .await
        .map_err(|_| "MCP 연결이 종료되었습니다".to_owned())
}
async fn receive(
    reader: &mut BufReader<tokio::process::ChildStdout>,
    id: i64,
) -> Result<Value, String> {
    use tokio::io::AsyncReadExt;
    loop {
        let mut bytes = Vec::new();
        let count = reader
            .take(8 * 1024 * 1024 + 1)
            .read_until(b'\n', &mut bytes)
            .await
            .map_err(|_| "MCP 응답을 읽을 수 없습니다")?;
        if count == 0 {
            return Err(
                "연결이 종료되었습니다. Node.js·네트워크·Higgsfield 로그인 상태를 확인해주세요."
                    .into(),
            );
        }
        if count > 8 * 1024 * 1024 {
            return Err("MCP 응답이 너무 큽니다".into());
        }
        let message: Value =
            serde_json::from_slice(&bytes).map_err(|_| "MCP 응답 형식이 올바르지 않습니다")?;
        if message["id"] == id {
            if message.get("error").is_some() {
                return Err(
                    "Higgsfield MCP가 연결 요청을 거절했습니다. 계정과 구독 상태를 확인해주세요."
                        .into(),
                );
            }
            return message
                .get("result")
                .cloned()
                .ok_or_else(|| "MCP 결과가 없습니다".to_owned());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn configuration_is_private_removable_and_disabled_is_not_forwarded() {
        let root = std::env::temp_dir().join(format!("studio-mcp-{}", uuid::Uuid::new_v4()));
        let m = McpConnections::new(&root, ProcessGroups::default()).unwrap();
        assert_eq!(m.status().await["added"], false);
        m.dispatch("runtime.mcpSave", json!({"enabled":true}))
            .await
            .unwrap();
        assert!(m.agent_bridge().await.unwrap().is_none());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(m.root.join("connection.json"))
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o600
            );
        }
        m.dispatch("runtime.mcpSave", json!({"enabled":false}))
            .await
            .unwrap();
        assert!(m.agent_bridge().await.unwrap().is_none());
        let reread = McpConnections::new(&root, ProcessGroups::default()).unwrap();
        assert_eq!(reread.status().await["enabled"], false);
        m.dispatch("runtime.mcpRemove", json!({})).await.unwrap();
        assert!(!m.root.exists());
        std::fs::remove_dir_all(root).unwrap();
    }
    #[tokio::test]
    async fn probe_requires_real_handshake_and_tools_without_exposing_remote_errors() {
        let python = find_executable("python3").unwrap();
        let mut good = Command::new(&python);
        good.args(["-u","-c","import sys,json\nfor line in sys.stdin:\n m=json.loads(line)\n if 'id' in m: print(json.dumps({'jsonrpc':'2.0','id':m['id'],'result':{'capabilities':{'tools':{}}} if m['method']=='initialize' else {'tools':[{'name':'models_explore'},{'name':'generate_image'},{'name':'balance'}]}}),flush=True)"]);
        good.stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        let (_tx, mut rx) = watch::channel(false);
        let listed = probe(good, &mut rx, &ProcessGroups::default()).await.unwrap();
        assert_eq!(listed, ["models_explore", "generate_image", "balance"]);
        // Allowlisted names the server lacks are dropped, and nothing else gets in.
        assert_eq!(available_tools(&listed), ["models_explore", "balance"]);
        assert!(available_tools(&["generate_video".to_owned()]).is_empty());
        let mut bad = Command::new(python);
        bad.args(["-u","-c","print('{\"jsonrpc\":\"2.0\",\"id\":1,\"error\":{\"message\":\"private-token-do-not-leak\"}}')"]);
        bad.stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        let error = probe(bad, &mut rx, &ProcessGroups::default()).await.unwrap_err();
        assert!(!error.contains("private-token"));
    }
    #[tokio::test]
    async fn connection_removal_waits_for_leased_agent_and_filters_paid_tools() {
        let root = std::env::temp_dir().join(format!("studio-mcp-lease-{}", uuid::Uuid::new_v4()));
        let m = McpConnections::new(&root, ProcessGroups::default()).unwrap();
        m.dispatch("runtime.mcpSave", json!({"enabled":true}))
            .await
            .unwrap();
        m.active_agents.fetch_add(1, Ordering::SeqCst);
        let lease = Arc::new(AgentLease(m.active_agents.clone()));
        let bridge = Bridge {
            command: PathBuf::from("npx"),
            args: vec![],
            env: serde_json::Map::new(),
            tools: available_tools(&["models_list".into(), "generate_image".into()]),
            _lease: Some(lease),
        };
        assert!(m.dispatch("runtime.mcpRemove", json!({})).await.is_err());
        let allowed = bridge.server()["includeTools"].clone();
        assert_eq!(allowed, json!(["models_list"]));
        assert!(!allowed
            .as_array()
            .unwrap()
            .contains(&json!("generate_image")));
        assert!(!allowed
            .as_array()
            .unwrap()
            .contains(&json!("generate_audio")));
        drop(bridge);
        m.dispatch("runtime.mcpRemove", json!({})).await.unwrap();
        std::fs::remove_dir_all(root).unwrap();
    }
}
