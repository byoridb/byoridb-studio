/// Errors returned by `ByoriDBClient` methods.
///
/// `code()` returns a stable string surfaced to the frontend so the UI can
/// react (e.g. force re-auth on `SESSION_EXPIRED`).
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
