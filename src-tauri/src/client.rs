//! ByoriDB client for communicating with the graph database server

use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use tracing::info;

/// Errors returned by `ByoriDBClient` methods.
///
/// The `code()` method returns a stable string that the Tauri boundary
/// surfaces to the frontend so the UI can react (e.g. force re-auth on
/// `SESSION_EXPIRED`).
#[derive(Debug)]
pub enum ClientError {
    /// Network/timeout/reqwest-level error — couldn't reach the server.
    Transport(String),
    /// Server rejected credentials on `POST /api/v1/session` (HTTP 401).
    Auth(String),
    /// Server says the session is invalid or expired; the UI should re-authenticate.
    SessionExpired,
    /// Server returned 4xx/5xx for a query with a query-level error body.
    Query(String),
    /// Client has no session yet (never connected, or already disconnected).
    NotConnected,
    /// Response body did not match the expected shape.
    Protocol(String),
}

impl ClientError {
    /// Stable string code used at the Tauri → frontend boundary.
    pub fn code(&self) -> &'static str {
        match self {
            Self::Transport(_) => "TRANSPORT",
            Self::Auth(_) => "AUTH_FAILED",
            Self::SessionExpired => "SESSION_EXPIRED",
            Self::Query(_) => "QUERY_ERROR",
            Self::NotConnected => "NOT_CONNECTED",
            Self::Protocol(_) => "PROTOCOL_ERROR",
        }
    }
}

impl std::fmt::Display for ClientError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Transport(m) => write!(f, "Transport error: {m}"),
            Self::Auth(m) => write!(f, "Authentication failed: {m}"),
            Self::SessionExpired => write!(f, "Session expired; please reconnect"),
            Self::Query(m) => write!(f, "Query error: {m}"),
            Self::NotConnected => write!(f, "Not connected"),
            Self::Protocol(m) => write!(f, "Protocol error: {m}"),
        }
    }
}

impl std::error::Error for ClientError {}

impl From<reqwest::Error> for ClientError {
    fn from(err: reqwest::Error) -> Self {
        ClientError::Transport(err.to_string())
    }
}

/// Parse byoridb's structured `{error, code}` error body. Falls back to
/// the raw text if the body isn't valid JSON or is missing fields.
///
/// Returns `(code, message)` where `code` is `None` if the server didn't
/// provide one.
fn parse_error_response(raw: &str) -> (Option<String>, String) {
    match serde_json::from_str::<serde_json::Value>(raw) {
        Ok(body) => {
            let code = body
                .get("code")
                .and_then(|v| v.as_str())
                .map(String::from);
            let message = body
                .get("error")
                .and_then(|v| v.as_str())
                .map(String::from)
                .unwrap_or_else(|| raw.to_string());
            (code, message)
        }
        Err(_) => (None, raw.to_string()),
    }
}

/// Heuristic: does this server error message indicate the session is gone?
///
/// byoridb currently bundles "Session not found" and "Session expired"
/// under the generic `QUERY_ERROR` code (see `byoridb-graph/src/error.rs`
/// and `byoridb-graph/src/server.rs`), so we match on the message text.
fn is_session_error(message: &str) -> bool {
    let lower = message.to_ascii_lowercase();
    lower.contains("session not found") || lower.contains("session expired")
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConnectionConfig {
    pub host: String,
    pub port: u32,
    pub username: String,
    pub password: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct QueryResult {
    pub columns: Vec<String>,
    pub rows: Vec<HashMap<String, serde_json::Value>>,
    #[serde(rename = "executionTime")]
    pub execution_time: f64,
    /// Server-reported row count (see byoridb `QueryResponse.row_count`).
    /// `None` when the response didn't include it; frontends should fall
    /// back to `rows.len()` in that case.
    #[serde(rename = "rowCount", skip_serializing_if = "Option::is_none")]
    pub row_count: Option<usize>,
    pub error: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct SpaceInfo {
    pub name: String,
    #[serde(rename = "partitionNum")]
    pub partition_num: u32,
    #[serde(rename = "replicaFactor")]
    pub replica_factor: u32,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct SchemaInfo {
    pub tags: Vec<String>,
    pub edges: Vec<String>,
}

/// Test connection to server using health endpoint
pub async fn test_connection(host: &str, port: u32) -> Result<bool> {
    let url = format!("http://{}:{}/health", host, port);
    let http_client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(5))
        .build()?;

    let resp = http_client
        .get(&url)
        .send()
        .await
        .map_err(|e| anyhow!("Connection failed: {}", e))?;

    Ok(resp.status().is_success())
}

/// ByoriDB client
pub struct ByoriDBClient {
    config: ConnectionConfig,
    session_id: Option<i64>,
}

impl ByoriDBClient {
    /// Connect to ByoriDB server
    pub async fn connect(config: ConnectionConfig) -> Result<Self, ClientError> {
        info!("Connecting to ByoriDB at {}:{}", config.host, config.port);

        let mut client = Self {
            config: config.clone(),
            session_id: None,
        };

        // Authenticate via HTTP REST API
        let session_id = client.authenticate().await?;
        client.session_id = Some(session_id);

        info!("Connected with session_id: {:?}", client.session_id);
        Ok(client)
    }

    /// Authenticate with the server using `POST /api/v1/session`.
    ///
    /// The byoridb HTTP API returns `session_id` as a JSON number (i64);
    /// see `byoridb-graph/src/server.rs::SessionResponse`.
    async fn authenticate(&self) -> Result<i64, ClientError> {
        let url = format!(
            "http://{}:{}/api/v1/session",
            self.config.host, self.config.port
        );

        let http_client = reqwest::Client::new();
        let resp = http_client
            .post(&url)
            .json(&serde_json::json!({
                "username": self.config.username,
                "password": self.config.password,
            }))
            .send()
            .await?;

        if resp.status().is_success() {
            let body: serde_json::Value = resp
                .json()
                .await
                .map_err(|e| ClientError::Protocol(format!("invalid JSON body: {e}")))?;
            parse_session_id(&body).map_err(|e| ClientError::Protocol(e.to_string()))
        } else {
            let raw = resp.text().await.unwrap_or_default();
            let (_code, message) = parse_error_response(&raw);
            Err(ClientError::Auth(message))
        }
    }

    /// Disconnect from the server using `DELETE /api/v1/session/{id}`.
    ///
    /// Errors from the DELETE request are swallowed — disconnect is best-effort
    /// and the local session is always cleared.
    pub async fn disconnect(self) -> Result<(), ClientError> {
        if let Some(session_id) = self.session_id {
            let url = format!(
                "http://{}:{}/api/v1/session/{}",
                self.config.host, self.config.port, session_id
            );

            let http_client = reqwest::Client::new();
            let _ = http_client.delete(&url).send().await;
        }
        Ok(())
    }

    /// Execute a query using `POST /api/v1/query`.
    ///
    /// `session_id` is sent as a JSON number to match the server's
    /// `QueryRequest.session_id: i64` deserializer. If the server indicates
    /// the session is gone, the local `session_id` is cleared so subsequent
    /// calls fail fast with `NotConnected` until the UI re-authenticates.
    pub async fn execute(&mut self, query: &str) -> Result<QueryResult, ClientError> {
        let session_id = self.session_id.ok_or(ClientError::NotConnected)?;

        let url = format!(
            "http://{}:{}/api/v1/query",
            self.config.host, self.config.port
        );

        let http_client = reqwest::Client::new();
        let resp = http_client
            .post(&url)
            .json(&serde_json::json!({
                "session_id": session_id,
                "query": query,
            }))
            .send()
            .await?;

        if resp.status().is_success() {
            let body: serde_json::Value = resp
                .json()
                .await
                .map_err(|e| ClientError::Protocol(format!("invalid JSON body: {e}")))?;
            Ok(parse_query_response(&body))
        } else {
            let raw = resp.text().await.unwrap_or_default();
            let (_code, message) = parse_error_response(&raw);

            if is_session_error(&message) {
                // Server-side session is gone; drop local id so we don't keep
                // retrying with a dead id.
                self.session_id = None;
                Err(ClientError::SessionExpired)
            } else {
                Err(ClientError::Query(message))
            }
        }
    }

    /// Get list of spaces
    pub async fn get_spaces(&mut self) -> Result<Vec<SpaceInfo>, ClientError> {
        let result = self.execute("SHOW SPACES").await?;
        Ok(parse_spaces(&result))
    }

    /// Get schema (tags and edges) for current space
    pub async fn get_schema(&mut self) -> Result<SchemaInfo, ClientError> {
        let tags_result = self.execute("SHOW TAGS").await?;
        let edges_result = self.execute("SHOW EDGES").await?;

        let tags = parse_names(&tags_result);
        let edges = parse_names(&edges_result);

        Ok(SchemaInfo { tags, edges })
    }
}

/// Extract `session_id` from a `POST /api/v1/session` response body.
///
/// The byoridb server always returns `session_id` as a JSON number (i64);
/// any other shape is a protocol violation and should fail loudly rather
/// than be silently coerced.
fn parse_session_id(body: &serde_json::Value) -> Result<i64> {
    body["session_id"].as_i64().ok_or_else(|| {
        anyhow!(
            "Invalid session_id in response: {}",
            body.get("session_id")
                .map(|v| v.to_string())
                .unwrap_or_else(|| "<missing>".to_string())
        )
    })
}

fn parse_query_response(body: &serde_json::Value) -> QueryResult {
    let columns = body["column_names"]
        .as_array()
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default();

    let rows = body["results"]
        .as_array()
        .map(|arr| {
            arr.iter()
                .filter_map(|v| {
                    v.as_object().map(|obj| {
                        obj.iter()
                            .map(|(k, v)| (k.clone(), v.clone()))
                            .collect()
                    })
                })
                .collect()
        })
        .unwrap_or_default();

    let execution_time = body["latency_ms"].as_f64().unwrap_or(0.0);

    let row_count = body["row_count"]
        .as_u64()
        .map(|n| n as usize);

    QueryResult {
        columns,
        rows,
        execution_time,
        row_count,
        error: None,
    }
}

fn parse_names(result: &QueryResult) -> Vec<String> {
    result
        .rows
        .iter()
        .filter_map(|row| row.get("Name").and_then(|v| v.as_str()).map(String::from))
        .collect()
}

/// Parse a `SHOW SPACES` response into `SpaceInfo` entries.
///
/// The byoridb server returns columns `["Name", "Replica Factor", "Partition Num"]`
/// (see `byoridb-executor/src/executor.rs` `ShowPlan::Spaces`). Missing
/// numeric columns default to `0` — the sidebar still renders sensibly and
/// flags the space as "not yet described".
fn parse_spaces(result: &QueryResult) -> Vec<SpaceInfo> {
    result
        .rows
        .iter()
        .filter_map(|row| {
            let name = row.get("Name").and_then(|v| v.as_str())?;
            let partition_num = row
                .get("Partition Num")
                .and_then(|v| v.as_u64())
                .map(|n| n as u32)
                .unwrap_or(0);
            let replica_factor = row
                .get("Replica Factor")
                .and_then(|v| v.as_u64())
                .map(|n| n as u32)
                .unwrap_or(0);
            Some(SpaceInfo {
                name: name.to_string(),
                partition_num,
                replica_factor,
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parse_query_response_maps_columns_rows_and_latency() {
        let body = json!({
            "column_names": ["Name", "Count", 7],
            "results": [
                { "Name": "space_a", "Count": 2 },
                "ignored",
                { "Name": "space_b", "Count": 4 }
            ],
            "latency_ms": 3.5,
            "row_count": 2
        });

        let result = parse_query_response(&body);

        assert_eq!(result.columns, vec!["Name", "Count"]);
        assert_eq!(result.rows.len(), 2);
        assert_eq!(result.rows[0]["Name"], json!("space_a"));
        assert_eq!(result.rows[1]["Count"], json!(4));
        assert_eq!(result.execution_time, 3.5);
        assert_eq!(result.row_count, Some(2));
        assert!(result.error.is_none());
    }

    #[test]
    fn parse_query_response_defaults_when_fields_are_missing() {
        let result = parse_query_response(&json!({}));

        assert!(result.columns.is_empty());
        assert!(result.rows.is_empty());
        assert_eq!(result.execution_time, 0.0);
        assert!(result.row_count.is_none());
        assert!(result.error.is_none());
    }

    #[test]
    fn parse_names_ignores_rows_without_string_name() {
        let result = QueryResult {
            columns: vec!["Name".to_string()],
            rows: vec![
                HashMap::from([("Name".to_string(), json!("person"))]),
                HashMap::from([("Name".to_string(), json!(123))]),
                HashMap::from([("Other".to_string(), json!("ignored"))]),
            ],
            execution_time: 0.0,
            row_count: None,
            error: None,
        };

        assert_eq!(parse_names(&result), vec!["person"]);
    }

    #[test]
    fn parse_spaces_reads_partition_and_replica_from_server_columns() {
        let result = QueryResult {
            columns: vec![
                "Name".to_string(),
                "Partition Num".to_string(),
                "Replica Factor".to_string(),
            ],
            rows: vec![HashMap::from([
                ("Name".to_string(), json!("demo")),
                ("Partition Num".to_string(), json!(100)),
                ("Replica Factor".to_string(), json!(3)),
            ])],
            execution_time: 0.0,
            row_count: Some(1),
            error: None,
        };

        let spaces = parse_spaces(&result);

        assert_eq!(spaces.len(), 1);
        assert_eq!(spaces[0].name, "demo");
        assert_eq!(spaces[0].partition_num, 100);
        assert_eq!(spaces[0].replica_factor, 3);
    }

    #[test]
    fn parse_spaces_defaults_missing_numeric_columns_to_zero() {
        // Forward-compat: older/partial server responses that only include Name.
        let result = QueryResult {
            columns: vec!["Name".to_string()],
            rows: vec![HashMap::from([("Name".to_string(), json!("demo"))])],
            execution_time: 0.0,
            row_count: None,
            error: None,
        };

        let spaces = parse_spaces(&result);

        assert_eq!(spaces.len(), 1);
        assert_eq!(spaces[0].partition_num, 0);
        assert_eq!(spaces[0].replica_factor, 0);
    }

    #[test]
    fn parse_session_id_accepts_numeric_value() {
        let body = json!({ "session_id": 42, "time_zone": "UTC" });
        assert_eq!(parse_session_id(&body).unwrap(), 42);
    }

    #[test]
    fn parse_session_id_rejects_string_value() {
        let body = json!({ "session_id": "42" });
        let err = parse_session_id(&body).unwrap_err().to_string();
        assert!(
            err.contains("\"42\""),
            "error should include the offending value, got: {err}"
        );
    }

    #[test]
    fn parse_session_id_rejects_missing_field() {
        let body = json!({ "time_zone": "UTC" });
        let err = parse_session_id(&body).unwrap_err().to_string();
        assert!(
            err.contains("<missing>"),
            "error should flag the field as missing, got: {err}"
        );
    }

    #[test]
    fn parse_error_response_reads_structured_body() {
        let raw = r#"{"error":"Authentication failed: User not found","code":"AUTH_FAILED"}"#;
        let (code, message) = parse_error_response(raw);
        assert_eq!(code.as_deref(), Some("AUTH_FAILED"));
        assert_eq!(message, "Authentication failed: User not found");
    }

    #[test]
    fn parse_error_response_falls_back_to_raw_for_non_json() {
        let raw = "Internal Server Error";
        let (code, message) = parse_error_response(raw);
        assert_eq!(code, None);
        assert_eq!(message, "Internal Server Error");
    }

    #[test]
    fn parse_error_response_returns_raw_when_error_field_missing() {
        let raw = r#"{"code":"QUERY_ERROR"}"#;
        let (code, message) = parse_error_response(raw);
        assert_eq!(code.as_deref(), Some("QUERY_ERROR"));
        assert_eq!(message, raw);
    }

    #[test]
    fn is_session_error_matches_known_phrases_case_insensitively() {
        assert!(is_session_error("Query execution failed: Session not found: 1"));
        assert!(is_session_error("session expired"));
        assert!(is_session_error("Authentication failed: Session expired"));
    }

    #[test]
    fn is_session_error_rejects_unrelated_messages() {
        assert!(!is_session_error("Syntax error near 'SHOW'"));
        assert!(!is_session_error("sessions collection is empty"));
    }

    #[test]
    fn client_error_code_is_stable() {
        assert_eq!(ClientError::Transport("x".into()).code(), "TRANSPORT");
        assert_eq!(ClientError::Auth("x".into()).code(), "AUTH_FAILED");
        assert_eq!(ClientError::SessionExpired.code(), "SESSION_EXPIRED");
        assert_eq!(ClientError::Query("x".into()).code(), "QUERY_ERROR");
        assert_eq!(ClientError::NotConnected.code(), "NOT_CONNECTED");
        assert_eq!(ClientError::Protocol("x".into()).code(), "PROTOCOL_ERROR");
    }

    #[tokio::test]
    async fn execute_returns_not_connected_when_client_has_no_session() {
        let mut client = ByoriDBClient {
            config: ConnectionConfig {
                host: "127.0.0.1".to_string(),
                port: 19669,
                username: "root".to_string(),
                password: "test-password".to_string(),
            },
            session_id: None,
        };

        let err = client.execute("SHOW SPACES").await.unwrap_err();

        assert!(matches!(err, ClientError::NotConnected));
        assert_eq!(err.code(), "NOT_CONNECTED");
    }

    #[tokio::test]
    async fn disconnect_without_session_is_a_noop() {
        let client = ByoriDBClient {
            config: ConnectionConfig {
                host: "127.0.0.1".to_string(),
                port: 19669,
                username: "root".to_string(),
                password: "test-password".to_string(),
            },
            session_id: None,
        };

        assert!(client.disconnect().await.is_ok());
    }
}
