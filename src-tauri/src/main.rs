#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use byoridb_studio::service::{Connection, StudioService};
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

fn main() {
    tracing_subscriber::fmt()
        .with_env_filter("byoridb_studio=info")
        .init();
    let service = tauri::async_runtime::block_on(StudioService::start(None))
        .expect("Studio 편집 서비스를 시작할 수 없습니다");
    tauri::Builder::default()
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
        .run(tauri::generate_context!())
        .expect("Studio 실행 오류");
}
