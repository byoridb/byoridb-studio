use crate::{
    editor::Editor,
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
use std::{collections::HashMap, path::PathBuf, sync::Arc};
use tokio::{io::AsyncWriteExt, sync::Mutex, task::JoinHandle};
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
}

pub struct StudioService {
    pub connection: Connection,
    root: PathBuf,
    runtime: Option<Arc<Runtime>>,
    task: Option<JoinHandle<()>>,
}
impl StudioService {
    /// Stops child processes and revokes access. Safe to call more than once;
    /// does nothing when this instance only attached to an existing service.
    pub fn shutdown(&self) {
        let Some(runtime) = self.runtime.as_ref() else {
            return;
        };
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
        let state = ServiceState {
            previews: Arc::new(PreviewFrames::default()),
            editor,
            runtime: runtime.clone(),
            connection: connection.clone(),
            root: root.clone(),
            origins: Arc::new(origins.clone()),
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
        })
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
    match result {
        Ok(value) => Json(json!({"result":value})).into_response(),
        Err(error) => (StatusCode::BAD_REQUEST, Json(json!({"error":error}))).into_response(),
    }
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
        Ok(value) => Json(json!({"result":value})).into_response(),
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
    serve_asset(state, id, query, request, false).await
}
async fn thumbnail(
    State(state): State<ServiceState>,
    Path(id): Path<String>,
    Query(query): Query<HashMap<String, String>>,
    request: Request<Body>,
) -> Response {
    serve_asset(state, id, query, request, true).await
}
async fn serve_asset(
    state: ServiceState,
    id: String,
    query: HashMap<String, String>,
    request: Request<Body>,
    thumbnail: bool,
) -> Response {
    if !permitted_origin(request.headers(), &state.origins)
        || !(query.get("token") == Some(&state.connection.token)
            || authenticated(request.headers(), &state))
    {
        return denied();
    }
    tracing::debug!("asset {id}");
    let path = state.editor.lock().await.asset_path(&id, thumbnail);
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
