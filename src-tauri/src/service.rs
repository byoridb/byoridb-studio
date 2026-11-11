use crate::{
    editor::Editor,
    media,
    preview::PreviewFrames,
    runtime::{agent_methods, Runtime},
};
use axum::{
    body::Body,
    extract::{DefaultBodyLimit, Path, Query, State},
    http::{HeaderMap, Method, Request, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    path::{Path as FsPath, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::Duration,
};
use tokio::{
    io::AsyncWriteExt,
    sync::{Mutex, Notify},
    task::JoinHandle,
};
use tower::ServiceExt;
use tower_http::{
    cors::{AllowOrigin, CorsLayer},
    services::ServeFile,
};
use uuid::Uuid;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Connection {
    pub url: String,
    pub token: String,
}

/// Who owns the service process: the desktop app, or the standalone service
/// that backs the browser UI during development.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Host {
    App,
    Service,
}
impl Host {
    fn name(self) -> &'static str {
        match self {
            Host::App => "app",
            Host::Service => "service",
        }
    }
}

#[derive(Clone)]
struct ServiceState {
    editor: Arc<Mutex<Editor>>,
    previews: Arc<PreviewFrames>,
    runtime: Arc<Runtime>,
    connection: Connection,
    root: PathBuf,
    origins: Arc<Vec<String>>,
    /// Wakes the background media worker after something may have been imported.
    media_work: Arc<Notify>,
}

pub struct StudioService {
    pub connection: Connection,
    root: PathBuf,
    runtime: Option<Arc<Runtime>>,
    task: Option<JoinHandle<()>>,
    media_worker: Option<JoinHandle<()>>,
    media_cancel: Arc<AtomicBool>,
}
impl StudioService {
    /// Stops child processes and revokes access. Safe to call more than once;
    /// does nothing when this instance only attached to an existing service.
    pub fn shutdown(&self) {
        let Some(runtime) = self.runtime.as_ref() else {
            return;
        };
        // Stops a proxy transcode in progress; its unfinished file is removed.
        self.media_cancel.store(true, Ordering::Relaxed);
        if let Some(worker) = self.media_worker.as_ref() {
            worker.abort();
        }
        runtime.shutdown();
        let file = self.root.join("connection.json");
        let ours = std::fs::read(&file)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Connection>(&bytes).ok())
            .is_some_and(|saved| saved.token == self.connection.token);
        if ours {
            let _ = std::fs::remove_file(file);
        }
    }
}
impl Drop for StudioService {
    fn drop(&mut self) {
        self.shutdown();
        if let Some(task) = self.task.take() {
            task.abort();
        }
    }
}

/// Origins a browser may call from: the packaged webview, plus the Vite dev
/// server (BYORI_STUDIO_DEV_PORT, default 1420) outside release app builds.
fn allowed_origins(host: Host) -> Vec<String> {
    let mut origins: Vec<String> = [
        "tauri://localhost",
        "http://tauri.localhost",
        "https://tauri.localhost",
    ]
    .map(String::from)
    .to_vec();
    if host == Host::Service || cfg!(debug_assertions) {
        origins.extend(dev_origins());
    }
    origins
}
fn dev_origins() -> [String; 2] {
    let port = std::env::var("BYORI_STUDIO_DEV_PORT")
        .ok()
        .and_then(|v| v.parse::<u16>().ok())
        .unwrap_or(1420);
    [
        format!("http://localhost:{port}"),
        format!("http://127.0.0.1:{port}"),
    ]
}

/// Attaches to a service that already owns the port, but only a Byori Studio
/// service of this exact version whose saved connection still works.
async fn existing_service(root: &std::path::Path, port: u16, host: Host) -> Result<Connection, String> {
    let url = format!("http://127.0.0.1:{port}");
    let client = reqwest::Client::new();
    let health: Option<Value> = match client
        .get(format!("{url}/health"))
        .timeout(std::time::Duration::from_secs(2))
        .send()
        .await
    {
        Ok(response) => response.json().await.ok(),
        Err(_) => None,
    };
    let health = health
        .filter(|h| h["service"] == "byori-studio")
        .ok_or_else(|| format!("포트 {port}을(를) 다른 프로그램이 사용하고 있어 Byori Studio 편집 서비스를 시작할 수 없습니다. 해당 프로그램을 종료한 뒤 다시 실행해주세요."))?;
    let version = health["version"].as_str().unwrap_or("알 수 없음");
    if version != env!("CARGO_PKG_VERSION") {
        return Err(format!("다른 버전({version})의 Byori Studio 편집 서비스가 이미 실행 중입니다. 실행 중인 Byori Studio를 종료한 뒤 다시 실행해주세요."));
    }
    if health["host"] == "app" {
        return Err(match host {
            Host::App => "Byori Studio가 이미 실행 중입니다. 열려 있는 창을 사용해주세요.",
            // The app's service has no /session route, so a browser could not connect.
            Host::Service => "Byori Studio 데스크톱 앱이 실행 중이라 브라우저 개발 서비스를 시작할 수 없습니다. 앱을 종료한 뒤 다시 실행해주세요.",
        }
        .into());
    }
    let connection = std::fs::read(root.join("connection.json"))
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Connection>(&bytes).ok())
        .filter(|connection| connection.url == url);
    if let Some(connection) = connection {
        let response = client
            .post(format!("{url}/rpc"))
            .bearer_auth(&connection.token)
            .timeout(std::time::Duration::from_secs(2))
            .json(&json!({"method":"history.status","params":{}}))
            .send()
            .await;
        if response.is_ok_and(|r| r.status().is_success()) {
            return Ok(connection);
        }
    }
    Err(format!("포트 {port}에서 실행 중인 Byori Studio 편집 서비스에 연결할 수 없습니다. 실행 중인 Byori Studio를 종료한 뒤 다시 실행해주세요."))
}

pub fn data_root() -> PathBuf {
    std::env::var_os("BYORI_STUDIO_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            dirs::home_dir()
                .unwrap_or_else(|| PathBuf::from("."))
                .join(".byori-studio")
        })
}

pub fn private_write(path: &std::path::Path, content: &[u8]) -> Result<(), String> {
    use std::io::Write;
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(path).map_err(|e| e.to_string())?;
    file.write_all(content).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        file.set_permissions(std::fs::Permissions::from_mode(0o600))
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

impl StudioService {
    pub async fn start(root: Option<PathBuf>, host: Host) -> Result<Self, String> {
        let port = std::env::var("BYORI_STUDIO_PORT")
            .ok()
            .and_then(|v| v.parse::<u16>().ok())
            .unwrap_or(43123);
        Self::start_on(root.unwrap_or_else(data_root), host, port).await
    }
    async fn start_on(root: PathBuf, host: Host, port: u16) -> Result<Self, String> {
        std::fs::create_dir_all(&root).map_err(|e| e.to_string())?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&root, std::fs::Permissions::from_mode(0o700))
                .map_err(|e| e.to_string())?;
        }
        let listener =
            match tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, port)).await {
                Ok(listener) => listener,
                Err(_) => {
                    return Ok(Self {
                        connection: existing_service(&root, port, host).await?,
                        root,
                        runtime: None,
                        task: None,
                        media_worker: None,
                        media_cancel: Arc::default(),
                    })
                }
            };
        let port = listener.local_addr().map_err(|e| e.to_string())?.port();
        let connection = Connection {
            url: format!("http://127.0.0.1:{port}"),
            token: format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple()),
        };
        let editor = Arc::new(Mutex::new(Editor::new(root.clone())?));
        let runtime = Arc::new(Runtime::new(
            root.clone(),
            connection.clone(),
            editor.clone(),
        )?);
        let origins = allowed_origins(host);
        // Before anything can upload or import: no request is running yet.
        let root_for_cleanup = root.clone();
        let _ = tokio::task::spawn_blocking(move || remove_orphaned_media_files(&root_for_cleanup)).await;
        let media_work = Arc::new(Notify::new());
        let media_cancel = Arc::new(AtomicBool::new(false));
        let media_worker = tokio::spawn(media_worker(
            editor.clone(),
            root.clone(),
            media_work.clone(),
            media_cancel.clone(),
        ));
        let state = ServiceState {
            previews: Arc::new(PreviewFrames::default()),
            editor,
            runtime: runtime.clone(),
            connection: connection.clone(),
            root: root.clone(),
            origins: Arc::new(origins.clone()),
            media_work,
        };
        let cors = CorsLayer::new()
            .allow_origin(AllowOrigin::list(
                origins.iter().map(|x| x.parse().unwrap()),
            ))
            .allow_methods([Method::GET, Method::POST, Method::OPTIONS])
            .allow_headers([
                axum::http::header::AUTHORIZATION,
                axum::http::header::CONTENT_TYPE,
                axum::http::header::RANGE,
            ])
            .expose_headers([
                axum::http::header::CONTENT_RANGE,
                axum::http::header::ACCEPT_RANGES,
            ]);
        let mut app = Router::new().route(
            "/health",
            get(move || async move {
                Json(json!({"service":"byori-studio","version":env!("CARGO_PKG_VERSION"),"host":host.name()}))
            }),
        );
        // Only the browser UI needs to fetch its token; the desktop app passes it
        // to its own window directly.
        if host == Host::Service {
            app = app.route("/session", get(session));
        }
        let app = app
            .route("/rpc", post(rpc))
            .route("/upload", post(upload))
            .route("/assets/{id}", get(asset))
            .route("/assets/{id}/thumbnail", get(thumbnail))
            .route("/assets/{id}/proxy", get(proxy))
            .layer(DefaultBodyLimit::disable())
            .layer(cors)
            .with_state(state);
        private_write(
            &root.join("connection.json"),
            &serde_json::to_vec(&connection).map_err(|e| e.to_string())?,
        )?;
        let task = tokio::spawn(async move {
            if let Err(error) = axum::serve(listener, app).await {
                tracing::error!("Studio service: {error}");
            }
        });
        Ok(Self {
            connection,
            root,
            runtime: Some(runtime),
            task: Some(task),
            media_worker: Some(media_worker),
            media_cancel,
        })
    }
}

/// Background media work that follows an import, so importing itself stays quick:
/// waveforms first, then one proxy at a time. Nothing here changes a revision or
/// touches the user's files. It ends when the service drops the task.
async fn media_worker(
    editor: Arc<Mutex<Editor>>,
    root: PathBuf,
    wake: Arc<Notify>,
    cancel: Arc<AtomicBool>,
) {
    // Work that failed or was refused is not retried until the next start.
    let mut attempted = HashSet::new();
    loop {
        if !media_work_step(&editor, &root, &cancel, &mut attempted).await {
            // Imports made by speech jobs and agents arrive without a wake-up.
            tokio::select! {
                _ = wake.notified() => {}
                _ = tokio::time::sleep(Duration::from_secs(5)) => {}
            }
        }
    }
}
/// Does the next piece of pending work; false when there is none.
async fn media_work_step(
    editor: &Arc<Mutex<Editor>>,
    root: &FsPath,
    cancel: &Arc<AtomicBool>,
    attempted: &mut HashSet<String>,
) -> bool {
    let decode = |path: PathBuf, duration: f64| async move { media::waveform(&path, duration).await };
    if waveform_work(editor, attempted, decode).await {
        return true; // look for newly imported media before starting a long proxy
    }
    let next = {
        let mut editor = editor.lock().await;
        let Ok(project) = editor.dispatch("project.get", json!({})).await else {
            return false;
        };
        let mut next = None;
        for item in project["media"].as_array().into_iter().flatten() {
            let (Some(id), Some(source)) = (item["id"].as_str(), item["path"].as_str()) else {
                continue;
            };
            let Some(output) = editor.proxy_path(id) else {
                continue;
            };
            if output.is_file() {
                if proxy_is_of(&output, source) {
                    continue;
                }
                // Relinked (or undone) since: the proxy shows another file.
                let _ = std::fs::remove_file(&output);
            }
            let key = format!("proxy:{id}:{source}");
            if next.is_none()
                && item["missing"] != true
                && media::needs_proxy(item)
                && !attempted.contains(&key)
            {
                next = Some((key, item.clone(), output));
            }
        }
        next
    };
    let Some((key, item, output)) = next else {
        return false;
    };
    attempted.insert(key.clone());
    // Noted first, so a proxy never exists without saying what it was made from. If
    // the media is relinked meanwhile, the next pass sees the mismatch and rebuilds.
    let noted = std::fs::create_dir_all(root.join("proxies")).and_then(|_| {
        std::fs::write(proxy_source_note(&output), item["path"].as_str().unwrap_or(""))
    });
    let built = match noted {
        Ok(()) => media::build_proxy(root, &item, cancel.clone()).await.map(|_| ()),
        Err(error) => Err(error.to_string()),
    };
    match built {
        Ok(()) => {
            attempted.remove(&key);
        }
        Err(error) => {
            let _ = std::fs::remove_file(proxy_source_note(&output));
            tracing::warn!("{key}: {error}");
        }
    }
    true
}
/// Computes the waveforms that are still missing; false when there were none to try.
async fn waveform_work<F>(
    editor: &Arc<Mutex<Editor>>,
    attempted: &mut HashSet<String>,
    decode: impl Fn(PathBuf, f64) -> F,
) -> bool
where
    F: std::future::Future<Output = Option<Vec<f32>>>,
{
    let waveforms = editor.lock().await.pending_waveforms();
    let mut worked = false;
    for (id, path, duration) in waveforms {
        let key = format!("waveform:{id}:{}", path.display());
        if !attempted.insert(key.clone()) {
            continue;
        }
        worked = true;
        // An empty waveform records that this file has no readable audio.
        let peaks = decode(path.clone(), duration).await;
        match editor.lock().await.set_waveform(&id, &path, peaks) {
            // Recorded (an empty one too), so it is pending again only after a reprobe
            // or relink. Or the media went away meanwhile (undo, another project) and
            // nothing was recorded. Either way, compute it when it is pending again.
            Ok(_) => {
                attempted.remove(&key);
            }
            // Not retried: a save that keeps failing would decode in a loop.
            Err(error) => tracing::warn!("waveform for {id}: {error}"),
        }
    }
    worked
}
/// Next to each proxy, the source file it was made from.
fn proxy_source_note(output: &FsPath) -> PathBuf {
    output.with_extension("source")
}
fn proxy_is_of(output: &FsPath, source: &str) -> bool {
    std::fs::read_to_string(proxy_source_note(output)).is_ok_and(|noted| noted == source)
}
/// Removes proxies in `proxies/` that no project mentions any more. Runs once at
/// startup, when the saved projects are the only references (there is no undo
/// history yet). A proxy is kept when its media id appears anywhere in a project
/// file, including an unreadable autosave that was set aside.
///
/// Only proxies, because they can be rebuilt. Uploads in `imports/` and results
/// in `speech/` are the only copy of that media, and a project file saved outside
/// this folder may still point at them, so they are never deleted automatically.
fn remove_orphaned_media_files(root: &FsPath) {
    let mut references = String::new();
    let mut files = vec![root.join("current.json")];
    let listed = |folder: PathBuf| -> Vec<PathBuf> {
        std::fs::read_dir(folder)
            .into_iter()
            .flatten()
            .flatten()
            .map(|entry| entry.path())
            .collect()
    };
    files.extend(listed(root.join("projects")));
    files.extend(listed(root.to_owned()).into_iter().filter(|path| {
        path.file_name()
            .is_some_and(|name| name.to_string_lossy().starts_with("current.json.corrupt-"))
    }));
    for file in files.iter().filter(|file| file.is_file()) {
        match std::fs::read(file) {
            Ok(bytes) => references.push_str(&String::from_utf8_lossy(&bytes)),
            // Without every project the references are incomplete: delete nothing.
            Err(_) => return,
        }
    }
    for path in listed(root.join("proxies")) {
        // "<media id>.mp4", its ".source" note, or an unfinished ".partial.mp4".
        let name = path.file_name().unwrap_or_default().to_string_lossy().into_owned();
        let orphan = name.ends_with(".partial.mp4")
            || match name.rsplit_once('.') {
                Some((id, "mp4" | "source")) => !references.contains(&format!("\"{id}\"")),
                _ => false,
            };
        if orphan {
            let _ = std::fs::remove_file(&path);
        }
    }
}

fn permitted_origin(headers: &HeaderMap, origins: &[String]) -> bool {
    headers
        .get("origin")
        .map(|v| origins.iter().any(|origin| v.to_str().is_ok_and(|v| v == origin)))
        .unwrap_or(true)
}
fn bearer(headers: &HeaderMap) -> Option<&str> {
    headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
}
/// The UI token: full access.
fn authenticated(headers: &HeaderMap, state: &ServiceState) -> bool {
    permitted_origin(headers, &state.origins) && bearer(headers) == Some(&state.connection.token)
}
enum Caller {
    Ui,
    /// A CLI agent job, bound to the project it was started for.
    Agent(String),
}
fn caller(headers: &HeaderMap, state: &ServiceState) -> Option<Caller> {
    if authenticated(headers, state) {
        return Some(Caller::Ui);
    }
    if !permitted_origin(headers, &state.origins) {
        return None;
    }
    state
        .runtime
        .agent_project(bearer(headers)?)
        .map(Caller::Agent)
}
fn denied() -> Response {
    (
        StatusCode::UNAUTHORIZED,
        Json(json!({"error":"Studio 연결 인증이 필요합니다"})),
    )
        .into_response()
}

/// Commands that write a file at a caller-chosen path.
const FILE_WRITE_METHODS: [&str; 4] = [
    "export.start",
    "project.save",
    "captions.export",
    "presets.export",
];
/// What an agent token may do: only the MCP allowlist, and file output only as
/// a new file in Studio's exports folder or the user's usual document folders.
fn agent_request(method: &str, params: &mut Value, root: &std::path::Path) -> Result<(), String> {
    let allowed = agent_methods();
    if !allowed.contains(method) {
        return Err(format!("에이전트에게 허용되지 않은 명령입니다: {method}"));
    }
    if method == "edit.batch" {
        for command in params["commands"].as_array().into_iter().flatten() {
            let inner = command["method"].as_str().unwrap_or("");
            if !allowed.contains(inner) || FILE_WRITE_METHODS.contains(&inner) {
                return Err(format!("에이전트에게 허용되지 않은 명령입니다: {inner}"));
            }
        }
    }
    // An explicit path would become the project's own save location, silently
    // redirecting the user's later saves; agents only save where it already lives.
    if method == "project.save" && !params["path"].is_null() {
        return Err("에이전트는 프로젝트를 다른 경로로 저장할 수 없습니다. path 없이 project.save를 호출해주세요".into());
    }
    if FILE_WRITE_METHODS.contains(&method) {
        match params["path"].as_str().map(PathBuf::from) {
            Some(path) => {
                agent_output_path(&path, root)?;
                params["overwrite"] = json!(false);
            }
            None => {
                if let Some(params) = params.as_object_mut() {
                    params.remove("overwrite");
                }
            }
        }
    }
    Ok(())
}
fn agent_output_path(path: &std::path::Path, root: &std::path::Path) -> Result<(), String> {
    use std::path::Component;
    let refused = || "에이전트는 Studio 내보내기 폴더와 사용자의 동영상·문서·데스크탑·다운로드·음악 폴더에만 새 파일을 만들 수 있습니다".to_owned();
    if !path.is_absolute() || path.components().any(|c| matches!(c, Component::ParentDir)) {
        return Err(refused());
    }
    // Resolve links in the part of the path that already exists, so a link
    // inside an allowed folder cannot point the output somewhere else.
    let real = |path: &std::path::Path| {
        let mut existing = path;
        let mut rest = Vec::new();
        loop {
            if let Ok(resolved) = existing.canonicalize() {
                return rest.iter().rev().fold(resolved, |p, part| p.join(part));
            }
            match (existing.parent(), existing.file_name()) {
                (Some(parent), Some(name)) => {
                    rest.push(name.to_owned());
                    existing = parent;
                }
                _ => return path.to_owned(),
            }
        }
    };
    let home = dirs::home_dir();
    let folders = ["Movies", "Videos", "Documents", "Desktop", "Downloads", "Music"];
    let target = real(path);
    let inside = std::iter::once(root.join("exports"))
        .chain(home.iter().flat_map(|home| folders.iter().map(|f| home.join(f))))
        .any(|folder| {
            let folder = real(&folder);
            target.starts_with(&folder) && target != folder
        });
    if inside {
        Ok(())
    } else {
        Err(refused())
    }
}

async fn session(State(state): State<ServiceState>, headers: HeaderMap) -> Response {
    let dev = dev_origins();
    if !headers
        .get("origin")
        .is_some_and(|v| dev.iter().any(|origin| v.to_str().is_ok_and(|v| v == origin)))
    {
        return denied();
    }
    Json(state.connection).into_response()
}

#[derive(Deserialize)]
struct RpcRequest {
    method: String,
    #[serde(default)]
    params: Value,
    #[serde(default, rename = "projectId")]
    project_id: Option<String>,
}
async fn rpc(State(state): State<ServiceState>, headers: HeaderMap, body: Body) -> Response {
    let Some(caller) = caller(&headers, &state) else {
        return denied();
    };
    let bytes = match axum::body::to_bytes(body, 2 * 1024 * 1024).await {
        Ok(b) => b,
        Err(_) => {
            return (
                StatusCode::PAYLOAD_TOO_LARGE,
                Json(json!({"error":"요청이 너무 큽니다"})),
            )
                .into_response()
        }
    };
    let mut request: RpcRequest = match serde_json::from_slice(&bytes) {
        Ok(r) => r,
        Err(e) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({"error":e.to_string()})),
            )
                .into_response()
        }
    };
    if request.params.is_null() {
        request.params = json!({});
    }
    if !request.params.is_object() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"error":"params는 객체여야 합니다"})),
        )
            .into_response();
    }
    let agent = matches!(caller, Caller::Agent(_));
    if let Caller::Agent(project) = caller {
        if let Err(error) = agent_request(&request.method, &mut request.params, &state.root) {
            return (StatusCode::FORBIDDEN, Json(json!({"error":error}))).into_response();
        }
        request.project_id = Some(project);
        // Each agent job is its own preview client: it replaces only its own
        // earlier frame request, never the player's or the export dialog's.
        if request.method == "preview.frame" {
            request.params["client"] = json!(preview_client(bearer(&headers).unwrap_or("")));
        }
    }
    tracing::debug!("rpc {}", request.method);
    let result = if request.method == "preview.frame" {
        state
            .previews
            .frame(&state.editor, request.params, request.project_id.as_deref(), agent)
            .await
    } else if request.method.starts_with("runtime.")
        || request.method.starts_with("agent.")
        || request.method.starts_with("memory.")
        || request.method.starts_with("speech.")
    {
        if let Some(id) = request.project_id.as_ref() {
            if request.params.is_null() {
                request.params = json!({});
            }
            request.params["_projectId"] = json!(id);
        }
        state
            .runtime
            .dispatch(&request.method, request.params)
            .await
    } else {
        let mut editor = state.editor.lock().await;
        if let Some(id) = request.project_id.as_ref() {
            match editor.dispatch("project.get", json!({})).await {
                Ok(project) if project["id"].as_str() == Some(id.as_str()) => {},
                _ => return (StatusCode::CONFLICT, Json(json!({"error":"에이전트 작업 중 프로젝트가 변경되었습니다. 새 작업을 시작해주세요."}))).into_response(),
            }
        }
        editor.dispatch(&request.method, request.params).await
    };
    if result.is_ok() && brings_media(&request.method) {
        state.media_work.notify_one();
    }
    match result {
        Ok(value) => Json(json!({"result":value})).into_response(),
        Err(error) => (StatusCode::BAD_REQUEST, Json(json!({"error":error}))).into_response(),
    }
}

/// Commands after which the open project may hold media that still needs a
/// waveform or a proxy.
fn brings_media(method: &str) -> bool {
    method.starts_with("media.")
        || method.starts_with("history.")
        || matches!(
            method,
            "edit.batch" | "edit.freeze" | "project.open" | "project.demo"
        )
}
/// A preview client name for an agent token that does not reveal the token.
fn preview_client(token: &str) -> String {
    use sha2::{Digest, Sha256};
    let digest = Sha256::digest(token.as_bytes());
    format!("agent-{}", digest.iter().take(8).map(|b| format!("{b:02x}")).collect::<String>())
}

fn clean_filename(name: &str) -> String {
    let name = name.rsplit(['/', '\\']).next().unwrap_or("media");
    let cleaned: String = name
        .chars()
        .filter(|c| !c.is_control() && *c != ':')
        .take(180)
        .collect();
    if cleaned.is_empty() || cleaned == "." || cleaned == ".." {
        "media".to_owned()
    } else {
        cleaned
    }
}
async fn upload(
    State(state): State<ServiceState>,
    headers: HeaderMap,
    Query(query): Query<HashMap<String, String>>,
    body: Body,
) -> Response {
    if !authenticated(&headers, &state) {
        return denied();
    }
    let Some(project_id) = query.get("projectId").filter(|id| !id.is_empty()) else {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"error":"업로드할 프로젝트 ID가 필요합니다"})),
        )
            .into_response();
    };
    // Do not hold the editor lock while receiving a potentially large upload.
    let original = match state
        .editor
        .lock()
        .await
        .dispatch("project.get", json!({}))
        .await
    {
        Ok(project) if project["id"].as_str() == Some(project_id) => project,
        _ => {
            return (
                StatusCode::CONFLICT,
                Json(json!({"error":"프로젝트가 변경되어 파일을 가져오지 않았습니다"})),
            )
                .into_response()
        }
    };
    let directory = state.root.join("imports");
    if let Err(e) = tokio::fs::create_dir_all(&directory).await {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({"error":e.to_string()})),
        )
            .into_response();
    }
    let name = clean_filename(query.get("name").map(String::as_str).unwrap_or("media"));
    let path = directory.join(format!("{}-{name}", Uuid::new_v4()));
    let result: Result<Value, (StatusCode, String)> = async {
        let mut file = tokio::fs::File::create(&path).await.map_err(upload_error)?;
        let mut stream = body.into_data_stream();
        let mut count = 0usize;
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(upload_error)?;
            count += chunk.len();
            if count > 2 * 1024 * 1024 * 1024usize {
                return Err((StatusCode::PAYLOAD_TOO_LARGE,"한 파일은 최대 2 GB까지 가져올 수 있습니다".into()));
            }
            file.write_all(&chunk).await.map_err(upload_error)?;
        }
        file.flush().await.map_err(upload_error)?;
        drop(file);
        let mut editor = state.editor.lock().await;
        let current = editor.dispatch("project.get", json!({})).await.map_err(upload_error)?;
        if current["id"] != original["id"] || current["revision"] != original["revision"] {
            return Err((StatusCode::CONFLICT,"파일 업로드 중 프로젝트가 변경되어 가져오지 않았습니다. 현재 프로젝트에서 다시 시도해주세요.".into()));
        }
        if name.to_ascii_lowercase().ends_with(".srt") {
            editor.dispatch("captions.import", json!({"path":path,"expectedRevision":original["revision"]})).await.map_err(upload_error)
        } else {
            editor.dispatch("media.import", json!({"paths":[path],"expectedRevision":original["revision"]})).await.map_err(upload_error)
        }
    }.await;
    match result {
        Ok(value) => {
            state.media_work.notify_one();
            Json(json!({"result":value})).into_response()
        }
        Err((status, error)) => {
            let _ = tokio::fs::remove_file(path).await;
            (status, Json(json!({"error":error}))).into_response()
        }
    }
}
fn upload_error(error: impl std::fmt::Display) -> (StatusCode, String) {
    (StatusCode::BAD_REQUEST, error.to_string())
}

async fn asset(
    State(state): State<ServiceState>,
    Path(id): Path<String>,
    Query(query): Query<HashMap<String, String>>,
    request: Request<Body>,
) -> Response {
    serve_asset(state, id, query, request, Asset::Source).await
}
async fn thumbnail(
    State(state): State<ServiceState>,
    Path(id): Path<String>,
    Query(query): Query<HashMap<String, String>>,
    request: Request<Body>,
) -> Response {
    serve_asset(state, id, query, request, Asset::Thumbnail).await
}
/// The lighter copy used for fast playback. 404 until it has been made.
async fn proxy(
    State(state): State<ServiceState>,
    Path(id): Path<String>,
    Query(query): Query<HashMap<String, String>>,
    request: Request<Body>,
) -> Response {
    serve_asset(state, id, query, request, Asset::Proxy).await
}
#[derive(Clone, Copy, PartialEq)]
enum Asset {
    Source,
    Thumbnail,
    Proxy,
}
async fn serve_asset(
    state: ServiceState,
    id: String,
    query: HashMap<String, String>,
    request: Request<Body>,
    kind: Asset,
) -> Response {
    if !permitted_origin(request.headers(), &state.origins)
        || !(query.get("token") == Some(&state.connection.token)
            || authenticated(request.headers(), &state))
    {
        return denied();
    }
    tracing::debug!("asset {id}");
    let path = {
        let editor = state.editor.lock().await;
        match kind {
            Asset::Proxy => editor.proxy_path(&id).filter(|path| path.is_file()),
            _ => editor.asset_path(&id, kind == Asset::Thumbnail),
        }
    };
    match path {
        Some(path) => match ServeFile::new(path).oneshot(request).await {
            Ok(r) => r.into_response(),
            Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
        },
        None => StatusCode::NOT_FOUND.into_response(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn origins_and_tokens_are_both_checked() {
        let state = upload_fixture();
        let mut h = upload_headers();
        assert!(authenticated(&h, &state));
        h.insert("origin", "https://example.com".parse().unwrap());
        assert!(!authenticated(&h, &state));
        h.insert("origin", dev_origins()[0].parse().unwrap());
        assert!(authenticated(&h, &state));
        h.insert("authorization", "Bearer other".parse().unwrap());
        assert!(!authenticated(&h, &state));
        std::fs::remove_dir_all(&state.root).unwrap();
    }
    #[test]
    fn release_app_origins_exclude_the_dev_server() {
        let app = allowed_origins(Host::App);
        assert!(app.contains(&"tauri://localhost".to_owned()));
        assert_eq!(
            app.contains(&dev_origins()[0]),
            cfg!(debug_assertions),
            "the Vite origin is only for development builds"
        );
        assert!(allowed_origins(Host::Service).contains(&dev_origins()[1]));
    }
    async fn call(state: &ServiceState, token: &str, request: Value) -> (StatusCode, Value) {
        let mut headers = HeaderMap::new();
        headers.insert("authorization", format!("Bearer {token}").parse().unwrap());
        let response = rpc(
            State(state.clone()),
            headers,
            Body::from(serde_json::to_vec(&request).unwrap()),
        )
        .await;
        let status = response.status();
        let bytes = axum::body::to_bytes(response.into_body(), 64 * 1024 * 1024)
            .await
            .unwrap();
        (status, serde_json::from_slice(&bytes).unwrap_or(Value::Null))
    }
    #[tokio::test]
    async fn agent_tokens_are_limited_to_the_allowlist_and_their_project() {
        let state = upload_fixture();
        let (_, project) = call(&state, "test", json!({"method":"project.get"})).await;
        let project_id = project["result"]["id"].as_str().unwrap().to_owned();
        let token = state.runtime.issue_agent_token(&project_id);

        let (status, body) = call(&state, &token, json!({"method":"project.get"})).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["result"]["id"], project_id.as_str());
        for method in [
            "runtime.status",
            "runtime.install",
            "agent.start",
            "agent.list",
            "project.delete",
            "project.open",
            "project.new",
        ] {
            let (status, _) = call(&state, &token, json!({"method":method,"params":{}})).await;
            assert_eq!(status, StatusCode::FORBIDDEN, "{method}");
        }
        let (status, _) = call(&state, &token, json!({"method":"edit.batch","params":{"commands":[{"method":"project.new","params":{}}]}})).await;
        assert_eq!(status, StatusCode::FORBIDDEN);
        let (status, _) = call(&state, &token, json!({"method":"export.start","params":{"path":"/etc/studio.mp4","overwrite":true}})).await;
        assert_eq!(status, StatusCode::FORBIDDEN);
        // Upload and the UI token itself stay out of reach.
        let mut headers = HeaderMap::new();
        headers.insert("authorization", format!("Bearer {token}").parse().unwrap());
        assert!(!authenticated(&headers, &state));

        // The UI switches projects: the agent cannot follow, whatever it claims.
        let (_, next) = call(&state, "test", json!({"method":"project.new","params":{"name":"다른 프로젝트"}})).await;
        let (status, _) = call(&state, &token, json!({"method":"project.get","projectId":next["result"]["id"]})).await;
        assert_eq!(status, StatusCode::CONFLICT);

        state.runtime.revoke_agent_token(&token);
        let (status, _) = call(&state, &token, json!({"method":"project.get"})).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
        std::fs::remove_dir_all(&state.root).unwrap();
    }
    #[test]
    fn agent_output_is_new_files_in_known_folders_only() {
        let root = std::env::temp_dir().join(format!("studio-agent-path-{}", Uuid::new_v4()));
        std::fs::create_dir_all(root.join("exports")).unwrap();
        std::fs::create_dir_all(root.join("projects")).unwrap();
        let check = |method: &str, mut params: Value| {
            agent_request(method, &mut params, &root).map(|_| params)
        };
        let inside = root.join("exports/final.mp4");
        let allowed = check("export.start", json!({"path":inside,"overwrite":true})).unwrap();
        assert_eq!(allowed["overwrite"], false, "agents never overwrite");
        if let Some(home) = dirs::home_dir() {
            assert!(check("captions.export", json!({"path":home.join("Movies/byori-test.srt")})).is_ok());
            assert!(check("export.start", json!({"path":home.join(".ssh/out.mp4")})).is_err());
        }
        for path in [
            root.join("projects/other.json"),
            root.join("connection.json"),
            root.join("exports"),
            root.join("exports/../connection.json"),
            PathBuf::from("relative.mp4"),
        ] {
            assert!(
                check("project.save", json!({"path":path})).is_err(),
                "{path:?}"
            );
        }
        // Even an allowed folder is refused: it would move the project's save location.
        let copy = check("project.save", json!({"path":root.join("exports/copy.json")}));
        assert!(copy.unwrap_err().contains("path 없이"));
        // Saving to the default location carries no path and no overwrite flag.
        let saved = check("project.save", json!({"overwrite":true})).unwrap();
        assert!(saved.get("overwrite").is_none());
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(root.join("projects"), root.join("exports/link")).unwrap();
            assert!(check("presets.export", json!({"path":root.join("exports/link/x.json")})).is_err());
        }
        assert!(check("project.delete", json!({})).is_err());
        assert!(check("edit.batch", json!({"commands":[{"method":"captions.export","params":{"path":inside}}]})).is_err());
        assert!(check("edit.batch", json!({"commands":[{"method":"edit.marker","params":{"time":1}}]})).is_ok());
        std::fs::remove_dir_all(&root).unwrap();
    }
    fn temp_root(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!("studio-{name}-{}", Uuid::new_v4()))
    }
    #[tokio::test]
    async fn dev_service_serves_sessions_and_is_reused_only_when_compatible() {
        let root = temp_root("service");
        let service = StudioService::start_on(root.clone(), Host::Service, 0)
            .await
            .unwrap();
        let url = service.connection.url.clone();
        let port: u16 = url.rsplit(':').next().unwrap().parse().unwrap();
        let client = reqwest::Client::new();
        let health: Value = client
            .get(format!("{url}/health"))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(health["service"], "byori-studio");
        assert_eq!(health["version"], env!("CARGO_PKG_VERSION"));
        assert_eq!(health["host"], "service");

        let session = |origin: Option<String>| {
            let mut request = client.get(format!("{url}/session"));
            if let Some(origin) = origin {
                request = request.header("origin", origin);
            }
            request.send()
        };
        assert_eq!(session(None).await.unwrap().status(), 401);
        assert_eq!(
            session(Some("https://example.com".into()))
                .await
                .unwrap()
                .status(),
            401
        );
        let granted: Connection = session(Some(dev_origins()[0].clone()))
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(granted.token, service.connection.token);
        let unauthenticated = client
            .post(format!("{url}/rpc"))
            .json(&json!({"method":"project.get"}))
            .send()
            .await
            .unwrap();
        assert_eq!(unauthenticated.status(), 401);

        // The desktop app attaches to a running dev service of the same version.
        let attached = StudioService::start_on(root.clone(), Host::App, port)
            .await
            .unwrap();
        assert_eq!(attached.connection.token, service.connection.token);
        assert!(attached.runtime.is_none());
        drop(attached);
        assert!(
            root.join("connection.json").is_file(),
            "an attached instance does not own the service"
        );
        // A stale connection file must not be trusted.
        let other = temp_root("service-other");
        std::fs::create_dir_all(&other).unwrap();
        assert!(existing_service(&other, port, Host::App).await.is_err());

        service.shutdown();
        assert!(!root.join("connection.json").exists());
        drop(service);
        // The dev service must not claim to be running on top of the desktop app's service.
        let app = StudioService::start_on(root.clone(), Host::App, 0).await.unwrap();
        let app_port: u16 = app.connection.url.rsplit(':').next().unwrap().parse().unwrap();
        let refused = existing_service(&root, app_port, Host::Service).await.unwrap_err();
        assert!(refused.contains("데스크톱 앱"), "{refused}");
        drop(app);
        std::fs::remove_dir_all(&root).unwrap();
        std::fs::remove_dir_all(&other).unwrap();
    }
    #[tokio::test]
    async fn desktop_app_is_single_instance_and_reports_foreign_listeners() {
        let root = temp_root("app");
        let app = StudioService::start_on(root.clone(), Host::App, 0)
            .await
            .unwrap();
        let port: u16 = app.connection.url.rsplit(':').next().unwrap().parse().unwrap();
        let session = reqwest::get(format!("{}/session", app.connection.url))
            .await
            .unwrap();
        assert_eq!(session.status(), 404, "the desktop app exposes no token endpoint");
        let second = StudioService::start_on(root.clone(), Host::App, port)
            .await
            .err()
            .unwrap();
        assert!(second.contains("이미 실행 중"), "{second}");
        drop(app);
        std::fs::remove_dir_all(&root).unwrap();

        // Some other program on the port: a clear error, not a panic or a hijack.
        let listener = tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
            .await
            .unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            while let Ok((mut socket, _)) = listener.accept().await {
                let _ = socket
                    .write_all(b"HTTP/1.1 200 OK\r\ncontent-length: 2\r\nconnection: close\r\n\r\nok")
                    .await;
            }
        });
        let root = temp_root("foreign");
        let error = StudioService::start_on(root.clone(), Host::App, port)
            .await
            .err()
            .unwrap();
        assert!(error.contains("다른 프로그램"), "{error}");
        std::fs::remove_dir_all(&root).unwrap();
    }
    #[test]
    fn startup_removes_only_unreferenced_proxies() {
        let root = temp_root("orphans");
        for folder in ["imports", "proxies", "projects"] {
            std::fs::create_dir_all(root.join(folder)).unwrap();
        }
        // Speech results: narration in use, a recent unapplied one, and an old one.
        let (narration, recent, stale) = (Uuid::new_v4(), Uuid::new_v4(), Uuid::new_v4());
        for (job, age_days) in [(narration, 30), (recent, 1), (stale, 30)] {
            let folder = root.join(format!("speech/{job}"));
            std::fs::create_dir_all(&folder).unwrap();
            std::fs::write(folder.join("voice.aiff"), "x").unwrap();
            let at = std::time::SystemTime::now() - Duration::from_secs(age_days * 24 * 3600);
            std::fs::File::open(&folder).unwrap().set_modified(at).unwrap();
        }
        let touch = |relative: String| {
            std::fs::write(root.join(&relative), "x").unwrap();
            root.join(relative)
        };
        let (open, stored, set_aside, gone) =
            (Uuid::new_v4(), Uuid::new_v4(), Uuid::new_v4(), Uuid::new_v4());
        let kept = [
            touch(format!("imports/{open}-열린 영상.mp4")),
            touch(format!("imports/{stored}-b.mp4")),
            touch(format!("imports/{set_aside}-c.mp4")),
            touch("imports/not-an-upload.txt".into()),
            touch("proxies/media-open.mp4".into()),
            touch("proxies/media-open.source".into()),
            touch("proxies/media-stored.mp4".into()),
            touch("proxies/notes.txt".into()),
            // Referenced by nothing here, but a project file saved elsewhere may
            // point at it and this is the only copy.
            touch(format!("imports/{gone}-d.mp4")),
        ];
        let removed = [
            touch("proxies/media-gone.mp4".into()),
            touch("proxies/media-gone.source".into()),
            // A longer id must not be kept because a shorter one is in use.
            touch("proxies/media-open2.mp4".into()),
            touch(format!("proxies/.media-open.{gone}.partial.mp4")),
        ];
        let media = |id: &str, upload: Uuid| json!({"media":[{"id":id,"path":root.join(format!("imports/{upload}-x.mp4"))}]}).to_string();
        std::fs::write(root.join("current.json"), media("media-open", open)).unwrap();
        std::fs::write(root.join("projects/p.json"), media("media-stored", stored)).unwrap();
        std::fs::write(
            root.join("projects/narrated.json"),
            json!({"media":[{"id":"media-voice","path":root.join(format!("speech/{narration}/voice.aiff"))}]}).to_string(),
        )
        .unwrap();
        // An autosave that could not be parsed still protects what it mentions.
        std::fs::write(root.join("current.json.corrupt-1"), format!("{{ broken {set_aside}")).unwrap();
        remove_orphaned_media_files(&root);
        for path in &kept {
            assert!(path.is_file(), "{path:?} was removed");
        }
        for path in &removed {
            assert!(!path.exists(), "{path:?} was kept");
        }
        assert!(root.join(format!("speech/{narration}/voice.aiff")).is_file());
        assert!(root.join(format!("speech/{recent}")).is_dir(), "recent results stay importable");
        assert!(root.join(format!("speech/{stale}/voice.aiff")).is_file(), "may be a saved project's narration");
        std::fs::remove_dir_all(&root).unwrap();
    }
    #[test]
    fn agent_preview_clients_are_distinct_and_do_not_reveal_tokens() {
        let (a, b) = (preview_client("token-a"), preview_client("token-b"));
        assert_ne!(a, b);
        assert_eq!(a, preview_client("token-a"));
        assert!(a.starts_with("agent-") && !a.contains("token"));
        assert!(brings_media("media.importAndAdd") && brings_media("history.undo"));
        assert!(!brings_media("project.get") && !brings_media("export.status"));
    }
    /// Imports stay quick: the waveform and the proxy arrive afterwards without a
    /// new revision, and the proxy follows the media item when it is relinked.
    #[tokio::test]
    async fn imported_media_gets_its_waveform_and_proxy_in_the_background() {
        let root = temp_root("background");
        let sources = temp_root("background-sources");
        std::fs::create_dir_all(&sources).unwrap();
        let make = |name: &str, size: &str, tone: u32| {
            let path = sources.join(name);
            let made = std::process::Command::new(media::executable("ffmpeg"))
                .args(["-v", "error", "-y", "-f", "lavfi", "-i"])
                .arg(format!("testsrc=size={size}:rate=10:duration=1"))
                .args(["-f", "lavfi", "-i"])
                .arg(format!("sine=frequency={tone}:duration=1"))
                .args(["-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest"])
                .arg(&path)
                .status()
                .unwrap();
            assert!(made.success());
            path.canonicalize().unwrap()
        };
        let wide = make("wide.mp4", "1924x64", 440);
        let other = make("other.mp4", "64x1924", 880);
        let small = make("small.mp4", "320x180", 440);
        let original = std::fs::read(&wide).unwrap();

        let service = StudioService::start_on(root.clone(), Host::Service, 0).await.unwrap();
        let url = service.connection.url.clone();
        let client = reqwest::Client::new();
        let rpc = |method: &str, params: Value| {
            let request = client
                .post(format!("{url}/rpc"))
                .bearer_auth(&service.connection.token)
                .json(&json!({"method":method,"params":params}));
            async move {
                let body: Value = request.send().await.unwrap().json().await.unwrap();
                assert!(body.get("error").is_none(), "{body}");
                body["result"].clone()
            }
        };
        let imported = rpc("media.import", json!({"paths":[wide, small]})).await;
        let revision = imported["revision"].clone();
        let (wide_id, small_id) = (
            imported["media"][0]["id"].as_str().unwrap().to_owned(),
            imported["media"][1]["id"].as_str().unwrap().to_owned(),
        );
        let proxy = |id: &str| {
            client
                .get(format!("{url}/assets/{id}/proxy"))
                .bearer_auth(&service.connection.token)
                .header("range", "bytes=0-15")
                .send()
        };
        let settled = |ready: fn(&Value) -> bool| {
            let rpc = &rpc;
            async move {
                for _ in 0..300 {
                    let project = rpc("project.get", json!({})).await;
                    if ready(&project) {
                        return project;
                    }
                    tokio::time::sleep(Duration::from_millis(100)).await;
                }
                panic!("background media work did not finish");
            }
        };
        let project = settled(|p| {
            p["media"][0]["proxy"] == true && p["media"].as_array().unwrap().iter().all(|m| m["waveform"].is_array())
        })
        .await;
        assert_eq!(project["revision"], revision, "derived state is not an edit");
        assert!(project["media"][0]["waveform"].as_array().unwrap().iter().any(|v| v.as_f64().unwrap() > 0.0));
        assert!(project["media"][1].get("proxy").is_none(), "small H.264 plays as it is");
        assert_eq!(rpc("history.status", json!({})).await["canUndo"], true);
        rpc("history.undo", json!({})).await;
        assert_eq!(rpc("history.status", json!({})).await["canUndo"], false, "only the import is undoable");
        rpc("history.redo", json!({})).await;

        let served = proxy(&wide_id).await.unwrap();
        assert_eq!(served.status(), 206);
        assert_eq!(served.bytes().await.unwrap().len(), 16);
        assert_eq!(proxy(&small_id).await.unwrap().status(), 404);
        assert_eq!(proxy("unknown").await.unwrap().status(), 404);
        let unauthenticated = client.get(format!("{url}/assets/{wide_id}/proxy")).send().await.unwrap();
        assert_eq!(unauthenticated.status(), 401);
        let file = root.join("proxies").join(format!("{wide_id}.mp4"));
        let probed = media::probe_info(&file, &root).await.unwrap();
        assert_eq!((probed["width"].as_u64(), probed["hasAudio"].as_bool()), (Some(1280), Some(true)));
        assert_eq!(std::fs::read(&wide).unwrap(), original, "the source is only read");

        // Relinked to another file: the old proxy must not stand in for it.
        std::fs::remove_file(&wide).unwrap();
        rpc("media.relink", json!({"id":wide_id,"path":other})).await;
        for _ in 0..300 {
            let note = std::fs::read_to_string(root.join("proxies").join(format!("{wide_id}.source")));
            if note.is_ok_and(|noted| FsPath::new(&noted) == other) && file.is_file() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        let rebuilt = media::probe_info(&file, &root).await.unwrap();
        assert_eq!(rebuilt["height"].as_u64(), Some(1280), "the proxy shows the relinked file");

        // Stopping the service stops the worker; unreferenced files go at the next start.
        std::fs::write(root.join("proxies/media-removed.mp4"), "x").unwrap();
        drop(service);
        let again = StudioService::start_on(root.clone(), Host::Service, 0).await.unwrap();
        assert!(!root.join("proxies/media-removed.mp4").exists());
        assert!(file.is_file());
        drop(again);
        std::fs::remove_dir_all(&root).unwrap();
        std::fs::remove_dir_all(&sources).unwrap();
    }
    /// Undo while a waveform is being decoded drops the result; after redo the
    /// media must get its waveform without restarting the service.
    #[tokio::test]
    async fn waveform_is_computed_again_when_the_media_returns() {
        let root = temp_root("waveform-retry");
        let sources = temp_root("waveform-retry-sources");
        std::fs::create_dir_all(&sources).unwrap();
        let tone = sources.join("tone.wav");
        let made = std::process::Command::new(media::executable("ffmpeg"))
            .args(["-v", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=1"])
            .arg(&tone)
            .status()
            .unwrap();
        assert!(made.success());
        let tone = tone.canonicalize().unwrap();
        let editor = Arc::new(Mutex::new(Editor::new(root.clone()).unwrap()));
        editor.lock().await.dispatch("media.import", json!({"paths":[tone]})).await.unwrap();
        assert_eq!(editor.lock().await.pending_waveforms().len(), 1);

        let mut attempted = HashSet::new();
        let undo_meanwhile = |_: PathBuf, _: f64| async {
            editor.lock().await.dispatch("history.undo", json!({})).await.unwrap();
            Some(vec![0.5])
        };
        assert!(waveform_work(&editor, &mut attempted, undo_meanwhile).await);
        editor.lock().await.dispatch("history.redo", json!({})).await.unwrap();
        assert_eq!(editor.lock().await.pending_waveforms().len(), 1, "the dropped result was not kept");

        let cancel = Arc::new(AtomicBool::new(false));
        assert!(media_work_step(&editor, &root, &cancel, &mut attempted).await);
        let project = editor.lock().await.dispatch("project.get", json!({})).await.unwrap();
        let peaks = project["media"][0]["waveform"].as_array().expect("waveform after redo");
        assert!(peaks.iter().any(|v| v.as_f64().unwrap() > 0.0));
        // Recorded now, so it is not decoded again.
        let never = |_: PathBuf, _: f64| async { panic!("decoded twice") };
        assert!(!waveform_work(&editor, &mut attempted, never).await);
        // A reprobe makes it pending again, and it is decoded in this same run.
        let id = project["media"][0]["id"].clone();
        editor.lock().await.dispatch("media.reprobe", json!({"ids":[id]})).await.unwrap();
        assert_eq!(editor.lock().await.pending_waveforms().len(), 1);
        let again = |_: PathBuf, _: f64| async { Some(vec![0.25]) };
        assert!(waveform_work(&editor, &mut attempted, again).await);
        let project = editor.lock().await.dispatch("project.get", json!({})).await.unwrap();
        assert_eq!(project["media"][0]["waveform"], json!([0.25]));
        std::fs::remove_dir_all(&root).unwrap();
        std::fs::remove_dir_all(&sources).unwrap();
    }
    #[test]
    fn upload_names_cannot_escape() {
        assert_eq!(clean_filename("../../a.mp4"), "a.mp4");
        assert_eq!(clean_filename("C:\\folder\\x.mp4"), "x.mp4");
        assert_eq!(clean_filename(".."), "media");
    }
    fn upload_fixture() -> ServiceState {
        let root = std::env::temp_dir().join(format!("studio-upload-{}", Uuid::new_v4()));
        let editor = Arc::new(Mutex::new(Editor::new(root.clone()).unwrap()));
        let connection = Connection {
            url: "http://127.0.0.1:1".into(),
            token: "test".into(),
        };
        let runtime =
            Arc::new(Runtime::new(root.clone(), connection.clone(), editor.clone()).unwrap());
        ServiceState {
            previews: Arc::new(PreviewFrames::default()),
            editor,
            runtime,
            connection,
            root,
            origins: Arc::new(allowed_origins(Host::Service)),
            media_work: Arc::new(Notify::new()),
        }
    }
    fn upload_headers() -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert("authorization", "Bearer test".parse().unwrap());
        headers
    }
    #[tokio::test]
    async fn uploads_require_project_binding_and_accept_matching_srt() {
        let state = upload_fixture();
        let rejected = upload(
            State(state.clone()),
            upload_headers(),
            Query(HashMap::new()),
            Body::empty(),
        )
        .await;
        assert_eq!(rejected.status(), StatusCode::BAD_REQUEST);
        let project = state
            .editor
            .lock()
            .await
            .dispatch("project.get", json!({}))
            .await
            .unwrap();
        let query = HashMap::from([
            ("name".into(), "captions.srt".into()),
            ("projectId".into(), project["id"].as_str().unwrap().into()),
        ]);
        let accepted = upload(
            State(state.clone()),
            upload_headers(),
            Query(query),
            Body::from("1\n00:00:00,000 --> 00:00:01,000\nUpload test\n"),
        )
        .await;
        assert_eq!(accepted.status(), StatusCode::OK);
        let updated = state
            .editor
            .lock()
            .await
            .dispatch("project.get", json!({}))
            .await
            .unwrap();
        assert_eq!(updated["clips"][0]["text"]["content"], "Upload test");
        std::fs::remove_dir_all(&state.root).unwrap();
    }
    #[tokio::test]
    async fn streamed_upload_rejects_project_switches_and_revision_changes() {
        for switch in [false, true] {
            let state = upload_fixture();
            let project = state
                .editor
                .lock()
                .await
                .dispatch("project.get", json!({}))
                .await
                .unwrap();
            let query = HashMap::from([
                ("name".into(), "captions.srt".into()),
                ("projectId".into(), project["id"].as_str().unwrap().into()),
            ]);
            let (started_tx, started_rx) = tokio::sync::oneshot::channel();
            let (resume_tx, resume_rx) = tokio::sync::oneshot::channel();
            let stream = futures_util::stream::once(async move {
                started_tx.send(()).unwrap();
                resume_rx.await.unwrap();
                Ok::<_, std::io::Error>("1\n00:00:00,000 --> 00:00:01,000\nMust not be inserted\n")
            });
            let task = tokio::spawn(upload(
                State(state.clone()),
                upload_headers(),
                Query(query),
                Body::from_stream(stream),
            ));
            started_rx.await.unwrap();
            let method = if switch {
                "project.new"
            } else {
                "project.update"
            };
            let params = if switch {
                json!({"name":"New project"})
            } else {
                json!({"patch":{"name":"Changed during upload"}})
            };
            state
                .editor
                .lock()
                .await
                .dispatch(method, params)
                .await
                .unwrap();
            resume_tx.send(()).unwrap();
            assert_eq!(task.await.unwrap().status(), StatusCode::CONFLICT);
            let current = state
                .editor
                .lock()
                .await
                .dispatch("project.get", json!({}))
                .await
                .unwrap();
            assert!(current["clips"].as_array().unwrap().is_empty());
            assert!(current["media"].as_array().unwrap().is_empty());
            assert_eq!(
                std::fs::read_dir(state.root.join("imports"))
                    .unwrap()
                    .count(),
                0
            );
            std::fs::remove_dir_all(&state.root).unwrap();
        }
    }
}
