#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use byori_studio::service::{Connection, Host, StudioService};
use tauri::Manager;

#[tauri::command]
fn studio_connection(state: tauri::State<'_, Connection>) -> Connection {
    state.inner().clone()
}

#[tauri::command]
async fn studio_open_files(extensions: Option<Vec<String>>) -> Vec<String> {
    let extensions = extensions.unwrap_or_else(|| ["mp4", "mov", "mkv", "webm", "avi", "mp3", "wav", "m4a", "aac", "flac", "png", "jpg", "jpeg", "webp", "gif", "srt", "cube", "3dl"].into_iter().map(String::from).collect());
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

/// Startup problems are shown to the user instead of crashing silently.
fn fail(message: &str) -> ! {
    tracing::error!("{message}");
    rfd::MessageDialog::new()
        .set_level(rfd::MessageLevel::Error)
        .set_title("Byori Studio를 시작할 수 없습니다")
        .set_description(message)
        .set_buttons(rfd::MessageButtons::Ok)
        .show();
    std::process::exit(1);
}

fn main() {
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
    let app = tauri::Builder::default()
        .setup(|app| {
            let demo = app.path().resource_dir()?.join("demo");
            if demo.is_dir() {
                std::env::set_var("BYORI_STUDIO_DEMO_DIR", demo);
            }
            Ok(())
        })
        .manage(service.connection.clone())
        .manage(service)
        .invoke_handler(tauri::generate_handler![
            studio_connection,
            studio_open_files,
            studio_save_file
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
