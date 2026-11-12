#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use byori_studio::service::{Connection, Host, StudioService};
use tauri::Manager;

#[tauri::command]
fn studio_connection(state: tauri::State<'_, Connection>) -> Connection {
    state.inner().clone()
}

#[tauri::command]
async fn studio_open_files(extensions: Option<Vec<String>>) -> Vec<String> {
    let extensions = extensions.unwrap_or_else(|| {
        [
            "mp4", "mov", "mkv", "webm", "avi", "mp3", "wav", "m4a", "aac", "flac", "png", "jpg",
            "jpeg", "webp", "gif", "srt", "cube", "3dl",
        ]
        .into_iter()
        .map(String::from)
        .collect()
    });
    rfd::AsyncFileDialog::new()
        .add_filter("파일", &extensions)
        .pick_files()
        .await
        .unwrap_or_default()
        .into_iter()
        .map(|f| f.path().to_string_lossy().to_string())
        .collect()
}

#[tauri::command]
async fn studio_save_file(name: String, extension: Option<String>) -> Option<String> {
    let mut dialog = rfd::AsyncFileDialog::new().set_file_name(&name);
    if let Some(ext) = extension {
        dialog = dialog.add_filter("파일", &[&ext]);
    }
    dialog
        .save_file()
        .await
        .map(|f| f.path().to_string_lossy().to_string())
}

/// Shows a file the app wrote (an export) in Finder. Only an existing file with an
/// absolute path is shown; nothing is opened or run, and the path is passed as one
/// argument, never through a shell.
#[tauri::command]
async fn studio_reveal_file(path: String) -> Result<(), String> {
    let file = std::path::PathBuf::from(&path);
    if !file.is_absolute() || !file.is_file() {
        return Err("파일을 찾을 수 없습니다. 이동했거나 삭제되었을 수 있습니다.".into());
    }
    #[cfg(target_os = "macos")]
    let mut command = {
        let mut command = std::process::Command::new("/usr/bin/open");
        command.arg("-R").arg(&file);
        command
    };
    #[cfg(target_os = "windows")]
    let mut command = {
        let mut command = std::process::Command::new("explorer");
        command.arg(format!("/select,{}", file.display()));
        command
    };
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    let mut command = {
        let mut command = std::process::Command::new("xdg-open");
        command.arg(file.parent().unwrap_or(&file));
        command
    };
    let shown = tauri::async_runtime::spawn_blocking(move || command.status())
        .await
        .map_err(|error| error.to_string())?;
    match shown {
        // Explorer reports 1 even when it shows the file.
        Ok(status) if status.success() || cfg!(target_os = "windows") => Ok(()),
        Ok(_) => Err("파일 위치를 열지 못했습니다.".into()),
        Err(error) => Err(format!("파일 위치를 열지 못했습니다: {error}")),
    }
}

/// Self-diagnosis for a window nobody can look at (no screen recording permission):
/// the webview inspects its own rendered state and this shell writes the findings to
/// the file named by `BYORI_STUDIO_SELFTEST`, then quits.
///
/// Without that variable none of this is attached: no script is injected, the report
/// route does not exist, and no command is added to the IPC surface either way.
mod self_test {
    use std::borrow::Cow;
    use std::path::{Path, PathBuf};
    use std::sync::{Arc, Mutex};
    use std::time::Duration;
    use tauri::http::{header::CONTENT_TYPE, HeaderValue, Method, StatusCode};

    use tauri::Manager;

    const REPORT_PATH: &str = "/__selftest/report";
    /// What the native window really is (sizes, focus) and where an export may be written.
    const WINDOW_PATH: &str = "/__selftest/window";
    /// `?w=<logical>&h=<logical>`: the diagnosis measures the layout at several window sizes.
    const RESIZE_PATH: &str = "/__selftest/resize";
    const DEFAULT_TIMEOUT_SECS: u64 = 240;

    /// A window that is behind another one is "hidden" to WebKit: animation frames stop
    /// and the playback clock cannot be checked. An app started by a background process
    /// is not brought forward by macOS, so the diagnosis raises its own window.
    pub fn bring_forward<R: tauri::Runtime>(window: &tauri::WebviewWindow<R>) {
        for (step, done) in [
            ("always_on_top", window.set_always_on_top(true)),
            ("show", window.show()),
            ("set_focus", window.set_focus()),
        ] {
            if let Err(error) = done {
                tracing::warn!("자가 진단 창을 앞으로 가져오지 못했습니다 ({step}): {error}");
            }
        }
    }

    fn window_state<R: tauri::Runtime>(handle: &tauri::AppHandle<R>) -> serde_json::Value {
        let Some(window) = handle.get_webview_window("main") else {
            return serde_json::json!({ "present": false });
        };
        let scale = window.scale_factor().unwrap_or(1.0);
        let logical = |size: tauri::Result<tauri::PhysicalSize<u32>>| {
            size.ok().map(|size| {
                let size = size.to_logical::<f64>(scale);
                serde_json::json!({ "width": size.width, "height": size.height })
            })
        };
        let monitor = window.current_monitor().ok().flatten().map(|monitor| {
            let size = monitor.size().to_logical::<f64>(monitor.scale_factor());
            serde_json::json!({
                "width": size.width,
                "height": size.height,
                "scaleFactor": monitor.scale_factor(),
            })
        });
        let exports = byori_studio::service::data_root().join("exports");
        let configured = handle.config().app.windows.first().map(|window| {
            serde_json::json!({
                "width": window.width,
                "height": window.height,
                "minWidth": window.min_width,
                "minHeight": window.min_height,
            })
        });
        serde_json::json!({
            "present": true,
            "configured": configured,
            "scaleFactor": scale,
            "inner": logical(window.inner_size()),
            "outer": logical(window.outer_size()),
            "visible": window.is_visible().ok(),
            "focused": window.is_focused().ok(),
            "minimized": window.is_minimized().ok(),
            "alwaysOnTop": window.is_always_on_top().ok(),
            "monitor": monitor,
            "exportDir": std::fs::create_dir_all(&exports).is_ok().then_some(exports),
        })
    }

    fn resize<R: tauri::Runtime>(handle: &tauri::AppHandle<R>, query: &str) -> bool {
        let number = |name: &str| {
            query
                .split('&')
                .filter_map(|pair| pair.split_once('='))
                .find(|(key, _)| *key == name)
                .and_then(|(_, value)| value.parse::<f64>().ok())
                .filter(|value| (320.0..=8192.0).contains(value))
        };
        let (Some(width), Some(height), Some(window)) =
            (number("w"), number("h"), handle.get_webview_window("main"))
        else {
            return false;
        };
        // Not from inside the request callback: the resize re-enters the webview's layout.
        std::thread::spawn(move || {
            if let Err(error) = window.set_size(tauri::LogicalSize::new(width, height)) {
                tracing::warn!("자가 진단 창 크기를 바꾸지 못했습니다: {error}");
            }
        });
        true
    }

    /// Runs before any page script, so violations and errors during the first load are kept.
    const COLLECTOR: &str = r#"(function () {
  if (window.top !== window || window.__BYORI_SELFTEST__) return;
  var clean = function (v) { return String(v == null ? "" : v).replace(/token=[^&#]+/g, "token=REDACTED").slice(0, 300); };
  var c = { csp: [], errors: [], rejections: [] };
  Object.defineProperty(window, "__BYORI_SELFTEST__", { value: c });
  document.addEventListener("securitypolicyviolation", function (e) {
    c.csp.push({ directive: e.violatedDirective, effective: e.effectiveDirective, blocked: clean(e.blockedURI), source: clean(e.sourceFile), line: e.lineNumber, sample: clean(e.sample), disposition: e.disposition });
  });
  window.addEventListener("error", function (e) {
    var t = e.target;
    if (t && t !== window && t.tagName) c.errors.push({ kind: "resource", tag: t.tagName.toLowerCase(), url: clean(t.currentSrc || t.src || t.href) });
    else c.errors.push({ kind: "script", message: clean(e.message), source: clean(e.filename), line: e.lineno, column: e.colno });
  }, true);
  window.addEventListener("unhandledrejection", function (e) {
    var r = e.reason;
    c.rejections.push({ message: clean(r && r.message ? r.message : r), stack: clean(r && r.stack) });
  });
})();"#;

    /// The output file, when this run is a self-diagnosis.
    pub fn target() -> Option<PathBuf> {
        std::env::var_os("BYORI_STUDIO_SELFTEST")
            .filter(|value| !value.is_empty())
            .map(PathBuf::from)
    }

    #[derive(Default)]
    struct Progress {
        report: Option<serde_json::Value>,
        received: u32,
        finished: bool,
    }

    fn write(path: &Path, value: &serde_json::Value) {
        let text = serde_json::to_string_pretty(value).unwrap_or_else(|_| "{}".into());
        let partial = path.with_extension("json.partial");
        if std::fs::write(&partial, text)
            .and_then(|()| std::fs::rename(&partial, path))
            .is_err()
        {
            tracing::error!("자가 진단 결과를 {} 에 쓰지 못했습니다", path.display());
        }
    }

    /// A startup failure has no window to report through.
    pub fn startup_failure(path: &Path, message: &str) {
        write(
            path,
            &serde_json::json!({ "final": true, "timedOut": false, "startupError": message, "report": null }),
        );
    }

    pub fn attach<'a, R: tauri::Runtime>(
        builder: tauri::WebviewWindowBuilder<'a, R, tauri::AppHandle<R>>,
        handle: tauri::AppHandle<R>,
        path: PathBuf,
    ) -> tauri::WebviewWindowBuilder<'a, R, tauri::AppHandle<R>> {
        let progress = Arc::new(Mutex::new(Progress::default()));
        let timeout = std::env::var("BYORI_STUDIO_SELFTEST_TIMEOUT")
            .ok()
            .and_then(|value| value.parse().ok())
            .unwrap_or(DEFAULT_TIMEOUT_SECS);
        {
            // A locked screen can freeze the webview's timers; what arrived so far is still kept.
            let (progress, handle, path) = (progress.clone(), handle.clone(), path.clone());
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_secs(timeout));
                let mut state = progress.lock().unwrap_or_else(|e| e.into_inner());
                if state.finished {
                    return;
                }
                state.finished = true;
                write(
                    &path,
                    &serde_json::json!({
                        "final": false,
                        "timedOut": true,
                        "timeoutSeconds": timeout,
                        "receivedReports": state.received,
                        "report": state.report,
                    }),
                );
                drop(state);
                handle.exit(2);
            });
        }
        builder
            .initialization_script(COLLECTOR)
            .on_web_resource_request(move |request, response| {
                if request.method() != Method::POST {
                    return;
                }
                let answer = match request.uri().path() {
                    WINDOW_PATH => Some(window_state(&handle)),
                    RESIZE_PATH => Some(serde_json::json!({
                        "accepted": resize(&handle, request.uri().query().unwrap_or_default()),
                    })),
                    _ => None,
                };
                if let Some(answer) = answer {
                    *response.status_mut() = StatusCode::OK;
                    response
                        .headers_mut()
                        .insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
                    *response.body_mut() = Cow::Owned(answer.to_string().into_bytes());
                    return;
                }
                if request.uri().path() != REPORT_PATH {
                    return;
                }
                let last = request.uri().query().is_some_and(|q| q.contains("final=1"));
                let body = request.body();
                let mut state = progress.lock().unwrap_or_else(|e| e.into_inner());
                if state.finished {
                    return;
                }
                state.received += 1;
                let parsed = serde_json::from_slice::<serde_json::Value>(body);
                let mut output = serde_json::json!({
                    "final": last,
                    "timedOut": false,
                    "receivedReports": state.received,
                    "bodyBytes": body.len(),
                });
                match parsed {
                    Ok(report) => state.report = Some(report),
                    Err(error) => output["bodyError"] = error.to_string().into(),
                }
                output["report"] = state.report.clone().unwrap_or_default();
                write(&path, &output);
                *response.status_mut() = StatusCode::OK;
                response
                    .headers_mut()
                    .insert(CONTENT_TYPE, HeaderValue::from_static("text/plain"));
                *response.body_mut() = Cow::Borrowed(b"ok");
                if last {
                    state.finished = true;
                    drop(state);
                    handle.exit(0);
                }
            })
    }
}

/// `kill`, a logout and a restart end the app with SIGTERM. It then leaves the way
/// Quit does, so that the edits still waiting to be saved are written.
///
/// The handler is installed before anything else: until it is, SIGTERM kills the
/// process outright, without the shutdown that saves and stops the child processes.
#[cfg(unix)]
mod termination {
    use std::sync::Mutex;
    use std::time::Duration;
    use tokio::signal::unix::{signal, SignalKind};

    struct State {
        requested: bool,
        app: Option<tauri::AppHandle>,
    }
    static STATE: Mutex<State> = Mutex::new(State {
        requested: false,
        app: None,
    });
    /// How long a start-up that was told to stop may take to reach the event loop.
    const STARTUP_GRACE: Duration = Duration::from_secs(10);

    fn state() -> std::sync::MutexGuard<'static, State> {
        STATE.lock().unwrap_or_else(|error| error.into_inner())
    }

    pub fn install() {
        // Registered here, synchronously; only the waiting happens in the task.
        let stream = tauri::async_runtime::block_on(async { signal(SignalKind::terminate()) });
        let Ok(mut stream) = stream else {
            return;
        };
        tauri::async_runtime::spawn(async move {
            if stream.recv().await.is_none() {
                return;
            }
            let app = {
                let mut state = state();
                state.requested = true;
                state.app.clone()
            };
            if let Some(app) = app {
                return app.exit(0);
            }
            // Still starting: `main` and `ready` leave as soon as they see the request.
            // A start-up that hangs must not make the app immune to SIGTERM.
            tokio::time::sleep(STARTUP_GRACE).await;
            if state().app.is_none() {
                byori_studio::runtime::kill_children_of(std::process::id());
                byori_studio::render::remove_partial_outputs();
                std::process::exit(0);
            }
        });
    }

    pub fn requested() -> bool {
        state().requested
    }

    /// From here on the signal quits through the event loop (`RunEvent::Exit`).
    pub fn ready(app: tauri::AppHandle) {
        let mut state = state();
        if state.requested {
            app.exit(0);
        }
        state.app = Some(app);
    }
}

/// Startup problems are shown to the user instead of crashing silently.
fn fail(message: &str) -> ! {
    tracing::error!("{message}");
    // A diagnosis run has nobody to dismiss a dialog.
    if let Some(path) = self_test::target() {
        self_test::startup_failure(&path, message);
        std::process::exit(1);
    }
    rfd::MessageDialog::new()
        .set_level(rfd::MessageLevel::Error)
        .set_title("Byori Studio를 시작할 수 없습니다")
        .set_description(message)
        .set_buttons(rfd::MessageButtons::Ok)
        .show();
    std::process::exit(1);
}

fn main() {
    #[cfg(unix)]
    termination::install();
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "byori_studio=info".into()),
        )
        .init();
    // An app opened from Finder has no shell PATH; FFmpeg and the CLIs must still be found.
    byori_studio::runtime::extend_process_path();
    let service = match tauri::async_runtime::block_on(StudioService::start(None, Host::App)) {
        Ok(service) => service,
        Err(error) => fail(&error),
    };
    // Told to stop while the service was starting: there is no window to open any more.
    #[cfg(unix)]
    if termination::requested() {
        service.shutdown();
        byori_studio::runtime::kill_children_of(std::process::id());
        byori_studio::render::remove_partial_outputs();
        std::process::exit(0);
    }
    let app = tauri::Builder::default()
        .setup(|app| {
            let demo = app.path().resource_dir()?.join("demo");
            if demo.is_dir() {
                std::env::set_var("BYORI_STUDIO_DEMO_DIR", demo);
            }
            // The window is declared in tauri.conf.json with `create: false` and opened here,
            // so a diagnosis run can attach its collector before the first page load.
            let config = app
                .config()
                .app
                .windows
                .first()
                .cloned()
                .ok_or("tauri.conf.json에 창 설정이 없습니다")?;
            let handle = app.handle().clone();
            let mut window = tauri::WebviewWindowBuilder::from_config(&handle, &config)?;
            let diagnosis = self_test::target();
            if let Some(path) = diagnosis.clone() {
                window = self_test::attach(window, handle.clone(), path);
            }
            let window = window.build()?;
            if diagnosis.is_some() {
                self_test::bring_forward(&window);
                // Once more when the app has finished launching: an activation asked for
                // during start-up is dropped when another app is in front.
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_millis(700));
                    self_test::bring_forward(&window);
                });
            }
            #[cfg(unix)]
            termination::ready(handle);
            Ok(())
        })
        .manage(service.connection.clone())
        .manage(service)
        .invoke_handler(tauri::generate_handler![
            studio_connection,
            studio_open_files,
            studio_save_file,
            studio_reveal_file
        ])
        .build(tauri::generate_context!());
    match app {
        Ok(app) => app.run(|handle, event| {
            // Agents, speech tools and a Studio-started database must not outlive the window.
            if let tauri::RunEvent::Exit = event {
                handle.state::<StudioService>().shutdown();
                // A running FFmpeg export is a plain child that nothing drops at exit.
                byori_studio::runtime::kill_children_of(std::process::id());
                byori_studio::render::remove_partial_outputs();
            }
        }),
        Err(error) => fail(&format!("Byori Studio 창을 열 수 없습니다: {error}")),
    }
}
