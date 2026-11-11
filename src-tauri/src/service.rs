use crate::{editor::Editor, preview::PreviewFrames, runtime::Runtime};
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

#[derive(Clone)]
struct ServiceState {
    editor: Arc<Mutex<Editor>>,
    previews: Arc<PreviewFrames>,
    runtime: Arc<Runtime>,
    connection: Connection,
    root: PathBuf,
}

pub struct StudioService {
    pub connection: Connection,
    task: Option<JoinHandle<()>>,
}
impl Drop for StudioService {
    fn drop(&mut self) {
        if let Some(task) = self.task.take() {
            task.abort();
        }
    }
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
    pub async fn start(root: Option<PathBuf>) -> Result<Self, String> {
        let root = root.unwrap_or_else(data_root);
        std::fs::create_dir_all(&root).map_err(|e| e.to_string())?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&root, std::fs::Permissions::from_mode(0o700))
                .map_err(|e| e.to_string())?;
        }
        let port = std::env::var("BYORI_STUDIO_PORT")
            .ok()
            .and_then(|v| v.parse::<u16>().ok())
            .unwrap_or(43123);
        let listener =
            match tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, port)).await {
                Ok(listener) => listener,
                Err(error) => {
                    // Reuse an already running Studio service, never an arbitrary port listener.
                    if let Ok(bytes) = std::fs::read(root.join("connection.json")) {
                        if let Ok(connection) = serde_json::from_slice::<Connection>(&bytes) {
                            if connection.url == format!("http://127.0.0.1:{port}") {
                                let response = reqwest::Client::new()
                                    .post(format!("{}/rpc", connection.url))
                                    .bearer_auth(&connection.token)
                                    .timeout(std::time::Duration::from_secs(2))
                                    .json(&json!({"method":"project.get","params":{}}))
                                    .send()
                                    .await;
                                if let Ok(r) = response {
                                    if r.status().is_success() {
                                        return Ok(Self {
                                            connection,
                                            task: None,
                                        });
                                    }
                                }
                            }
                        }
                    }
                    return Err(format!("Studio 포트 {port}를 사용할 수 없습니다: {error}"));
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
        let state = ServiceState {
            previews: Arc::new(PreviewFrames::default()),
            editor,
            runtime,
            connection: connection.clone(),
            root: root.clone(),
        };
        let origins = [
            "http://localhost:1420",
            "http://127.0.0.1:1420",
            "tauri://localhost",
            "http://tauri.localhost",
            "https://tauri.localhost",
        ];
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
        let app = Router::new()
            .route("/session", get(session))
            .route(
                "/health",
                get(|| async {
                    Json(json!({"service":"byori-studio","version":env!("CARGO_PKG_VERSION")}))
                }),
            )
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
            task: Some(task),
        })
    }
}

fn permitted_origin(headers: &HeaderMap) -> bool {
    headers
        .get("origin")
        .map(|v| {
            matches!(
                v.to_str().unwrap_or(""),
                "http://localhost:1420"
                    | "http://127.0.0.1:1420"
                    | "tauri://localhost"
                    | "http://tauri.localhost"
                    | "https://tauri.localhost"
            )
        })
        .unwrap_or(true)
}
fn authenticated(headers: &HeaderMap, token: &str) -> bool {
    permitted_origin(headers)
        && headers
            .get("authorization")
            .and_then(|v| v.to_str().ok())
            .map(|v| v == format!("Bearer {token}"))
            .unwrap_or(false)
}
fn denied() -> Response {
    (
        StatusCode::UNAUTHORIZED,
        Json(json!({"error":"Studio 연결 인증이 필요합니다"})),
    )
        .into_response()
}

async fn session(State(state): State<ServiceState>, headers: HeaderMap) -> Response {
    if !headers
        .get("origin")
        .map(|v| {
            matches!(
                v.to_str().unwrap_or(""),
                "http://localhost:1420" | "http://127.0.0.1:1420"
            )
        })
        .unwrap_or(false)
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
    if !authenticated(&headers, &state.connection.token) {
        return denied();
    }
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
    let result = if request.method == "preview.frame" {
        state.previews.frame(&state.editor, request.params, request.project_id.as_deref()).await
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
    if !authenticated(&headers, &state.connection.token) {
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
    if !permitted_origin(request.headers())
        || !(query.get("token") == Some(&state.connection.token)
            || authenticated(request.headers(), &state.connection.token))
    {
        return denied();
    }
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
    #[test]
    fn origins_and_tokens_are_both_checked() {
        let mut h = HeaderMap::new();
        h.insert("authorization", "Bearer secret".parse().unwrap());
        assert!(authenticated(&h, "secret"));
        h.insert("origin", "https://example.com".parse().unwrap());
        assert!(!authenticated(&h, "secret"));
        h.insert("origin", "http://localhost:1420".parse().unwrap());
        assert!(authenticated(&h, "secret"));
        assert!(!authenticated(&h, "other"));
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
