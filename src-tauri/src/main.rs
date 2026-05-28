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
use tokio_util::sync::CancellationToken;
use tracing::info;

struct AppState {
    client: Arc<Mutex<Option<ByoriDBClient>>>,
    /// Replaced each time a query starts; cancelled when the user requests abort.
    query_cancel: Arc<Mutex<Option<CancellationToken>>>,
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

    // Create a fresh cancellation token for this query
    let token = CancellationToken::new();
    {
        let mut cancel_guard = state.query_cancel.lock().await;
        *cancel_guard = Some(token.clone());
    }

    let mut guard = state.client.lock().await;
    let client = guard
        .as_mut()
        .ok_or_else(|| TauriError::from(ClientError::NotConnected))?;

    // Race the query against the cancellation token
    let result = tokio::select! {
        r = client.execute(&query) => r,
        _ = token.cancelled() => Err(ClientError::Query("Query cancelled by user".to_string())),
    };

    if matches!(result, Err(ClientError::SessionExpired)) {
        *guard = None;
    }

    Ok(result?)
}

#[tauri::command]
async fn cancel_query(state: State<'_, AppState>) -> Result<(), TauriError> {
    let mut cancel_guard = state.query_cancel.lock().await;
    if let Some(token) = cancel_guard.take() {
        token.cancel();
    }
    Ok(())
}

#[tauri::command]
async fn get_spaces(state: State<'_, AppState>) -> Result<Vec<SpaceInfo>, TauriError> {
    let mut guard = state.client.lock().await;
    let client = guard
        .as_mut()
        .ok_or_else(|| TauriError::from(ClientError::NotConnected))?;

    let result = client.get_spaces().await;

    if matches!(result, Err(ClientError::SessionExpired)) {
        *guard = None;
    }

    Ok(result?)
}

#[tauri::command]
async fn get_schema(state: State<'_, AppState>) -> Result<SchemaInfo, TauriError> {
    let mut guard = state.client.lock().await;
    let client = guard
        .as_mut()
        .ok_or_else(|| TauriError::from(ClientError::NotConnected))?;

    let result = client.get_schema().await;

    if matches!(result, Err(ClientError::SessionExpired)) {
        *guard = None;
    }

    Ok(result?)
}

#[tauri::command]
async fn test_connection(host: String, port: u32) -> Result<bool, TauriError> {
    info!("Testing connection to {}:{}", host, port);
    client_test_connection(&host, port)
        .await
        .map_err(Into::into)
}

/// Execute a DDL/DML statement that returns no rows (CREATE, DROP, ALTER, etc.)
#[tauri::command]
async fn execute_statement(
    statement: String,
    state: State<'_, AppState>,
) -> Result<(), TauriError> {
    info!("Executing statement: {}", statement);
    let mut guard = state.client.lock().await;
    let client = guard
        .as_mut()
        .ok_or_else(|| TauriError::from(ClientError::NotConnected))?;
    let result = client.execute(&statement).await;
    if matches!(result, Err(ClientError::SessionExpired)) {
        *guard = None;
    }
    result?;
    Ok(())
}

/// Get index list for a tag or edge: SHOW TAG/EDGE INDEXES
#[tauri::command]
async fn get_indexes(
    kind: String, // "tag" or "edge"
    name: String,
    state: State<'_, AppState>,
) -> Result<QueryResult, TauriError> {
    let query = if kind == "tag" {
        format!("SHOW TAG INDEXES ON {}", name)
    } else {
        format!("SHOW EDGE INDEXES ON {}", name)
    };
    let mut guard = state.client.lock().await;
    let client = guard
        .as_mut()
        .ok_or_else(|| TauriError::from(ClientError::NotConnected))?;
    let result = client.execute(&query).await;
    if matches!(result, Err(ClientError::SessionExpired)) {
        *guard = None;
    }
    Ok(result?)
}

/// Fetch Prometheus metrics text. Tauri WebView blocks cross-origin fetch on
/// macOS WKWebView ("TypeError: Load failed"), so we proxy via Rust.
#[tauri::command]
async fn fetch_metrics(host: String, port: u32) -> Result<String, TauriError> {
    let url = format!("http://{}:{}/metrics", host, port);
    info!("Fetching metrics from {}", url);
    let client = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(5))
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| TauriError::new("TRANSPORT", e.to_string()))?;
    let resp = client
        .get(&url)
        .send()
        .await
        .map_err(|e| TauriError::new("TRANSPORT", e.to_string()))?;
    if !resp.status().is_success() {
        return Err(TauriError::new(
            "TRANSPORT",
            format!("HTTP {}", resp.status().as_u16()),
        ));
    }
    resp.text()
        .await
        .map_err(|e| TauriError::new("TRANSPORT", e.to_string()))
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
            query_cancel: Arc::new(Mutex::new(None)),
        })
        .invoke_handler(tauri::generate_handler![
            connect,
            disconnect,
            execute_query,
            cancel_query,
            get_spaces,
            get_schema,
            test_connection,
            execute_statement,
            get_indexes,
            fetch_metrics,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
