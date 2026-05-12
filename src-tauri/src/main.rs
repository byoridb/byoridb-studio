// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod client;

use client::{
    test_connection as client_test_connection, ByoriDBClient, ClientError, ConnectionConfig,
    QueryResult, SchemaInfo, SpaceInfo,
};
use serde::Serialize;
use std::sync::Arc;
use tauri::State;
use tokio::sync::Mutex;
use tracing::info;

struct AppState {
    client: Arc<Mutex<Option<ByoriDBClient>>>,
}

/// Structured error returned to the frontend from every Tauri command.
///
/// The `code` field carries a stable machine-readable tag (e.g.
/// `SESSION_EXPIRED`) so the UI can react to specific failure modes
/// (see `src/App.tsx`). `message` is the human-readable description.
#[derive(Debug, Serialize)]
struct TauriError {
    code: String,
    message: String,
}

impl TauriError {
    fn new(code: &str, message: impl Into<String>) -> Self {
        Self {
            code: code.to_string(),
            message: message.into(),
        }
    }
}

impl From<ClientError> for TauriError {
    fn from(err: ClientError) -> Self {
        TauriError {
            code: err.code().to_string(),
            message: err.to_string(),
        }
    }
}

impl From<anyhow::Error> for TauriError {
    fn from(err: anyhow::Error) -> Self {
        TauriError::new("TRANSPORT", err.to_string())
    }
}

#[tauri::command]
async fn connect(config: ConnectionConfig, state: State<'_, AppState>) -> Result<(), TauriError> {
    info!("Connecting to {}:{}", config.host, config.port);

    let client = ByoriDBClient::connect(config).await?;

    let mut guard = state.client.lock().await;
    *guard = Some(client);

    info!("Connected successfully");
    Ok(())
}

#[tauri::command]
async fn disconnect(state: State<'_, AppState>) -> Result<(), TauriError> {
    info!("Disconnecting...");

    let mut guard = state.client.lock().await;
    if let Some(client) = guard.take() {
        client.disconnect().await?;
    }

    info!("Disconnected");
    Ok(())
}

#[tauri::command]
async fn execute_query(
    query: String,
    state: State<'_, AppState>,
) -> Result<QueryResult, TauriError> {
    info!("Executing query: {}", query);

    let mut guard = state.client.lock().await;
    let client = guard.as_mut().ok_or_else(|| {
        TauriError::from(ClientError::NotConnected)
    })?;

    let result = client.execute(&query).await;

    // If the server told us the session is gone, drop our local ByoriDBClient too
    // so the UI connection state matches server state.
    if matches!(result, Err(ClientError::SessionExpired)) {
        *guard = None;
    }

    Ok(result?)
}

#[tauri::command]
async fn get_spaces(state: State<'_, AppState>) -> Result<Vec<SpaceInfo>, TauriError> {
    let mut guard = state.client.lock().await;
    let client = guard.as_mut().ok_or_else(|| {
        TauriError::from(ClientError::NotConnected)
    })?;

    let result = client.get_spaces().await;

    if matches!(result, Err(ClientError::SessionExpired)) {
        *guard = None;
    }

    Ok(result?)
}

#[tauri::command]
async fn get_schema(state: State<'_, AppState>) -> Result<SchemaInfo, TauriError> {
    let mut guard = state.client.lock().await;
    let client = guard.as_mut().ok_or_else(|| {
        TauriError::from(ClientError::NotConnected)
    })?;

    let result = client.get_schema().await;

    if matches!(result, Err(ClientError::SessionExpired)) {
        *guard = None;
    }

    Ok(result?)
}

#[tauri::command]
async fn test_connection(host: String, port: u32) -> Result<bool, TauriError> {
    info!("Testing connection to {}:{}", host, port);
    client_test_connection(&host, port).await.map_err(Into::into)
}

fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::from_default_env()
                .add_directive("byoridb_studio=debug".parse().unwrap()),
        )
        .init();

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .manage(AppState {
            client: Arc::new(Mutex::new(None)),
        })
        .invoke_handler(tauri::generate_handler![
            connect,
            disconnect,
            execute_query,
            get_spaces,
            get_schema,
            test_connection,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
