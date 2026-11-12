use crate::{
    editor::{Editor, Unsynced},
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
        atomic::{AtomicBool, AtomicU64, Ordering},
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
    /// The media whose proxy is being built right now.
    proxy_in_progress: ProxyInProgress,
    /// How many bytes `proxies/` may hold (`storage.configure`); 0 is no limit.
    proxy_limit: Arc<AtomicU64>,
}
type ProxyInProgress = Arc<std::sync::Mutex<Option<String>>>;

pub struct StudioService {
    pub connection: Connection,
    root: PathBuf,
    runtime: Option<Arc<Runtime>>,
    task: Option<JoinHandle<()>>,
    media_worker: Option<JoinHandle<()>>,
    media_cancel: Arc<AtomicBool>,
    /// The project files that are written but not flushed to the device yet.
    unsynced: Option<Arc<Unsynced>>,
    autosave: Option<JoinHandle<()>>,
    #[cfg(test)]
    editor: Option<Arc<Mutex<Editor>>>,
}
impl StudioService {
    /// Flushes the last edits, stops child processes and revokes access. Safe to
    /// call more than once; does nothing when this instance only attached to an
    /// existing service.
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
        if let Some(unsynced) = self.unsynced.as_ref() {
            save_on_shutdown(unsynced);
        }
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
        for task in [self.task.take(), self.autosave.take()]
            .into_iter()
            .flatten()
        {
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
async fn existing_service(
    root: &std::path::Path,
    port: u16,
    host: Host,
) -> Result<Connection, String> {
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
                        unsynced: None,
                        autosave: None,
                        #[cfg(test)]
                        editor: None,
                    })
                }
            };
        let port = listener.local_addr().map_err(|e| e.to_string())?.port();
        let connection = Connection {
            url: format!("http://127.0.0.1:{port}"),
            token: format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple()),
        };
        let mut editor = Editor::new(root.clone())?;
        // Edits are in the project's files when they are answered, without waiting
        // for the device; `autosave` flushes them.
        editor.defer_saves();
        let unsynced = editor.unsynced();
        let editor = Arc::new(Mutex::new(editor));
        let autosave = tokio::spawn(autosave(unsynced.clone()));
        let runtime = Arc::new(Runtime::new(
            root.clone(),
            connection.clone(),
            editor.clone(),
        )?);
        let origins = allowed_origins(host);
        // Before anything can upload or import: no request is running yet.
        let root_for_cleanup = root.clone();
        let _ = tokio::task::spawn_blocking(move || remove_orphaned_media_files(&root_for_cleanup))
            .await;
        let media_work = Arc::new(Notify::new());
        let media_cancel = Arc::new(AtomicBool::new(false));
        let proxy_in_progress = ProxyInProgress::default();
        let proxy_limit = Arc::new(AtomicU64::new(saved_proxy_limit(&root)));
        let media_worker = tokio::spawn(media_worker(
            editor.clone(),
            root.clone(),
            media_work.clone(),
            media_cancel.clone(),
            proxy_in_progress.clone(),
            proxy_limit.clone(),
        ));
        let state = ServiceState {
            previews: Arc::new(PreviewFrames::default()),
            editor: editor.clone(),
            runtime: runtime.clone(),
            connection: connection.clone(),
            root: root.clone(),
            origins: Arc::new(origins.clone()),
            media_work,
            proxy_in_progress,
            proxy_limit,
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
            .route("/projects/{id}/thumbnail", get(project_thumbnail))
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
            unsynced: Some(unsynced),
            autosave: Some(autosave),
            #[cfg(test)]
            editor: Some(editor),
        })
    }
}

/// How often `autosave` looks whether written edits are due to be flushed.
const SAVE_POLL: Duration = Duration::from_millis(100);
/// Flushes the project files to the device once editing pauses (`editor::SAVE_IDLE`)
/// and at the latest `editor::SAVE_LATEST` after an edit. Every answered edit is in
/// those files already, so this only narrows what a power cut can lose; it never
/// takes the editor, and editing goes on while the device is busy. A flush that
/// fails is tried again every pass.
async fn autosave(unsynced: Arc<Unsynced>) {
    let mut failing = false;
    loop {
        tokio::time::sleep(SAVE_POLL).await;
        if !unsynced.due() {
            continue;
        }
        let files = unsynced.clone();
        let synced = tokio::task::spawn_blocking(move || files.sync())
            .await
            .unwrap_or_else(|error| Err(error.to_string()));
        match synced {
            Ok(()) => failing = false,
            Err(error) => {
                if !failing {
                    tracing::error!("프로젝트를 저장하지 못했습니다: {error}");
                }
                failing = true;
            }
        }
    }
}
/// Flushes what `autosave` has not flushed yet. It does not wait for the editor: a
/// command that is still running there cannot hold the shutdown up, and no answered
/// edit depends on it, because an edit is in the project's files before its answer.
fn save_on_shutdown(unsynced: &Unsynced) {
    if let Err(error) = unsynced.sync() {
        tracing::error!("종료하면서 프로젝트를 저장하지 못했습니다: {error}");
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
    proxy_in_progress: ProxyInProgress,
    proxy_limit: Arc<AtomicU64>,
) {
    let mut work = MediaWork {
        proxy_in_progress,
        proxy_limit,
        ..MediaWork::default()
    };
    loop {
        if !media_work_step(&editor, &root, &cancel, &mut work).await {
            // Imports made by speech jobs and agents arrive without a wake-up.
            let pause = work
                .next_retry()
                .map_or(MEDIA_POLL, |wait| wait.min(MEDIA_POLL));
            tokio::select! {
                _ = wake.notified() => {}
                _ = tokio::time::sleep(pause) => {}
            }
        }
    }
}
const MEDIA_POLL: Duration = Duration::from_secs(5);
/// How often a waveform that could not be saved is saved again soon, after 2, 4
/// and 8 seconds. A save that still fails then is tried once a minute: it must not
/// spin, and a disk that works again later must not cost the waveform until the
/// next start.
const WAVEFORM_RETRIES: u32 = 3;
const WAVEFORM_RETRY_DELAY: Duration = Duration::from_secs(2);
const WAVEFORM_SLOW_RETRY: Duration = Duration::from_secs(60);
/// A decoded waveform waiting to be saved again.
struct WaveformRetry {
    failures: u32,
    at: std::time::Instant,
    peaks: Option<Vec<f32>>,
}
/// What the background worker remembers during one run of the service.
struct MediaWork {
    /// Work that failed for good or was refused: not tried again until the next start.
    attempted: HashSet<String>,
    retries: HashMap<String, WaveformRetry>,
    retry_delay: Duration,
    slow_retry: Duration,
    proxy_in_progress: ProxyInProgress,
    proxy_limit: Arc<AtomicU64>,
    /// The project and the limit `tend_proxies` last looked after, and when.
    tended: Option<(String, u64, std::time::Instant)>,
}
impl Default for MediaWork {
    fn default() -> Self {
        Self {
            attempted: HashSet::new(),
            retries: HashMap::new(),
            retry_delay: WAVEFORM_RETRY_DELAY,
            slow_retry: WAVEFORM_SLOW_RETRY,
            proxy_in_progress: ProxyInProgress::default(),
            proxy_limit: Arc::new(AtomicU64::new(DEFAULT_PROXY_LIMIT)),
            tended: None,
        }
    }
}
impl MediaWork {
    /// How long until the next waveform is due to be saved again.
    fn next_retry(&self) -> Option<Duration> {
        let now = std::time::Instant::now();
        self.retries
            .values()
            .map(|retry| retry.at.saturating_duration_since(now))
            .min()
    }
}
/// Does the next piece of pending work; false when there is none.
async fn media_work_step(
    editor: &Arc<Mutex<Editor>>,
    root: &FsPath,
    cancel: &Arc<AtomicBool>,
    work: &mut MediaWork,
) -> bool {
    let decode =
        |path: PathBuf, duration: f64| async move { media::waveform(&path, duration).await };
    if waveform_work(editor, work, decode).await {
        return true; // look for newly imported media before starting a long proxy
    }
    tend_proxies(editor, root, work).await;
    let attempted = &mut work.attempted;
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
                if media::proxy_is_of(&output, source) {
                    continue;
                }
                // Relinked (or undone) or replaced in place since: the proxy shows
                // another file.
                let _ = std::fs::remove_file(&output);
            }
            // A file replaced at the same path is another attempt.
            let key = format!("proxy:{id}:{}", media::proxy_note(source));
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
        std::fs::write(
            media::proxy_source_note(&output),
            media::proxy_note(item["path"].as_str().unwrap_or("")),
        )
    });
    // Named while it is written, so that cleaning storage leaves its unfinished
    // file alone. Cleared on every way out, also when this task is dropped.
    struct InProgress(ProxyInProgress);
    impl Drop for InProgress {
        fn drop(&mut self) {
            *self
                .0
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner()) = None;
        }
    }
    let in_progress = InProgress(work.proxy_in_progress.clone());
    *in_progress
        .0
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner()) = item["id"].as_str().map(str::to_owned);
    let built = match noted {
        Ok(()) => media::build_proxy(root, &item, cancel.clone())
            .await
            .map(|_| ()),
        Err(error) => Err(error.to_string()),
    };
    drop(in_progress);
    match built {
        Ok(()) => {
            attempted.remove(&key);
            // One more proxy: the folder may be over its limit now.
            work.tended = None;
        }
        Err(error) => {
            let _ = std::fs::remove_file(media::proxy_source_note(&output));
            tracing::warn!("{key}: {error}");
        }
    }
    true
}
/// Computes the waveforms that are still missing; false when there were none to try.
async fn waveform_work<F>(
    editor: &Arc<Mutex<Editor>>,
    work: &mut MediaWork,
    decode: impl Fn(PathBuf, f64) -> F,
) -> bool
where
    F: std::future::Future<Output = Option<Vec<f32>>>,
{
    let waveforms = editor.lock().await.pending_waveforms();
    let key_of = |id: &str, path: &FsPath| format!("waveform:{id}:{}", path.display());
    // A waveform that is no longer pending (media removed, relinked) has nothing to retry.
    let pending: HashSet<String> = waveforms
        .iter()
        .map(|(id, path, _)| key_of(id, path))
        .collect();
    work.retries.retain(|key, _| pending.contains(key));
    let mut worked = false;
    for (id, path, duration) in waveforms {
        let key = key_of(&id, &path);
        if work.attempted.contains(&key) {
            continue;
        }
        let now = std::time::Instant::now();
        if work.retries.get(&key).is_some_and(|retry| retry.at > now) {
            continue;
        }
        let earlier = work.retries.remove(&key);
        worked = true;
        // Only the save failed before: the decoded peaks are kept for the retry.
        // An empty waveform records that this file has no readable audio.
        let (failures, peaks) = match earlier {
            Some(retry) => (retry.failures, retry.peaks),
            None => (0, decode(path.clone(), duration).await),
        };
        match editor.lock().await.set_waveform(&id, &path, peaks.clone()) {
            // Recorded (an empty one too), so it is pending again only after a reprobe
            // or relink. Or the media went away meanwhile (undo, another project) and
            // nothing was recorded. Either way, compute it when it is pending again.
            Ok(_) => {}
            // The save failed (a full or briefly unwritable disk). Tried again a few
            // times, each wait twice the last, then once a minute: a save that keeps
            // failing must not spin, and the decoded peaks are kept meanwhile.
            Err(error) => {
                let wait = if failures < WAVEFORM_RETRIES {
                    work.retry_delay * 2u32.pow(failures)
                } else {
                    work.slow_retry
                };
                if failures <= WAVEFORM_RETRIES {
                    tracing::warn!("waveform for {id}: {error}; retrying in {wait:?}");
                }
                work.retries.insert(
                    key,
                    WaveformRetry {
                        failures: failures.saturating_add(1),
                        at: std::time::Instant::now() + wait,
                        peaks,
                    },
                );
            }
        }
    }
    worked
}
/// What `proxies/` may hold unless `storage.configure` says otherwise.
const DEFAULT_PROXY_LIMIT: u64 = 20 * 1024 * 1024 * 1024;
/// How often the proxies of the open project are marked as used, and the limit is
/// looked at, while nothing else changes.
const PROXY_TEND_EVERY: Duration = Duration::from_secs(600);
fn storage_settings(root: &FsPath) -> PathBuf {
    root.join("storage.json")
}
/// The proxy limit saved by `storage.configure`, else the default.
fn saved_proxy_limit(root: &FsPath) -> u64 {
    std::fs::read(storage_settings(root))
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
        .and_then(|saved| saved["proxyLimitBytes"].as_u64())
        .unwrap_or(DEFAULT_PROXY_LIMIT)
}
/// Keeps `proxies/` within its limit. Runs when another project is open, the limit
/// changed or a proxy was made since the last time, and every `PROXY_TEND_EVERY`.
/// Under the editor lock, so the project whose proxies are kept is the open one.
async fn tend_proxies(editor: &Arc<Mutex<Editor>>, root: &FsPath, work: &mut MediaWork) {
    let limit = work.proxy_limit.load(Ordering::Relaxed);
    let editor = editor.lock().await;
    let project = editor.project_id().to_owned();
    if work.tended.as_ref().is_some_and(|(tended, limited, at)| {
        *tended == project && *limited == limit && at.elapsed() < PROXY_TEND_EVERY
    }) {
        return;
    }
    let removed = limit_proxies(root, limit, |id| editor.proxy_path(id).is_some());
    if !removed.is_empty() {
        tracing::info!(
            "프록시 용량 한도를 넘어 오래 쓰이지 않은 프록시 {}개를 지웠습니다.",
            removed.len()
        );
    }
    work.tended = Some((project, limit, std::time::Instant::now()));
}
/// Marks the finished proxies of the open project (`in_use` by media id) as used
/// now, and while `proxies/` holds more than `limit` bytes removes the others, the
/// one used longest ago first. A proxy of the open project is never removed, also
/// when those alone exceed the limit; a limit of 0 removes nothing. Returns the
/// proxies removed.
///
/// The limit is on what is kept for projects that are not open. The open project
/// always gets its proxies, over the limit too: without one a 4K source plays and
/// scrubs several times slower, and refusing it would make the project being
/// edited the one that pays for the others. `storage.usage` says when the folder
/// is over the limit (`proxyOverLimit`) so that the settings can tell the user.
///
/// When a proxy was last used is the modification time of its ".source" note: the
/// last time its project was open here. The proxy itself is not touched, a player
/// may be reading it. A removed proxy is made again when its project is opened.
fn limit_proxies(root: &FsPath, limit: u64, in_use: impl Fn(&str) -> bool) -> Vec<PathBuf> {
    let now = std::time::SystemTime::now();
    let size = |path: &FsPath| std::fs::metadata(path).map_or(0, |info| info.len());
    let modified = |path: &FsPath| std::fs::metadata(path).and_then(|info| info.modified());
    let mut total = 0;
    let mut idle = vec![];
    for proxy in listed(&root.join("proxies")) {
        let name = proxy
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .into_owned();
        let Some(id) = name.strip_suffix(".mp4") else {
            continue;
        };
        if name.ends_with(".partial.mp4") {
            continue;
        }
        let note = media::proxy_source_note(&proxy);
        let bytes = size(&proxy) + size(&note);
        total += bytes;
        if in_use(id) {
            let _ = std::fs::File::options()
                .write(true)
                .open(&note)
                .and_then(|note| note.set_modified(now));
            continue;
        }
        let used = modified(&note)
            .or_else(|_| modified(&proxy))
            .unwrap_or(std::time::UNIX_EPOCH);
        idle.push((used, proxy, note, bytes));
    }
    let mut removed = vec![];
    if limit == 0 {
        return removed;
    }
    idle.sort();
    for (_, proxy, note, bytes) in idle {
        if total <= limit {
            break;
        }
        if std::fs::remove_file(&proxy).is_ok() {
            let _ = std::fs::remove_file(note);
            total -= bytes;
            removed.push(proxy);
        }
    }
    removed
}
/// What the finished proxies in `proxies/` take, counted as `limit_proxies` counts
/// them (each with its ".source" note, unfinished ones left out): all of them, and
/// those of the open project (`in_use` by media id), which are never removed.
fn proxy_bytes(root: &FsPath, in_use: impl Fn(&str) -> bool) -> (u64, u64) {
    let size = |path: &FsPath| std::fs::metadata(path).map_or(0, |info| info.len());
    let (mut total, mut open) = (0, 0);
    for proxy in listed(&root.join("proxies")) {
        let name = proxy
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .into_owned();
        let Some(id) = name.strip_suffix(".mp4") else {
            continue;
        };
        if name.ends_with(".partial.mp4") {
            continue;
        }
        let bytes = size(&proxy) + size(&media::proxy_source_note(&proxy));
        total += bytes;
        if in_use(id) {
            open += bytes;
        }
    }
    (total, open)
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
    // Nothing is being built yet: every unfinished proxy is left over from a run
    // that was killed, whatever the project files say or fail to say.
    for path in unfinished_proxies(root, None, Duration::ZERO) {
        let _ = std::fs::remove_file(&path);
    }
    if let Some(references) = project_references(root) {
        for path in orphaned_proxies(root, &references) {
            let _ = std::fs::remove_file(&path);
        }
    }
}
/// How long an unfinished proxy must have been untouched before a running service
/// takes it for abandoned. FFmpeg writes to the one it is building all the time.
const UNFINISHED_PROXY_AGE: Duration = Duration::from_secs(60);
/// The ".partial.mp4" files in `proxies/` that nothing is writing: not the one of
/// the media being built (`building`), and not touched for `idle`.
fn unfinished_proxies(root: &FsPath, building: Option<&str>, idle: Duration) -> Vec<PathBuf> {
    listed(&root.join("proxies"))
        .into_iter()
        .filter(|path| {
            let name = path
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .into_owned();
            let ours = building.is_some_and(|id| name.starts_with(&format!(".{id}.")));
            let quiet = std::fs::metadata(path)
                .and_then(|info| info.modified())
                .is_ok_and(|at| at.elapsed().is_ok_and(|age| age >= idle));
            name.ends_with(".partial.mp4") && !ours && quiet
        })
        .collect()
}
fn listed(folder: &FsPath) -> Vec<PathBuf> {
    std::fs::read_dir(folder)
        .into_iter()
        .flatten()
        .flatten()
        .map(|entry| entry.path())
        .collect()
}
/// The text of every saved project: the autosave, the stored projects and autosaves
/// set aside as unreadable. `None` when one of them cannot be read, because the
/// references would be incomplete and nothing may be deleted on their word.
fn project_references(root: &FsPath) -> Option<String> {
    let mut references = String::new();
    let mut files = vec![root.join("current.json")];
    files.extend(listed(&root.join("projects")));
    files.extend(listed(root).into_iter().filter(|path| {
        path.file_name()
            .is_some_and(|name| name.to_string_lossy().starts_with("current.json.corrupt-"))
    }));
    for file in files.iter().filter(|file| file.is_file()) {
        references.push_str(&String::from_utf8_lossy(&std::fs::read(file).ok()?));
    }
    Some(references)
}
/// The files in `proxies/` whose media id no project mentions: "<media id>.mp4" and
/// its ".source" note. Unfinished ".partial.mp4" files are `unfinished_proxies`'.
fn orphaned_proxies(root: &FsPath, references: &str) -> Vec<PathBuf> {
    listed(&root.join("proxies"))
        .into_iter()
        .filter(|path| {
            let name = path
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .into_owned();
            if name.ends_with(".partial.mp4") {
                return false;
            }
            match name.rsplit_once('.') {
                Some((id, "mp4" | "source")) => !references.contains(&format!("\"{id}\"")),
                _ => false,
            }
        })
        .collect()
}

/// The files and bytes below a path; a link counts as itself, not what it points at.
fn disk_use(path: &FsPath) -> (u64, u64) {
    let Ok(info) = std::fs::symlink_metadata(path) else {
        return (0, 0);
    };
    if !info.is_dir() {
        return (1, info.len());
    }
    listed(path)
        .iter()
        .map(|entry| disk_use(entry))
        .fold((0, 0), |sum, entry| (sum.0 + entry.0, sum.1 + entry.1))
}
fn remove_entry(path: &FsPath) -> bool {
    match std::fs::symlink_metadata(path) {
        Ok(info) if info.is_dir() => std::fs::remove_dir_all(path).is_ok(),
        Ok(_) => std::fs::remove_file(path).is_ok(),
        Err(_) => false,
    }
}
/// The folders `storage.usage` reports. Only what is in `CLEANABLE` can be made
/// again and is ever deleted; `imports/` and `speech/` hold the only copy of media
/// the user brought in or generated.
const STORAGE_FOLDERS: [&str; 5] = ["proxies", "imports", "speech", "renders", "previews"];
const CLEANABLE: [&str; 3] = ["proxies", "previews", "renders"];
/// What may be deleted right now, per cleanable folder: proxies no project mentions
/// (the open one included), unfinished proxies that nothing is writing (`building`
/// is the media whose proxy is being made), and the scratch files in `previews/` and
/// `renders/` that neither a running render nor a shown preview uses. `in_use` are
/// the preview files still shown. Without readable project files no finished proxy
/// is offered.
fn reclaimable(
    root: &FsPath,
    open_project: &str,
    in_use: &HashSet<PathBuf>,
    building: Option<&str>,
) -> Vec<(&'static str, Vec<PathBuf>)> {
    let mut proxies = project_references(root).map_or_else(Vec::new, |mut references| {
        references.push_str(open_project);
        orphaned_proxies(root, &references)
    });
    proxies.extend(unfinished_proxies(root, building, UNFINISHED_PROXY_AGE));
    let scratch = |folder: &str| -> Vec<PathBuf> {
        listed(&root.join(folder))
            .into_iter()
            .filter(|path| !in_use.contains(path) && !crate::render::scratch_in_use(path))
            .collect()
    };
    vec![
        ("proxies", proxies),
        ("previews", scratch("previews")),
        ("renders", scratch("renders")),
    ]
}
/// What `storage.clean` may be asked to remove: the derived files `reclaimable`
/// lists (the default), and the stored projects that hold nothing.
const CLEAN_TARGETS: [&str; 2] = ["temporary", "emptyProjects"];
/// `storage.configure {proxyLimitBytes}`: how much `proxies/` may hold (0 for no
/// limit). Saved in the store, applied by the media worker at once. Answers like
/// `storage.usage`.
async fn configure_storage(state: &ServiceState, params: &Value) -> Result<Value, String> {
    let limit = params["proxyLimitBytes"]
        .as_u64()
        .ok_or("proxyLimitBytes는 0 이상의 정수(바이트)여야 합니다.")?;
    media::atomic_json(
        &storage_settings(&state.root),
        &json!({"proxyLimitBytes":limit}),
    )?;
    state.proxy_limit.store(limit, Ordering::Relaxed);
    state.media_work.notify_one();
    storage(state, &json!({}), false).await
}
/// `storage.usage` (what each folder holds, how much of it `storage.clean` would
/// free, how many empty projects are stored, the proxy limit) and `storage.clean
/// {targets?}` (frees the targets named, by default the derived files only). Both
/// are for the app's own settings: agents cannot call them.
async fn storage(state: &ServiceState, params: &Value, clean: bool) -> Result<Value, String> {
    let targets: Vec<&str> = match params["targets"].as_array() {
        Some(targets) if clean => targets.iter().filter_map(Value::as_str).collect(),
        _ => vec![CLEAN_TARGETS[0]],
    };
    if let Some(unknown) = targets.iter().find(|name| !CLEAN_TARGETS.contains(name)) {
        return Err(format!("정리할 수 없는 대상입니다: {unknown}"));
    }
    let derived = targets.contains(&"temporary");
    let empty_projects = targets.contains(&"emptyProjects");
    let limit = state.proxy_limit.load(Ordering::Relaxed);
    // The editor and the renderer name their files by the resolved store path.
    let root = state
        .root
        .canonicalize()
        .unwrap_or_else(|_| state.root.clone());
    // No frame is rendered meanwhile, so the cached frames are all that is in use
    // of the frame previews; a precise-playback video is in use while it is an asset.
    state
        .previews
        .while_idle(async |cached: Vec<PathBuf>| {
            let mut in_use: HashSet<PathBuf> = cached.into_iter().collect();
            let (open_project, empty, open_media) = {
                let mut editor = state.editor.lock().await;
                // Never the open project, and only ones that were never edited.
                let removed =
                    (clean && empty_projects).then(|| editor.delete_empty_unnamed_projects());
                let left = editor.empty_unnamed_projects();
                let mut empty = json!({
                    "count":left.len(),
                    "bytes":left.iter().map(|(_, bytes)| bytes).sum::<u64>(),
                });
                if let Some((count, bytes)) = removed {
                    empty["removed"] = json!(count);
                    empty["removedBytes"] = json!(bytes);
                }
                in_use.extend(editor.preview_asset_paths());
                for path in listed(&root.join("previews")) {
                    let shown = path
                        .file_stem()
                        .and_then(|stem| stem.to_str())
                        .is_some_and(|id| editor.asset_path(id, false).is_some());
                    if shown {
                        in_use.insert(path);
                    }
                }
                let open = editor
                    .dispatch("project.get", json!({"omitWaveforms":true}))
                    .await?;
                let media: HashSet<String> = open["media"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(|item| item["id"].as_str())
                    .filter(|id| editor.proxy_path(id).is_some())
                    .map(str::to_owned)
                    .collect();
                (open.to_string(), empty, media)
            };
            let building = state
                .proxy_in_progress
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .clone();
            tokio::task::spawn_blocking(move || {
                let mut folders = serde_json::Map::new();
                let (mut total, mut freeable) = (0, 0);
                for (folder, entries) in
                    reclaimable(&root, &open_project, &in_use, building.as_deref())
                {
                    let mut sum = (0, 0);
                    for entry in entries {
                        let size = disk_use(&entry);
                        // Checked again: a render may have started since the listing.
                        if !clean
                            || (derived
                                && !crate::render::scratch_in_use(&entry)
                                && remove_entry(&entry))
                        {
                            sum = (sum.0 + size.0, sum.1 + size.1);
                        }
                    }
                    freeable += sum.1;
                    folders.insert(
                        folder.into(),
                        json!({"reclaimableFiles":sum.0,"reclaimableBytes":sum.1}),
                    );
                }
                for folder in STORAGE_FOLDERS {
                    let (files, bytes) = disk_use(&root.join(folder));
                    total += bytes;
                    let entry = folders.entry(folder).or_insert_with(|| json!({}));
                    entry["files"] = json!(files);
                    entry["bytes"] = json!(bytes);
                    entry["cleanable"] = json!(CLEANABLE.contains(&folder));
                    if clean {
                        // After cleaning, what was reclaimable is what was removed.
                        for (from, to) in [
                            ("reclaimableFiles", "removedFiles"),
                            ("reclaimableBytes", "removedBytes"),
                        ] {
                            if let Some(value) =
                                entry.as_object_mut().and_then(|entry| entry.remove(from))
                            {
                                entry[to] = value;
                            }
                        }
                    }
                }
                let key = if clean {
                    "removedBytes"
                } else {
                    "reclaimableBytes"
                };
                // After any cleaning: what the limit is compared with, and how much
                // of it the open project holds (never removed, whatever the limit).
                let (proxies, open_proxies) = proxy_bytes(&root, |id| open_media.contains(id));
                json!({"folders":folders,"bytes":total,key:freeable,
                    "emptyProjects":empty,"proxyLimitBytes":limit,
                    "proxyBytes":proxies,"proxyOpenProjectBytes":open_proxies,
                    "proxyOverLimit":limit > 0 && proxies > limit})
            })
            .await
            .map_err(|error| error.to_string())
        })
        .await
}

fn permitted_origin(headers: &HeaderMap, origins: &[String]) -> bool {
    headers
        .get("origin")
        .map(|v| {
            origins
                .iter()
                .any(|origin| v.to_str().is_ok_and(|v| v == origin))
        })
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
    let refused = || {
        "에이전트는 Studio 내보내기 폴더와 사용자의 동영상·문서·데스크탑·다운로드·음악 폴더에만 새 파일을 만들 수 있습니다".to_owned()
    };
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
    let folders = [
        "Movies",
        "Videos",
        "Documents",
        "Desktop",
        "Downloads",
        "Music",
    ];
    let target = real(path);
    let inside = std::iter::once(root.join("exports"))
        .chain(
            home.iter()
                .flat_map(|home| folders.iter().map(|f| home.join(f))),
        )
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
    if !headers.get("origin").is_some_and(|v| {
        dev.iter()
            .any(|origin| v.to_str().is_ok_and(|v| v == origin))
    }) {
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
    // Who a preview frame is for. The UI names its player or its export dialog; a
    // request without a name is the player's.
    let mut preview_client = request.params["client"]
        .as_str()
        .filter(|client| !client.is_empty())
        .map_or_else(
            || "player".to_owned(),
            |client| client.chars().take(64).collect(),
        );
    let agent = matches!(caller, Caller::Agent(_));
    if let Caller::Agent(project) = caller {
        if let Err(error) = agent_request(&request.method, &mut request.params, &state.root) {
            return (StatusCode::FORBIDDEN, Json(json!({"error":error}))).into_response();
        }
        request.project_id = Some(project);
        // Each agent job is its own preview client, whatever it asks for: it replaces
        // only its own earlier frame request, never the player's or the export dialog's.
        preview_client = agent_preview_client(bearer(&headers).unwrap_or(""));
    }
    tracing::debug!("rpc {}", request.method);
    let result = if matches!(request.method.as_str(), "storage.usage" | "storage.clean") {
        // Never in the agent allowlist, so only the UI gets here.
        storage(&state, &request.params, request.method == "storage.clean").await
    } else if request.method == "storage.configure" {
        configure_storage(&state, &request.params).await
    } else if request.method == "preview.frame" {
        let frame = state
            .previews
            .frame(
                &state.editor,
                request.params,
                request.project_id.as_deref(),
                &preview_client,
            )
            .await;
        match frame {
            // Not a failure: the caller itself asked for another frame or stopped
            // this one, or the project changed under it. Answered as a result, so a
            // browser logs no failed request; `reason` carries the code.
            Err(reason) if crate::preview::was_superseded(&reason) => {
                Ok(json!({"cancelled":true,"reason":reason}))
            }
            frame => frame,
        }
    } else if request.method == "preview.cancel" {
        // Not in the agent allowlist: only the UI stops its own frames.
        Ok(json!({"cancelled": state.previews.cancel(&preview_client)}))
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
        if request
            .project_id
            .as_ref()
            .is_some_and(|id| editor.project_id() != id)
        {
            return project_changed(agent);
        }
        editor.dispatch(&request.method, request.params).await
    };
    // Waveforms are for drawing the timeline: an agent gets their length only.
    let result = result.map(|mut reply| {
        if agent {
            crate::editor::omit_waveforms(&mut reply);
        }
        reply
    });
    if result.is_ok() && brings_media(&request.method) {
        state.media_work.notify_one();
    }
    match result {
        Ok(value) => Json(json!({"result":value})).into_response(),
        Err(error) => (StatusCode::BAD_REQUEST, Json(json!({"error":error}))).into_response(),
    }
}

/// The answer to a request that names another project than the open one: HTTP 409
/// with the code `PROJECT_CHANGED`, worded for who asked. The UI sent it before it
/// saw the switch; an agent job is bound to the project it was started for.
fn project_changed(agent: bool) -> Response {
    let error = if agent {
        "이 작업을 시작한 프로젝트가 더 이상 열려 있지 않아 요청을 처리하지 않았습니다. 새 작업을 시작해주세요. (PROJECT_CHANGED)"
    } else {
        "다른 프로젝트가 열려 있어 요청을 처리하지 않았습니다. (PROJECT_CHANGED)"
    };
    (
        StatusCode::CONFLICT,
        Json(json!({"error":error,"code":"PROJECT_CHANGED"})),
    )
        .into_response()
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
fn agent_preview_client(token: &str) -> String {
    use sha2::{Digest, Sha256};
    let digest = Sha256::digest(token.as_bytes());
    format!(
        "agent-{}",
        digest
            .iter()
            .take(8)
            .map(|b| format!("{b:02x}"))
            .collect::<String>()
    )
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
    // `omitWaveforms=true` (or `1`): the reply names the waveforms (`waveformId`)
    // instead of carrying them, as with the same parameter of an RPC.
    let slim = query
        .get("omitWaveforms")
        .is_some_and(|value| matches!(value.as_str(), "true" | "1"));
    // Do not hold the editor lock while receiving a potentially large upload.
    let original = match state
        .editor
        .lock()
        .await
        .dispatch("project.get", json!({"omitWaveforms":true}))
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
        let current = editor.dispatch("project.get", json!({"omitWaveforms":true})).await.map_err(upload_error)?;
        if current["id"] != original["id"] || current["revision"] != original["revision"] {
            return Err((StatusCode::CONFLICT,"파일 업로드 중 프로젝트가 변경되어 가져오지 않았습니다. 현재 프로젝트에서 다시 시도해주세요.".into()));
        }
        if name.to_ascii_lowercase().ends_with(".srt") {
            editor.dispatch("captions.import", json!({"path":path,"expectedRevision":original["revision"],"omitWaveforms":slim})).await.map_err(upload_error)
        } else {
            editor.dispatch("media.import", json!({"paths":[path],"expectedRevision":original["revision"],"omitWaveforms":slim})).await.map_err(upload_error)
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
/// The cover of a stored project, open or not, for the project list:
/// `/projects/<id>/thumbnail?media=<mediaId>`, where `media` is the `thumbnail.mediaId`
/// that `project.list` gives for the project. Without `media`, that cover is looked up.
/// 404 when the project has no cover.
async fn project_thumbnail(
    State(state): State<ServiceState>,
    Path(id): Path<String>,
    Query(query): Query<HashMap<String, String>>,
    request: Request<Body>,
) -> Response {
    if !permitted_origin(request.headers(), &state.origins)
        || !(query.get("token") == Some(&state.connection.token)
            || authenticated(request.headers(), &state))
    {
        return denied();
    }
    let path = {
        let mut editor = state.editor.lock().await;
        let media = match query.get("media") {
            Some(media) => Some(media.clone()),
            None => editor
                .dispatch("project.list", json!({}))
                .await
                .ok()
                .and_then(|list| {
                    list.as_array()?
                        .iter()
                        .find(|project| project["id"] == id.as_str())?["thumbnail"]["mediaId"]
                        .as_str()
                        .map(str::to_owned)
                }),
        };
        media.and_then(|media| editor.project_thumbnail(&id, &media))
    };
    match path {
        Some(path) => match ServeFile::new(path).oneshot(request).await {
            Ok(r) => r.into_response(),
            Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
        },
        None => StatusCode::NOT_FOUND.into_response(),
    }
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
        (
            status,
            serde_json::from_slice(&bytes).unwrap_or(Value::Null),
        )
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
        let (status, _) = call(
            &state,
            &token,
            json!({"method":"export.start","params":{"path":"/etc/studio.mp4","overwrite":true}}),
        )
        .await;
        assert_eq!(status, StatusCode::FORBIDDEN);
        // Upload and the UI token itself stay out of reach.
        let mut headers = HeaderMap::new();
        headers.insert("authorization", format!("Bearer {token}").parse().unwrap());
        assert!(!authenticated(&headers, &state));

        // The UI switches projects: the agent cannot follow, whatever it claims.
        let (_, next) = call(
            &state,
            "test",
            json!({"method":"project.new","params":{"name":"다른 프로젝트"}}),
        )
        .await;
        let (status, refused) = call(
            &state,
            &token,
            json!({"method":"project.get","projectId":next["result"]["id"]}),
        )
        .await;
        assert_eq!(status, StatusCode::CONFLICT);
        assert_eq!(refused["code"], "PROJECT_CHANGED");
        let said = refused["error"].as_str().unwrap();
        assert!(
            said.contains("새 작업을 시작해주세요") && said.ends_with("(PROJECT_CHANGED)"),
            "{said}"
        );
        // The UI's own late request for the project it left is told so in its own
        // words, with the same code, and nothing runs.
        let (status, refused) = call(
            &state,
            "test",
            json!({"method":"edit.add","projectId":project_id,"params":{"text":"늦은 편집","duration":1.0}}),
        )
        .await;
        assert_eq!(status, StatusCode::CONFLICT);
        assert_eq!(refused["code"], "PROJECT_CHANGED");
        let said = refused["error"].as_str().unwrap();
        assert!(
            said.contains("다른 프로젝트가 열려 있어")
                && !said.contains("에이전트")
                && !said.contains("새 작업")
                && said.ends_with("(PROJECT_CHANGED)"),
            "{said}"
        );
        let (_, open) = call(&state, "test", json!({"method":"project.get"})).await;
        assert_eq!(open["result"]["id"], next["result"]["id"]);
        assert_eq!(open["result"]["clips"], json!([]));

        state.runtime.revoke_agent_token(&token);
        let (status, _) = call(&state, &token, json!({"method":"project.get"})).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
        std::fs::remove_dir_all(&state.root).unwrap();
    }
    /// Waveforms are for drawing: an agent's replies name their length only, the UI
    /// gets them unless it asks not to, and then fetches one with `media.waveform`.
    #[tokio::test]
    async fn agents_and_slim_replies_carry_no_waveforms() {
        let state = upload_fixture();
        let (_, project) = call(&state, "test", json!({"method":"project.get"})).await;
        let mut project = project["result"].clone();
        project["media"] = json!([{"id":"media-tone","name":"tone.wav","path":"/nonexistent/tone.wav","kind":"audio","duration":1.0,"width":0,"height":0,"hasAudio":true,"waveform":[0.5,0.25]}]);
        let file = state.root.join("exports/with-waveform.json");
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        std::fs::write(&file, project.to_string()).unwrap();
        let (status, opened) = call(
            &state,
            "test",
            json!({"method":"project.open","params":{"path":file}}),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{opened}");
        assert_eq!(opened["result"]["media"][0]["waveform"], json!([0.5, 0.25]));
        let project_id = opened["result"]["id"].as_str().unwrap().to_owned();
        let token = state.runtime.issue_agent_token(&project_id);

        let (_, seen) = call(&state, &token, json!({"method":"project.get"})).await;
        let media = &seen["result"]["media"][0];
        assert_eq!(media["id"], "media-tone");
        assert!(media.get("waveform").is_none(), "{media}");
        assert_eq!(media["waveformPeaks"], 2);
        let (status, edited) = call(
            &state,
            &token,
            json!({"method":"edit.add","params":{"text":"자막","duration":1.0}}),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{edited}");
        assert!(edited["result"]["media"][0].get("waveform").is_none());
        let (status, _) = call(
            &state,
            &token,
            json!({"method":"media.waveform","params":{"id":"media-tone"}}),
        )
        .await;
        assert_eq!(status, StatusCode::FORBIDDEN);

        let (_, full) = call(&state, "test", json!({"method":"project.get"})).await;
        assert_eq!(full["result"]["media"][0]["waveform"], json!([0.5, 0.25]));
        let (_, slim) = call(
            &state,
            "test",
            json!({"method":"project.get","params":{"omitWaveforms":true}}),
        )
        .await;
        assert!(slim["result"]["media"][0].get("waveform").is_none());
        assert_eq!(slim["result"]["media"][0]["waveformPeaks"], 2);
        let (_, peaks) = call(
            &state,
            "test",
            json!({"method":"media.waveform","params":{"id":"media-tone"}}),
        )
        .await;
        assert_eq!(
            peaks["result"],
            json!({"id":"media-tone","waveform":[0.5,0.25],
                "waveformId":slim["result"]["media"][0]["waveformId"]})
        );
        assert!(peaks["result"]["waveformId"].is_string());
        std::fs::remove_dir_all(&state.root).unwrap();
    }
    /// An edit is in the project's files when it is answered. The flush to the device
    /// follows once editing pauses, and at once when the service shuts down, also
    /// while a command still holds the editor.
    #[tokio::test]
    async fn edits_are_written_before_the_reply_and_flushed_after_a_pause_and_on_shutdown() {
        let root = temp_root("autosave");
        let service = StudioService::start_on(root.clone(), Host::Service, 0)
            .await
            .unwrap();
        let client = reqwest::Client::new();
        let add = |text: &'static str| {
            let request = client
                .post(format!("{}/rpc", service.connection.url))
                .bearer_auth(&service.connection.token)
                .json(&json!({"method":"edit.add","params":{"text":text,"duration":1.0}}));
            async move {
                let body: Value = request.send().await.unwrap().json().await.unwrap();
                assert!(body.get("error").is_none(), "{body}");
                body["result"].clone()
            }
        };
        let saved = || -> Value {
            serde_json::from_slice(&std::fs::read(root.join("current.json")).unwrap()).unwrap()
        };
        let unsynced = service.unsynced.clone().unwrap();
        let first = add("하나").await;
        assert_eq!(first["revision"], 1);
        assert_eq!(saved(), first, "written before the reply");
        assert!(!unsynced.is_empty());
        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        while !unsynced.is_empty() {
            assert!(std::time::Instant::now() < deadline, "never flushed");
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        assert_eq!(saved(), first);
        let stored = root
            .join("projects")
            .join(format!("{}.json", first["id"].as_str().unwrap()));
        assert_eq!(
            serde_json::from_slice::<Value>(&std::fs::read(stored).unwrap()).unwrap(),
            first
        );

        // A burst of edits: each one is in the file when its reply arrives.
        for text in ["둘", "셋", "넷"] {
            let edited = add(text).await;
            assert_eq!(saved(), edited);
        }
        let last = add("다섯").await;
        assert!(!unsynced.is_empty());
        // A command that never returns holds the editor; the shutdown neither waits
        // for it nor leaves anything unflushed.
        let editor = service.editor.clone().unwrap();
        let stuck = editor.lock().await;
        let began = std::time::Instant::now();
        service.shutdown();
        assert!(
            began.elapsed() < Duration::from_secs(2),
            "waited for the editor"
        );
        assert!(unsynced.is_empty(), "nothing is left for a later flush");
        assert_eq!(saved(), last);
        drop(stuck);
        drop(service);
        std::fs::remove_dir_all(&root).unwrap();
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
            assert!(check(
                "captions.export",
                json!({"path":home.join("Movies/byori-test.srt")})
            )
            .is_ok());
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
        let copy = check(
            "project.save",
            json!({"path":root.join("exports/copy.json")}),
        );
        assert!(copy.unwrap_err().contains("path 없이"));
        // Saving to the default location carries no path and no overwrite flag.
        let saved = check("project.save", json!({"overwrite":true})).unwrap();
        assert!(saved.get("overwrite").is_none());
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(root.join("projects"), root.join("exports/link")).unwrap();
            assert!(check(
                "presets.export",
                json!({"path":root.join("exports/link/x.json")})
            )
            .is_err());
        }
        assert!(check("project.delete", json!({})).is_err());
        assert!(check(
            "edit.batch",
            json!({"commands":[{"method":"captions.export","params":{"path":inside}}]})
        )
        .is_err());
        assert!(check(
            "edit.batch",
            json!({"commands":[{"method":"edit.marker","params":{"time":1}}]})
        )
        .is_ok());
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
        let app = StudioService::start_on(root.clone(), Host::App, 0)
            .await
            .unwrap();
        let app_port: u16 = app
            .connection
            .url
            .rsplit(':')
            .next()
            .unwrap()
            .parse()
            .unwrap();
        let refused = existing_service(&root, app_port, Host::Service)
            .await
            .unwrap_err();
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
        let port: u16 = app
            .connection
            .url
            .rsplit(':')
            .next()
            .unwrap()
            .parse()
            .unwrap();
        let session = reqwest::get(format!("{}/session", app.connection.url))
            .await
            .unwrap();
        assert_eq!(
            session.status(),
            404,
            "the desktop app exposes no token endpoint"
        );
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
                    .write_all(
                        b"HTTP/1.1 200 OK\r\ncontent-length: 2\r\nconnection: close\r\n\r\nok",
                    )
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
    /// Unfinished proxies: all of them go at startup, even when a project file
    /// cannot be read; a running service spares the one being built and any that
    /// was written to a moment ago.
    #[test]
    fn unfinished_proxies_are_removed_unless_one_may_still_be_written() {
        let root = temp_root("partials");
        std::fs::create_dir_all(root.join("proxies")).unwrap();
        let touch = |name: &str, age: u64| {
            let path = root.join("proxies").join(name);
            std::fs::write(&path, "x").unwrap();
            std::fs::File::options()
                .write(true)
                .open(&path)
                .unwrap()
                .set_modified(std::time::SystemTime::now() - Duration::from_secs(age))
                .unwrap();
            path
        };
        let building = touch(".media-1.a.partial.mp4", 600);
        let abandoned = touch(".media-10.b.partial.mp4", 600);
        let fresh = touch(".media-2.c.partial.mp4", 0);
        let finished = touch("media-3.mp4", 600);
        let found = |building: Option<&str>, idle: Duration| {
            let mut found = unfinished_proxies(&root, building, idle);
            found.sort();
            found
        };
        assert_eq!(
            found(Some("media-1"), UNFINISHED_PROXY_AGE),
            vec![abandoned.clone()]
        );
        assert_eq!(
            found(None, UNFINISHED_PROXY_AGE),
            vec![building.clone(), abandoned.clone()]
        );
        assert_eq!(
            found(None, Duration::ZERO),
            vec![building.clone(), abandoned.clone(), fresh.clone()]
        );
        // A project folder that cannot be listed as files makes the references
        // unknown: finished proxies stay, unfinished ones still go.
        std::fs::create_dir_all(root.join("projects/unreadable.json")).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::write(root.join("current.json"), "{}").unwrap();
            std::fs::set_permissions(
                root.join("current.json"),
                std::fs::Permissions::from_mode(0o000),
            )
            .unwrap();
            assert!(project_references(&root).is_none());
        }
        remove_orphaned_media_files(&root);
        assert!(!building.exists() && !abandoned.exists() && !fresh.exists());
        #[cfg(unix)]
        assert!(finished.is_file());
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
            std::fs::File::open(&folder)
                .unwrap()
                .set_modified(at)
                .unwrap();
        }
        let touch = |relative: String| {
            std::fs::write(root.join(&relative), "x").unwrap();
            root.join(relative)
        };
        let (open, stored, set_aside, gone) = (
            Uuid::new_v4(),
            Uuid::new_v4(),
            Uuid::new_v4(),
            Uuid::new_v4(),
        );
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
        let media = |id: &str, upload: Uuid| {
            json!({"media":[{"id":id,"path":root.join(format!("imports/{upload}-x.mp4"))}]})
                .to_string()
        };
        std::fs::write(root.join("current.json"), media("media-open", open)).unwrap();
        std::fs::write(root.join("projects/p.json"), media("media-stored", stored)).unwrap();
        std::fs::write(
            root.join("projects/narrated.json"),
            json!({"media":[{"id":"media-voice","path":root.join(format!("speech/{narration}/voice.aiff"))}]}).to_string(),
        )
        .unwrap();
        // An autosave that could not be parsed still protects what it mentions.
        std::fs::write(
            root.join("current.json.corrupt-1"),
            format!("{{ broken {set_aside}"),
        )
        .unwrap();
        remove_orphaned_media_files(&root);
        for path in &kept {
            assert!(path.is_file(), "{path:?} was removed");
        }
        for path in &removed {
            assert!(!path.exists(), "{path:?} was kept");
        }
        assert!(root
            .join(format!("speech/{narration}/voice.aiff"))
            .is_file());
        assert!(
            root.join(format!("speech/{recent}")).is_dir(),
            "recent results stay importable"
        );
        assert!(
            root.join(format!("speech/{stale}/voice.aiff")).is_file(),
            "may be a saved project's narration"
        );
        std::fs::remove_dir_all(&root).unwrap();
    }
    #[test]
    fn agent_preview_clients_are_distinct_and_do_not_reveal_tokens() {
        let (a, b) = (
            agent_preview_client("token-a"),
            agent_preview_client("token-b"),
        );
        assert_ne!(a, b);
        assert_eq!(a, agent_preview_client("token-a"));
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
                .args([
                    "-c:v",
                    "libx264",
                    "-preset",
                    "ultrafast",
                    "-pix_fmt",
                    "yuv420p",
                    "-c:a",
                    "aac",
                    "-shortest",
                ])
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

        let service = StudioService::start_on(root.clone(), Host::Service, 0)
            .await
            .unwrap();
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
            p["media"][0]["proxy"] == true
                && p["media"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .all(|m| m["waveform"].is_array())
        })
        .await;
        assert_eq!(
            project["revision"], revision,
            "derived state is not an edit"
        );
        assert!(project["media"][0]["waveform"]
            .as_array()
            .unwrap()
            .iter()
            .any(|v| v.as_f64().unwrap() > 0.0));
        assert!(
            project["media"][1].get("proxy").is_none(),
            "small H.264 plays as it is"
        );
        assert_eq!(rpc("history.status", json!({})).await["canUndo"], true);
        rpc("history.undo", json!({})).await;
        assert_eq!(
            rpc("history.status", json!({})).await["canUndo"],
            false,
            "only the import is undoable"
        );
        rpc("history.redo", json!({})).await;

        let served = proxy(&wide_id).await.unwrap();
        assert_eq!(served.status(), 206);
        assert_eq!(served.bytes().await.unwrap().len(), 16);
        assert_eq!(proxy(&small_id).await.unwrap().status(), 404);
        assert_eq!(proxy("unknown").await.unwrap().status(), 404);
        let unauthenticated = client
            .get(format!("{url}/assets/{wide_id}/proxy"))
            .send()
            .await
            .unwrap();
        assert_eq!(unauthenticated.status(), 401);
        let file = root.join("proxies").join(format!("{wide_id}.mp4"));
        let probed = media::probe_info(&file, &root).await.unwrap();
        assert_eq!(
            (probed["width"].as_u64(), probed["hasAudio"].as_bool()),
            (Some(1280), Some(true))
        );
        assert_eq!(
            std::fs::read(&wide).unwrap(),
            original,
            "the source is only read"
        );

        // Relinked to another file: the old proxy must not stand in for it.
        std::fs::remove_file(&wide).unwrap();
        rpc("media.relink", json!({"id":wide_id,"path":other})).await;
        for _ in 0..300 {
            let note =
                std::fs::read_to_string(root.join("proxies").join(format!("{wide_id}.source")));
            let shows_other = note.is_ok_and(|noted| {
                noted
                    .lines()
                    .next()
                    .is_some_and(|path| FsPath::new(path) == other)
            });
            if shows_other && file.is_file() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        let rebuilt = media::probe_info(&file, &root).await.unwrap();
        assert_eq!(
            rebuilt["height"].as_u64(),
            Some(1280),
            "the proxy shows the relinked file"
        );

        // Stopping the service stops the worker; unreferenced files go at the next start.
        std::fs::write(root.join("proxies/media-removed.mp4"), "x").unwrap();
        drop(service);
        let again = StudioService::start_on(root.clone(), Host::Service, 0)
            .await
            .unwrap();
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
            .args([
                "-v",
                "error",
                "-y",
                "-f",
                "lavfi",
                "-i",
                "sine=frequency=440:duration=1",
            ])
            .arg(&tone)
            .status()
            .unwrap();
        assert!(made.success());
        let tone = tone.canonicalize().unwrap();
        let editor = Arc::new(Mutex::new(Editor::new(root.clone()).unwrap()));
        editor
            .lock()
            .await
            .dispatch("media.import", json!({"paths":[tone]}))
            .await
            .unwrap();
        assert_eq!(editor.lock().await.pending_waveforms().len(), 1);

        let mut attempted = MediaWork::default();
        let undo_meanwhile = |_: PathBuf, _: f64| async {
            editor
                .lock()
                .await
                .dispatch("history.undo", json!({}))
                .await
                .unwrap();
            Some(vec![0.5])
        };
        assert!(waveform_work(&editor, &mut attempted, undo_meanwhile).await);
        editor
            .lock()
            .await
            .dispatch("history.redo", json!({}))
            .await
            .unwrap();
        assert_eq!(
            editor.lock().await.pending_waveforms().len(),
            1,
            "the dropped result was not kept"
        );

        let cancel = Arc::new(AtomicBool::new(false));
        assert!(media_work_step(&editor, &root, &cancel, &mut attempted).await);
        let project = editor
            .lock()
            .await
            .dispatch("project.get", json!({}))
            .await
            .unwrap();
        let peaks = project["media"][0]["waveform"]
            .as_array()
            .expect("waveform after redo");
        assert!(peaks.iter().any(|v| v.as_f64().unwrap() > 0.0));
        // Recorded now, so it is not decoded again.
        let never = |_: PathBuf, _: f64| async { panic!("decoded twice") };
        assert!(!waveform_work(&editor, &mut attempted, never).await);
        // A reprobe makes it pending again, and it is decoded in this same run.
        let id = project["media"][0]["id"].clone();
        editor
            .lock()
            .await
            .dispatch("media.reprobe", json!({"ids":[id]}))
            .await
            .unwrap();
        assert_eq!(editor.lock().await.pending_waveforms().len(), 1);
        let again = |_: PathBuf, _: f64| async { Some(vec![0.25]) };
        assert!(waveform_work(&editor, &mut attempted, again).await);
        let project = editor
            .lock()
            .await
            .dispatch("project.get", json!({}))
            .await
            .unwrap();
        assert_eq!(project["media"][0]["waveform"], json!([0.25]));
        std::fs::remove_dir_all(&root).unwrap();
        std::fs::remove_dir_all(&sources).unwrap();
    }
    /// A waveform that was decoded but could not be saved is saved again after a
    /// growing wait, without decoding again, and after three retries at a slow,
    /// steady pace until the save works.
    #[cfg(unix)]
    #[tokio::test]
    async fn a_waveform_that_cannot_be_saved_is_retried_with_backoff_then_slowly() {
        use std::os::unix::fs::PermissionsExt;
        let root = temp_root("waveform-backoff");
        let sources = temp_root("waveform-backoff-sources");
        std::fs::create_dir_all(&sources).unwrap();
        let tone = sources.join("tone.wav");
        let made = std::process::Command::new(media::executable("ffmpeg"))
            .args([
                "-v",
                "error",
                "-y",
                "-f",
                "lavfi",
                "-i",
                "sine=frequency=440:duration=1",
            ])
            .arg(&tone)
            .status()
            .unwrap();
        assert!(made.success());
        let tone = tone.canonicalize().unwrap();
        let editor = Arc::new(Mutex::new(Editor::new(root.clone()).unwrap()));
        editor
            .lock()
            .await
            .dispatch("media.import", json!({"paths":[tone]}))
            .await
            .unwrap();
        let writable = |on: bool| {
            let mode = if on { 0o700 } else { 0o500 };
            std::fs::set_permissions(root.join("projects"), std::fs::Permissions::from_mode(mode))
                .unwrap();
        };
        let decoded = std::sync::atomic::AtomicUsize::new(0);
        let decode = |_: PathBuf, _: f64| async {
            decoded.fetch_add(1, Ordering::SeqCst);
            Some(vec![0.5])
        };
        let delay = Duration::from_millis(40);
        let slow = Duration::from_millis(400);
        let mut work = MediaWork {
            retry_delay: delay,
            slow_retry: slow,
            ..MediaWork::default()
        };
        let waveform = || async {
            editor
                .lock()
                .await
                .dispatch("project.get", json!({}))
                .await
                .unwrap()["media"][0]["waveform"]
                .clone()
        };

        // The save fails: nothing is recorded and the retry waits its turn.
        writable(false);
        assert!(waveform_work(&editor, &mut work, decode).await);
        assert!(waveform().await.is_null());
        assert!(
            !waveform_work(&editor, &mut work, decode).await,
            "not before the wait is over"
        );
        assert!(work.next_retry().is_some_and(|wait| wait <= delay));
        // The disk is writable again: the kept peaks are saved, nothing is decoded twice.
        writable(true);
        tokio::time::sleep(delay + Duration::from_millis(10)).await;
        assert!(waveform_work(&editor, &mut work, decode).await);
        assert_eq!(waveform().await, json!([0.5]));
        assert_eq!(decoded.load(Ordering::SeqCst), 1);
        assert!(
            work.retries.is_empty() && work.attempted.is_empty() && work.next_retry().is_none()
        );

        // A save that keeps failing: the first try and three retries, each wait
        // twice the last, then one try per slow interval for as long as it takes.
        let id = editor
            .lock()
            .await
            .dispatch("project.get", json!({}))
            .await
            .unwrap()["media"][0]["id"]
            .clone();
        editor
            .lock()
            .await
            .dispatch("media.reprobe", json!({"ids":[id]}))
            .await
            .unwrap();
        writable(false);
        let mut waits = vec![];
        for failures in 1..=WAVEFORM_RETRIES {
            assert!(waveform_work(&editor, &mut work, decode).await);
            let wait = work.next_retry().expect("a retry is scheduled");
            assert_eq!(work.retries.values().next().unwrap().failures, failures);
            waits.push(wait);
            tokio::time::sleep(wait + Duration::from_millis(10)).await;
        }
        assert!(
            waits[1] > waits[0] + delay / 2 && waits[2] > waits[1] + delay,
            "{waits:?}"
        );
        assert!(
            waveform_work(&editor, &mut work, decode).await,
            "the last retry"
        );
        assert!(work.retries.len() == 1 && work.attempted.is_empty());
        let wait = work.next_retry().expect("still scheduled");
        assert!(wait > waits[2] && wait <= slow, "{wait:?} after {waits:?}");
        assert!(
            !waveform_work(&editor, &mut work, decode).await,
            "not before the slow wait is over"
        );
        tokio::time::sleep(wait + Duration::from_millis(10)).await;
        assert!(waveform_work(&editor, &mut work, decode).await);
        assert_eq!(work.next_retry().map(|wait| wait > slow / 2), Some(true));
        assert!(waveform().await.is_null());
        // The disk works again: the next slow try records the kept peaks.
        writable(true);
        tokio::time::sleep(slow + Duration::from_millis(10)).await;
        assert!(waveform_work(&editor, &mut work, decode).await);
        assert_eq!(waveform().await, json!([0.5]));
        assert!(work.retries.is_empty() && work.attempted.is_empty());
        assert_eq!(
            decoded.load(Ordering::SeqCst),
            2,
            "one decode per waveform, however often it is saved"
        );
        std::fs::remove_dir_all(&root).unwrap();
        std::fs::remove_dir_all(&sources).unwrap();
    }

    /// storage.usage reports the five folders; storage.clean deletes only what no
    /// project mentions and can be made again, and agents can call neither.
    #[tokio::test]
    async fn storage_is_reported_and_only_unreferenced_derived_files_are_cleaned() {
        let root = temp_root("storage");
        let service = StudioService::start_on(root.clone(), Host::Service, 0)
            .await
            .unwrap();
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
        // A caption to preview. The first frame empties what an earlier run left in
        // previews/ and renders/, so the test files are made after it.
        let project = rpc(
            "edit.add",
            json!({"text":{"content":"저장 공간"},"start":0.0,"duration":2.0}),
        )
        .await;
        let frame = rpc("preview.frame", json!({"time":0.5,"width":320})).await;
        let frame = PathBuf::from(frame["path"].as_str().unwrap());
        assert!(frame.is_file());
        // The open project uses media "media-open"; a stored one uses "media-stored".
        let mut stored = project.clone();
        stored["id"] = json!("project-stored");
        stored["media"] = json!([{"id":"media-stored","path":"/films/stored.mp4"}]);
        std::fs::write(
            root.join("projects/project-stored.json"),
            stored.to_string(),
        )
        .unwrap();
        for folder in STORAGE_FOLDERS {
            std::fs::create_dir_all(root.join(folder)).unwrap();
        }
        let touch = |relative: &str, bytes: usize| {
            let path = root.join(relative);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(&path, vec![b'x'; bytes]).unwrap();
            path
        };
        let kept = [
            touch("proxies/media-stored.mp4", 1000),
            touch("proxies/media-stored.source", 10),
            // Written to a moment ago: the worker may be building it.
            touch("proxies/.media-new.partial.mp4", 30),
            touch("imports/upload-a.mp4", 5000),
            touch("speech/job-1/voice.aiff", 700),
        ];
        let removed = [
            touch("proxies/media-gone.mp4", 2000),
            touch("proxies/media-gone.source", 20),
            touch("previews/preview-old.png", 300),
            touch("previews/preview-old/text-0.png", 40),
            touch("renders/export-old/filters.ffgraph", 50),
            // Left by a build that was killed: nothing has written to it for a while.
            touch("proxies/.media-gone.1.partial.mp4", 7),
        ];
        std::fs::File::options()
            .write(true)
            .open(&removed[5])
            .unwrap()
            .set_modified(std::time::SystemTime::now() - Duration::from_secs(600))
            .unwrap();
        let frame_bytes = std::fs::metadata(&frame).unwrap().len();

        let usage = rpc("storage.usage", json!({})).await;
        let folder =
            |report: &Value, name: &str, field: &str| report["folders"][name][field].as_u64();
        assert_eq!(folder(&usage, "proxies", "bytes"), Some(3067));
        assert_eq!(folder(&usage, "proxies", "files"), Some(6));
        assert_eq!(folder(&usage, "proxies", "reclaimableBytes"), Some(2027));
        assert_eq!(folder(&usage, "imports", "bytes"), Some(5000));
        assert_eq!(folder(&usage, "speech", "bytes"), Some(700));
        assert_eq!(folder(&usage, "renders", "reclaimableBytes"), Some(50));
        assert_eq!(folder(&usage, "previews", "bytes"), Some(340 + frame_bytes));
        assert_eq!(
            folder(&usage, "previews", "reclaimableBytes"),
            Some(340),
            "the shown frame is in use"
        );
        assert_eq!(
            usage["bytes"].as_u64(),
            Some(3067 + 5000 + 700 + 50 + 340 + frame_bytes)
        );
        assert_eq!(usage["reclaimableBytes"].as_u64(), Some(2027 + 50 + 340));
        for name in ["imports", "speech"] {
            assert_eq!(usage["folders"][name]["cleanable"], false);
            assert!(usage["folders"][name].get("reclaimableBytes").is_none());
        }
        assert!(
            removed.iter().all(|path| path.exists()),
            "reporting deletes nothing"
        );

        // Agents can neither read nor clean the store.
        let token = service
            .runtime
            .as_ref()
            .unwrap()
            .issue_agent_token(project["id"].as_str().unwrap());
        for method in ["storage.usage", "storage.clean"] {
            let refused = client
                .post(format!("{url}/rpc"))
                .bearer_auth(&token)
                .json(&json!({"method":method,"params":{}}))
                .send()
                .await
                .unwrap();
            assert_eq!(refused.status(), 403, "{method}");
            assert!(!agent_methods().contains(method));
        }

        let cleaned = rpc("storage.clean", json!({})).await;
        assert_eq!(cleaned["removedBytes"].as_u64(), Some(2027 + 50 + 340));
        assert_eq!(folder(&cleaned, "proxies", "removedFiles"), Some(3));
        assert_eq!(folder(&cleaned, "proxies", "bytes"), Some(1040));
        assert_eq!(folder(&cleaned, "imports", "bytes"), Some(5000));
        assert_eq!(folder(&cleaned, "speech", "bytes"), Some(700));
        for path in &removed {
            assert!(!path.exists(), "{path:?} was kept");
        }
        assert!(
            !root.join("previews/preview-old").exists()
                && !root.join("renders/export-old").exists()
        );
        for path in kept.iter().chain([&frame]) {
            assert!(path.is_file(), "{path:?} was removed");
        }
        // The cached frame is still served from the cache, and nothing is left to clean.
        let again = rpc("preview.frame", json!({"time":0.5,"width":320})).await;
        assert_eq!(again["cacheHit"], true);
        assert_eq!(
            rpc("storage.usage", json!({})).await["reclaimableBytes"].as_u64(),
            Some(0)
        );
        drop(service);
        std::fs::remove_dir_all(&root).unwrap();
    }

    /// Empty projects that pile up under a default name are counted by storage.usage
    /// and deleted only when storage.clean is asked for them: never the open one,
    /// one with a name of its own, one that holds something or one that was edited.
    #[tokio::test]
    async fn empty_unnamed_projects_are_counted_and_removed_only_when_asked() {
        let state = upload_fixture();
        let root = state.root.clone();
        // One made the way the app makes it: `project.new` after two edits, then
        // left for a named project. Its revision is past 0 though nothing is in it.
        for patch in [
            json!({"background":"#222222"}),
            json!({"background":"#111111"}),
        ] {
            let (status, edited) = call(
                &state,
                "test",
                json!({"method":"project.update","params":{"patch":patch}}),
            )
            .await;
            assert_eq!(status, StatusCode::OK, "{edited}");
        }
        let (_, made) = call(&state, "test", json!({"method":"project.new"})).await;
        assert!(made["result"]["revision"].as_u64().unwrap() >= 3, "{made}");
        let made = made["result"]["id"].as_str().unwrap().to_owned();
        let (_, open) = call(
            &state,
            "test",
            json!({"method":"project.new","params":{"name":"열린 프로젝트"}}),
        )
        .await;
        let open = open["result"]["id"].as_str().unwrap().to_owned();
        assert_ne!(open, made);
        let store = |id: &str, change: &dyn Fn(&mut Value)| {
            let mut project = crate::editor::empty_project("새 프로젝트", 1920, 1080, 30.0);
            project["id"] = json!(id);
            change(&mut project);
            let file = root.join(format!("projects/{id}.json"));
            std::fs::write(&file, project.to_string()).unwrap();
            file
        };
        let empty = [
            store("project-empty-a", &|_| {}),
            store("project-empty-b", &|p| {
                p["name"] = json!("이름 없는 프로젝트");
                p["width"] = json!(1080);
                p["height"] = json!(1920);
            }),
            // An edit that was undone leaves a revision and nothing else.
            store("project-undone", &|p| p["revision"] = json!(4)),
            root.join(format!("projects/{made}.json")),
        ];
        let kept = [
            store("project-named", &|p| p["name"] = json!("여행")),
            store(
                "project-with-clip",
                &|p| p["clips"] = json!([{"id":"clip-1","kind":"text","trackId":"text-1","start":0.0,"duration":1.0,"text":{"content":"자막"}}]),
            ),
            store("project-with-note", &|p| {
                p["notes"] = json!([{"id":"n","text":"메모"}])
            }),
            root.join(format!("projects/{open}.json")),
        ];
        let empty_bytes: u64 = empty
            .iter()
            .map(|file| std::fs::metadata(file).unwrap().len())
            .sum();

        let (status, usage) = call(&state, "test", json!({"method":"storage.usage"})).await;
        assert_eq!(status, StatusCode::OK, "{usage}");
        assert_eq!(
            usage["result"]["emptyProjects"],
            json!({"count":4,"bytes":empty_bytes})
        );
        // Cleaning the derived files, the default, leaves every project alone.
        let (_, cleaned) = call(&state, "test", json!({"method":"storage.clean"})).await;
        assert_eq!(cleaned["result"]["emptyProjects"]["count"], 4);
        assert!(cleaned["result"]["emptyProjects"].get("removed").is_none());
        assert!(empty.iter().chain(&kept).all(|file| file.is_file()));
        let (status, refused) = call(
            &state,
            "test",
            json!({"method":"storage.clean","params":{"targets":["projects"]}}),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{refused}");
        assert!(empty.iter().chain(&kept).all(|file| file.is_file()));

        // Asked for, the empty ones go and nothing else does: no derived file either.
        std::fs::create_dir_all(root.join("renders/export-old")).unwrap();
        std::fs::write(root.join("renders/export-old/filters.ffgraph"), "x").unwrap();
        let (status, cleaned) = call(
            &state,
            "test",
            json!({"method":"storage.clean","params":{"targets":["emptyProjects"]}}),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{cleaned}");
        assert_eq!(
            cleaned["result"]["emptyProjects"],
            json!({"count":0,"bytes":0,"removed":4,"removedBytes":empty_bytes})
        );
        assert_eq!(cleaned["result"]["removedBytes"], 0);
        assert!(root.join("renders/export-old/filters.ffgraph").is_file());
        assert!(empty.iter().all(|file| !file.exists()));
        assert!(kept.iter().all(|file| file.is_file()));
        let (_, list) = call(&state, "test", json!({"method":"project.list"})).await;
        assert_eq!(list["result"].as_array().unwrap().len(), kept.len());
        // Both together.
        let (_, cleaned) = call(
            &state,
            "test",
            json!({"method":"storage.clean","params":{"targets":["temporary","emptyProjects"]}}),
        )
        .await;
        assert_eq!(cleaned["result"]["emptyProjects"]["removed"], 0);
        assert!(!root.join("renders/export-old").exists());
        std::fs::remove_dir_all(&root).unwrap();
    }

    /// `proxies/` is kept within its limit: the proxies used longest ago go first,
    /// those of the open project never, and no limit removes nothing.
    #[tokio::test]
    async fn proxies_over_the_limit_are_removed_least_recently_used_first() {
        let state = upload_fixture();
        let root = state.root.clone();
        let (_, project) = call(&state, "test", json!({"method":"project.get"})).await;
        let mut project = project["result"].clone();
        project["media"] = json!([
            {"id":"media-open","name":"a.mp4","path":"/nonexistent/a.mp4","kind":"video","duration":1.0,"width":3840,"height":2160,"hasAudio":false},
            {"id":"media-open-old","name":"b.mp4","path":"/nonexistent/b.mp4","kind":"video","duration":1.0,"width":3840,"height":2160,"hasAudio":false}]);
        let file = root.join("exports/with-media.json");
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        std::fs::write(&file, project.to_string()).unwrap();
        let (status, opened) = call(
            &state,
            "test",
            json!({"method":"project.open","params":{"path":file}}),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{opened}");
        std::fs::create_dir_all(root.join("proxies")).unwrap();
        let day = Duration::from_secs(24 * 3600);
        let proxy = |id: &str, bytes: usize, days_ago: u32| {
            let path = root.join(format!("proxies/{id}.mp4"));
            std::fs::write(&path, vec![b'x'; bytes]).unwrap();
            let note = media::proxy_source_note(&path);
            std::fs::write(&note, format!("/nonexistent/{id}.mp4")).unwrap();
            std::fs::File::options()
                .write(true)
                .open(&note)
                .unwrap()
                .set_modified(std::time::SystemTime::now() - day * days_ago)
                .unwrap();
            path
        };
        let note_bytes = |id: &str| format!("/nonexistent/{id}.mp4").len() as u64;
        // The open project's, one of them not used for a long time.
        let open = [
            proxy("media-open", 4000, 0),
            proxy("media-open-old", 4000, 90),
        ];
        let oldest = proxy("media-oldest", 3000, 60);
        let older = proxy("media-older", 3000, 30);
        let newer = proxy("media-newer", 3000, 2);
        // Being written: neither counted nor removed.
        let partial = root.join("proxies/.media-open.x.partial.mp4");
        std::fs::write(&partial, vec![b'x'; 50_000]).unwrap();
        let editor = state.editor.clone();
        let mut work = MediaWork::default();

        // Within the default limit, and without a limit: all stay.
        tend_proxies(&editor, &root, &mut work).await;
        work.proxy_limit.store(0, Ordering::Relaxed);
        tend_proxies(&editor, &root, &mut work).await;
        for path in open.iter().chain([&oldest, &older, &newer, &partial]) {
            assert!(path.is_file(), "{path:?}");
        }
        // Looking after them marked the open project's as used now.
        let used = |path: &PathBuf| {
            std::fs::metadata(media::proxy_source_note(path))
                .unwrap()
                .modified()
                .unwrap()
                .elapsed()
                .unwrap()
        };
        assert!(used(&open[1]) < day && used(&oldest) > day * 59);
        assert_eq!(
            std::fs::read_to_string(media::proxy_source_note(&open[1])).unwrap(),
            "/nonexistent/media-open-old.mp4",
            "the note still says what the proxy was made from"
        );

        // 17 kB and the notes are there; 12 kB may stay: the two used longest ago go.
        let all = 17_000
            + [
                "media-open",
                "media-open-old",
                "media-oldest",
                "media-older",
                "media-newer",
            ]
            .map(note_bytes)
            .iter()
            .sum::<u64>();
        work.proxy_limit.store(
            all - 3000 - note_bytes("media-oldest") - 1,
            Ordering::Relaxed,
        );
        tend_proxies(&editor, &root, &mut work).await;
        assert!(!oldest.exists() && !media::proxy_source_note(&oldest).exists());
        assert!(!older.exists() && !media::proxy_source_note(&older).exists());
        for path in open.iter().chain([&newer, &partial]) {
            assert!(path.is_file(), "{path:?}");
        }
        // Nothing changed since: not looked at again until something does.
        let stray = proxy("media-stray", 9000, 10);
        tend_proxies(&editor, &root, &mut work).await;
        assert!(stray.is_file());
        // A limit below what the open project alone needs removes every other proxy
        // and none of its own.
        work.proxy_limit.store(1, Ordering::Relaxed);
        tend_proxies(&editor, &root, &mut work).await;
        assert!(!stray.exists() && !newer.exists());
        assert!(open.iter().all(|path| path.is_file()) && partial.is_file());
        // The open project keeps (and gets) its proxies over the limit; the usage
        // report says so, and how much of the folder is the open project's.
        let kept = 8000 + note_bytes("media-open") + note_bytes("media-open-old");
        for (limit, over) in [(1, true), (kept - 1, true), (kept, false), (0, false)] {
            state.proxy_limit.store(limit, Ordering::Relaxed);
            let (_, usage) = call(&state, "test", json!({"method":"storage.usage"})).await;
            let usage = &usage["result"];
            assert_eq!(usage["proxyOverLimit"], over, "{limit}: {usage}");
            assert_eq!(
                usage["proxyBytes"], kept,
                "the unfinished one is not counted"
            );
            assert_eq!(usage["proxyOpenProjectBytes"], kept);
        }
        let other = proxy("media-other", 1000, 1);
        let (_, usage) = call(&state, "test", json!({"method":"storage.usage"})).await;
        assert_eq!(
            usage["result"]["proxyBytes"],
            kept + 1000 + note_bytes("media-other")
        );
        assert_eq!(usage["result"]["proxyOpenProjectBytes"], kept);
        std::fs::remove_file(media::proxy_source_note(&other)).unwrap();
        std::fs::remove_file(&other).unwrap();
        state
            .proxy_limit
            .store(DEFAULT_PROXY_LIMIT, Ordering::Relaxed);

        // Another project is opened: the proxies of the one left may go now.
        call(
            &state,
            "test",
            json!({"method":"project.new","params":{"name":"다른 프로젝트"}}),
        )
        .await;
        tend_proxies(&editor, &root, &mut work).await;
        assert!(open.iter().all(|path| !path.exists()));
        assert!(partial.is_file());

        // The limit is set through the service, saved, reported and kept by a restart.
        let (status, set) = call(
            &state,
            "test",
            json!({"method":"storage.configure","params":{"proxyLimitBytes":5_000_000_000u64}}),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{set}");
        assert_eq!(set["result"]["proxyLimitBytes"], 5_000_000_000u64);
        assert_eq!(state.proxy_limit.load(Ordering::Relaxed), 5_000_000_000);
        assert_eq!(saved_proxy_limit(&root), 5_000_000_000);
        let (_, usage) = call(&state, "test", json!({"method":"storage.usage"})).await;
        assert_eq!(usage["result"]["proxyLimitBytes"], 5_000_000_000u64);
        for wrong in [
            json!({}),
            json!({"proxyLimitBytes":-1}),
            json!({"proxyLimitBytes":"1GB"}),
        ] {
            let (status, _) = call(
                &state,
                "test",
                json!({"method":"storage.configure","params":wrong}),
            )
            .await;
            assert_eq!(status, StatusCode::BAD_REQUEST);
        }
        assert_eq!(saved_proxy_limit(&root), 5_000_000_000);
        let token = state.runtime.issue_agent_token("any");
        let (status, _) = call(
            &state,
            &token,
            json!({"method":"storage.configure","params":{"proxyLimitBytes":1}}),
        )
        .await;
        assert_eq!(status, StatusCode::FORBIDDEN);
        assert_eq!(
            saved_proxy_limit(&temp_root("no-settings")),
            DEFAULT_PROXY_LIMIT
        );
        std::fs::remove_dir_all(&root).unwrap();
    }

    /// A frame that its own client replaced or stopped is answered as a result, not
    /// as a failed request: `{cancelled:true}` with HTTP 200. `preview.cancel` stops
    /// one client's frames only, and agents cannot call it.
    #[tokio::test]
    async fn a_replaced_or_stopped_frame_is_answered_as_a_result() {
        let state = upload_fixture();
        let (status, project) = call(
            &state,
            "test",
            json!({"method":"edit.add","params":{"text":{"content":"미리보기"},"start":0.0,"duration":4.0}}),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{project}");
        let frame = |time: f64, client: &'static str| {
            let state = state.clone();
            tokio::spawn(async move {
                call(
                    &state,
                    "test",
                    json!({"method":"preview.frame","params":{"time":time,"width":320,"client":client}}),
                )
                .await
            })
        };
        let waiting = async |count: usize| {
            let deadline = std::time::Instant::now() + Duration::from_secs(10);
            while state.previews.waiting() != count {
                assert!(std::time::Instant::now() < deadline, "never queued");
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        };
        // The renderer is busy, so the requests below stay queued until it is let go.
        let (release, released) = tokio::sync::oneshot::channel::<()>();
        let busy = {
            let previews = state.previews.clone();
            tokio::spawn(async move {
                previews
                    .while_idle(async move |_| {
                        let _ = released.await;
                    })
                    .await
            })
        };
        tokio::time::sleep(Duration::from_millis(50)).await;
        let replaced = frame(0.5, "player");
        waiting(1).await;
        let newest = frame(1.5, "player");
        waiting(2).await;
        let stopped = frame(2.5, "export");
        waiting(3).await;
        // Another client has nothing to stop; the export dialog stops its one frame.
        let cancel = async |client: &str| {
            call(
                &state,
                "test",
                json!({"method":"preview.cancel","params":{"client":client}}),
            )
            .await
        };
        assert_eq!(cancel("other").await.1["result"], json!({"cancelled":0}));
        assert_eq!(
            cancel("export").await,
            (StatusCode::OK, json!({"result":{"cancelled":1}}))
        );
        release.send(()).unwrap();
        busy.await.unwrap();
        for ended in [replaced, stopped] {
            let (status, body) = ended.await.unwrap();
            assert_eq!(status, StatusCode::OK, "{body}");
            assert_eq!(body["result"]["cancelled"], true);
            assert!(body["result"]["reason"]
                .as_str()
                .unwrap()
                .contains("PREVIEW_CANCELLED"));
            assert!(body.get("error").is_none() && body["result"].get("assetId").is_none());
        }
        let (status, shown) = newest.await.unwrap();
        assert_eq!(status, StatusCode::OK, "{shown}");
        assert!(shown["result"]["assetId"].is_string(), "{shown}");
        assert!(shown["result"].get("cancelled").is_none());
        // A frame asked for a revision the project has left is answered the same way.
        let (status, stale) = call(
            &state,
            "test",
            json!({"method":"preview.frame","params":{"time":0.5,"expectedRevision":99}}),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{stale}");
        assert_eq!(stale["result"]["cancelled"], true);
        assert!(stale["result"]["reason"]
            .as_str()
            .unwrap()
            .contains("REVISION_CONFLICT"));
        // A real failure is still an error.
        let (status, failed) = call(
            &state,
            "test",
            json!({"method":"preview.frame","params":{"time":0.5,"expectedRevision":"soon"}}),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{failed}");
        let token = state
            .runtime
            .issue_agent_token(project["result"]["id"].as_str().unwrap());
        let (status, _) = call(&state, &token, json!({"method":"preview.cancel"})).await;
        assert_eq!(status, StatusCode::FORBIDDEN);
        std::fs::remove_dir_all(&state.root).unwrap();
    }

    /// The project list can show the cover of a project that is not open.
    #[tokio::test]
    async fn project_covers_are_served_for_projects_that_are_not_open() {
        let root = temp_root("covers");
        let sources = temp_root("covers-sources");
        std::fs::create_dir_all(&sources).unwrap();
        let clip = sources.join("clip.mp4");
        let made = std::process::Command::new(media::executable("ffmpeg"))
            .args([
                "-v",
                "error",
                "-y",
                "-f",
                "lavfi",
                "-i",
                "testsrc=size=320x180:rate=10:duration=1",
            ])
            .args([
                "-c:v",
                "libx264",
                "-preset",
                "ultrafast",
                "-pix_fmt",
                "yuv420p",
            ])
            .arg(&clip)
            .status()
            .unwrap();
        assert!(made.success());
        let service = StudioService::start_on(root.clone(), Host::Service, 0)
            .await
            .unwrap();
        let url = service.connection.url.clone();
        let token = service.connection.token.clone();
        let client = reqwest::Client::new();
        let rpc = |method: &str, params: Value| {
            let request = client
                .post(format!("{url}/rpc"))
                .bearer_auth(&token)
                .json(&json!({"method":method,"params":params}));
            async move {
                let body: Value = request.send().await.unwrap().json().await.unwrap();
                assert!(body.get("error").is_none(), "{body}");
                body["result"].clone()
            }
        };
        let with_cover = rpc(
            "media.importAndAdd",
            json!({"paths":[clip.canonicalize().unwrap()]}),
        )
        .await;
        let id = with_cover["id"].as_str().unwrap().to_owned();
        let media_id = with_cover["media"][0]["id"].as_str().unwrap().to_owned();
        let empty = rpc("project.new", json!({"name":"빈 프로젝트"})).await;
        let empty_id = empty["id"].as_str().unwrap().to_owned();
        assert_ne!(id, empty_id, "the project with the cover is no longer open");
        let list = rpc("project.list", json!({})).await;
        let listed = list
            .as_array()
            .unwrap()
            .iter()
            .find(|p| p["id"] == id.as_str())
            .unwrap();
        assert_eq!(listed["thumbnail"]["mediaId"], media_id.as_str());

        let get = |path: String, authorized: bool| {
            let request = client.get(format!("{url}{path}"));
            let request = if authorized {
                request.bearer_auth(&token)
            } else {
                request
            };
            async move { request.send().await.unwrap() }
        };
        let expected =
            std::fs::read(with_cover["media"][0]["thumbnail"].as_str().unwrap()).unwrap();
        for path in [
            format!("/projects/{id}/thumbnail?media={media_id}"),
            format!("/projects/{id}/thumbnail"),
        ] {
            let served = get(path.clone(), true).await;
            assert_eq!(served.status(), 200, "{path}");
            assert_eq!(served.headers()["content-type"], "image/jpeg");
            assert_eq!(served.bytes().await.unwrap().to_vec(), expected);
            assert_eq!(get(path, false).await.status(), 401);
        }
        // An <img> cannot send a header: the token may come in the query, as for assets.
        let by_query = get(
            format!("/projects/{id}/thumbnail?media={media_id}&token={token}"),
            false,
        )
        .await;
        assert_eq!(by_query.status(), 200);
        assert_eq!(
            get(format!("/projects/{id}/thumbnail?token=wrong"), false)
                .await
                .status(),
            401
        );
        for path in [
            format!("/projects/{id}/thumbnail?media=media-unknown"),
            format!("/projects/{empty_id}/thumbnail"),
            "/projects/project-unknown/thumbnail".to_owned(),
            "/projects/..%2Fcurrent/thumbnail".to_owned(),
        ] {
            assert_eq!(get(path.clone(), true).await.status(), 404, "{path}");
        }
        drop(service);
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
            proxy_in_progress: ProxyInProgress::default(),
            proxy_limit: Arc::new(AtomicU64::new(DEFAULT_PROXY_LIMIT)),
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
    /// An upload answers with the project like an RPC does: with `omitWaveforms` the
    /// media name their waveforms instead of carrying them.
    #[tokio::test]
    async fn uploads_leave_the_waveforms_out_when_asked() {
        let state = upload_fixture();
        let (_, project) = call(&state, "test", json!({"method":"project.get"})).await;
        let mut project = project["result"].clone();
        project["media"] = json!([{"id":"media-tone","name":"tone.wav","path":"/nonexistent/tone.wav","kind":"audio","duration":1.0,"width":0,"height":0,"hasAudio":true,"waveform":[0.5,0.25]}]);
        let file = state.root.join("exports/with-waveform.json");
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        std::fs::write(&file, project.to_string()).unwrap();
        let (_, opened) = call(
            &state,
            "test",
            json!({"method":"project.open","params":{"path":file}}),
        )
        .await;
        let id = opened["result"]["id"].as_str().unwrap().to_owned();
        let srt = "1\n00:00:00,000 --> 00:00:01,000\nUpload test\n";
        let mut replies = vec![];
        for slim in [None, Some("true"), Some("1"), Some("false")] {
            let mut query = HashMap::from([
                ("name".to_owned(), "captions.srt".to_owned()),
                ("projectId".to_owned(), id.clone()),
            ]);
            if let Some(slim) = slim {
                query.insert("omitWaveforms".into(), slim.into());
            }
            let response = upload(
                State(state.clone()),
                upload_headers(),
                Query(query),
                Body::from(srt),
            )
            .await;
            assert_eq!(response.status(), StatusCode::OK);
            let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
                .await
                .unwrap();
            let reply: Value = serde_json::from_slice(&bytes).unwrap();
            replies.push(reply["result"]["media"][0].clone());
        }
        for full in [&replies[0], &replies[3]] {
            assert_eq!(full["waveform"], json!([0.5, 0.25]));
            assert!(full.get("waveformId").is_none(), "{full}");
        }
        for slim in [&replies[1], &replies[2]] {
            assert!(slim.get("waveform").is_none(), "{slim}");
            assert_eq!(slim["waveformPeaks"], 2);
            assert!(slim["waveformId"].is_string());
        }
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
