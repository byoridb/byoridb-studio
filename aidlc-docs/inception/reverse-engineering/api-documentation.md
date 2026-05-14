# API Documentation

This document describes three API surfaces relevant to ByoriDB Studio:

1. **Tauri commands** — the contract between the React frontend and the Rust backend (in-process, transported by Tauri IPC).
2. **External HTTP REST consumed** — the ByoriDB server API consumed by the Rust client.
3. **Internal Rust API** — the public surface of `client.rs` consumed by `main.rs`.
4. **Data models** — TypeScript and Rust shapes exchanged across these surfaces.

The studio itself **exposes no inbound network API**: it is a desktop client.

---

## 1. Tauri Commands (Frontend ↔ Rust)

All commands are invoked from TypeScript with `invoke<T>("command_name", { args })` from `@tauri-apps/api/core`. The argument keys must match the Rust parameter names exactly (Tauri uses serde-style key matching).

On success, commands return their typed value. On failure, the rejection is a serialized `TauriError = { code: string, message: string }`. The frontend defensively normalizes via `normalizeError` in `src/App.tsx`.

### `connect`
- **Purpose**: Authenticate with a ByoriDB server and store the resulting session in the backend's `AppState`.
- **Source**: `src-tauri/src/main.rs::connect`
- **Request**: `{ config: ConnectionConfig }`
- **Response**: `void`
- **Errors**: `AUTH_FAILED`, `TRANSPORT`, `PROTOCOL_ERROR`
- **Side effects**: Replaces any existing client in `AppState` with the newly authenticated one.

### `disconnect`
- **Purpose**: Best-effort sign-out, then drop the local client.
- **Source**: `src-tauri/src/main.rs::disconnect`
- **Request**: `{}` (no args)
- **Response**: `void`
- **Errors**: None observable — sign-out HTTP failures are swallowed; the local client is always cleared.
- **Side effects**: Clears `AppState.client`.

### `execute_query`
- **Purpose**: Run an arbitrary nGQL string against the active session and return the parsed result.
- **Source**: `src-tauri/src/main.rs::execute_query`
- **Request**: `{ query: string }`
- **Response**: `QueryResult`
- **Errors**: `NOT_CONNECTED`, `SESSION_EXPIRED`, `QUERY_ERROR`, `TRANSPORT`, `PROTOCOL_ERROR`
- **Side effects**: On `SESSION_EXPIRED`, `AppState.client` is nulled so subsequent calls fail fast with `NOT_CONNECTED` until reconnect.

### `get_spaces`
- **Purpose**: Run `SHOW SPACES` and return parsed `SpaceInfo` rows.
- **Source**: `src-tauri/src/main.rs::get_spaces`
- **Request**: `{}` (no args)
- **Response**: `SpaceInfo[]`
- **Errors**: Same as `execute_query`.
- **Side effects**: Same `SESSION_EXPIRED` reset behavior.

### `get_schema`
- **Purpose**: Run `SHOW TAGS` and `SHOW EDGES` against the active space and return both name lists.
- **Source**: `src-tauri/src/main.rs::get_schema`
- **Request**: `{}` (no args)
- **Response**: `SchemaInfo`
- **Errors**: Same as `execute_query`.
- **Side effects**: Same `SESSION_EXPIRED` reset behavior. Caller must have selected a space (`USE <space>`) first; otherwise the underlying queries error out.

### `test_connection`
- **Purpose**: Check whether `GET /health` on the given host:port returns 2xx within 5 s. Used both by the Settings UI and the periodic health-check loop.
- **Source**: `src-tauri/src/main.rs::test_connection`, `src-tauri/src/client.rs::test_connection`
- **Request**: `{ host: string, port: number }` (port is `u32` server-side)
- **Response**: `boolean` — `true` if HTTP status is `2xx`, otherwise `false`
- **Errors**: `TRANSPORT` on connect failure or timeout (`anyhow` wrapped). On lower-level failures the call resolves to a rejected promise with `TauriError`; on a clean `false` it resolves to a `boolean`.
- **Side effects**: None (no session created or modified).

---

## 2. External HTTP REST consumed (ByoriDB server)

The studio connects to the ByoriDB server documented in `../byoridb`. Default port is `19669` (HTTP REST). The full server reference is at `byoridb-graph/src/server.rs` and `byoridb-graph/src/auth.rs`. Below is only the surface this studio relies on.

### `POST /api/v1/session`
- **Purpose**: Authenticate username/password; returns a session id.
- **Request body**: `{ "username": string, "password": string }`
- **Success (200)**: `{ "session_id": <i64 number>, "time_zone": <string> }`
- **Failure (401 or other 4xx/5xx)**: `{ "error": <string>, "code": <string> }`
- **Used by**: `ByoriDBClient::authenticate`

### `DELETE /api/v1/session/{id}`
- **Purpose**: Sign out a session.
- **Path param**: `id` — the i64 returned by login.
- **Best-effort**: response is ignored by the client.
- **Used by**: `ByoriDBClient::disconnect`

### `POST /api/v1/query`
- **Purpose**: Execute an nGQL query under an authenticated session.
- **Request body**: `{ "session_id": <i64 number>, "query": <string> }`
- **Success (200)**: `{ "column_names": [string], "results": [{[col]: value}], "latency_ms": <number>, "row_count": <number, optional> }`
- **Failure (4xx/5xx)**: `{ "error": <string>, "code": <string> }`. The studio's heuristic `is_session_error` flips `code: "QUERY_ERROR"` with messages like `"Session not found"` or `"Session expired"` to its internal `SESSION_EXPIRED`.
- **Used by**: `ByoriDBClient::execute` (and through it, `get_spaces`, `get_schema`, plus all UI-driven queries).

### `GET /health`
- **Purpose**: Liveness probe.
- **Response**: `2xx` ⇒ healthy.
- **Used by**: free function `test_connection`, called periodically (30 s) and on operator-triggered Test buttons.

### Endpoints **not** used by the studio
Documented in `CLAUDE.md` for reference but unused by this client:
- `POST /api/v1/query/json` (raw JSON response variant)
- `GET /metrics` (Prometheus exposition)
- `GET /api/v1/metrics` (JSON metrics envelope; currently a stub on the server)

---

## 3. Internal Rust API (`src-tauri/src/client.rs`)

This is the public surface that `main.rs` consumes. It is not exposed beyond the crate.

### `pub struct ByoriDBClient`
Owns a connection config and an optional `session_id`. All methods that need the session take `&mut self` and update `session_id` on `SESSION_EXPIRED`.

#### Methods
| Method | Signature | Description |
|--------|-----------|-------------|
| `ByoriDBClient::connect` | `async fn(config: ConnectionConfig) -> Result<Self, ClientError>` | Builds the client and authenticates. Stores returned `session_id`. |
| `ByoriDBClient::disconnect` | `async fn(self) -> Result<(), ClientError>` | Consumes self; sends best-effort `DELETE /api/v1/session/{id}`; always returns `Ok(())`. |
| `ByoriDBClient::execute` | `async fn(&mut self, query: &str) -> Result<QueryResult, ClientError>` | Sends `POST /api/v1/query`. On session-loss, clears `session_id` and returns `SessionExpired`. |
| `ByoriDBClient::get_spaces` | `async fn(&mut self) -> Result<Vec<SpaceInfo>, ClientError>` | Convenience: `execute("SHOW SPACES")` → `parse_spaces`. |
| `ByoriDBClient::get_schema` | `async fn(&mut self) -> Result<SchemaInfo, ClientError>` | Convenience: `execute("SHOW TAGS")` + `execute("SHOW EDGES")` → `parse_names`. |

### `pub fn test_connection`
- Signature: `pub async fn test_connection(host: &str, port: u32) -> anyhow::Result<bool>`
- Sends `GET /health` with a 5-second total timeout and a fresh `reqwest::Client`. Returns `Ok(status.is_success())`.

### `pub enum ClientError`
| Variant | `code()` returns | Meaning |
|---------|------------------|---------|
| `Transport(String)` | `TRANSPORT` | Network / timeout / reqwest-level failure. |
| `Auth(String)` | `AUTH_FAILED` | Server rejected credentials at `POST /api/v1/session`. |
| `SessionExpired` | `SESSION_EXPIRED` | Server says session is invalid; UI should re-authenticate. |
| `Query(String)` | `QUERY_ERROR` | Server returned 4xx/5xx for a query. |
| `NotConnected` | `NOT_CONNECTED` | Client has no `session_id` (never connected or already disconnected). |
| `Protocol(String)` | `PROTOCOL_ERROR` | Response body did not match expected shape (e.g. non-numeric `session_id`). |

`Display` formats are stable and shown to the user via `TauriError.message`.

### Pure parsing helpers (private, but unit-tested)
| Function | Signature | Description |
|----------|-----------|-------------|
| `parse_session_id` | `fn(&serde_json::Value) -> anyhow::Result<i64>` | Strict — accepts only JSON number. Rejects strings or missing field with descriptive error text. |
| `parse_query_response` | `fn(&serde_json::Value) -> QueryResult` | Tolerant — defaults missing/invalid fields. Drops non-string column names and non-object rows. |
| `parse_names` | `fn(&QueryResult) -> Vec<String>` | Extracts the `Name` column as strings. |
| `parse_spaces` | `fn(&QueryResult) -> Vec<SpaceInfo>` | Reads `Name`, `Partition Num`, `Replica Factor`. Numeric columns default to `0` for forward-compatibility with older servers. |
| `parse_error_response` | `fn(&str) -> (Option<String>, String)` | Parses `{ error, code }` JSON; falls back to the raw text when not JSON. |
| `is_session_error` | `fn(&str) -> bool` | Case-insensitive substring match for `"session not found"` or `"session expired"`. |
| `build_http_client` | `fn() -> reqwest::Client` | Produces a `reqwest::Client` with 5 s connect / 30 s overall timeout. |

---

## 4. Data Models

### `ConnectionConfig`
- **Rust**: `src-tauri/src/client.rs::ConnectionConfig`, derives `Clone`, `Debug`, `Serialize`, `Deserialize`.
- **TypeScript**: `src/components/ServerSettings.tsx::ConnectionConfig` (also re-exported / re-declared in `App.tsx`, `ConnectionModal.tsx`).
- **Fields**:
  - `host: string`
  - `port: number` (Rust: `u32`)
  - `username: string`
  - `password: string`
- **Validation**: None enforced server-side here; the UI defaults port to `19669` and requires a non-empty saved-profile name.

### `QueryResult`
- **Rust**: `src-tauri/src/client.rs::QueryResult`
- **TypeScript**: declared in multiple components (`App.tsx`, `Sidebar.tsx`, `ResultPanel.tsx`).
- **Fields**:
  - `columns: string[]` (Rust `columns`, server `column_names`)
  - `rows: { [col: string]: unknown }[]` (Rust `rows: Vec<HashMap<String, serde_json::Value>>`, server `results`)
  - `executionTime: number` — milliseconds
    - Rust: `execution_time: f64`, populated from server `latency_ms`. Renamed via `#[serde(rename = "executionTime")]`.
    - Frontend: also overwritten with a JS `performance.now()` delta in `App.handleExecuteQuery` when round-tripping a user query.
  - `rowCount?: number` (Rust `row_count: Option<usize>` with `#[serde(rename = "rowCount", skip_serializing_if = "Option::is_none")]`)
  - `error?: string` (Rust `error: Option<String>`) — set only by frontend convenience when synthesizing a result for connection-loss messages; the parser does not populate it.
- **Notes**: Defaults to empty `columns` and `rows`, `executionTime: 0`, `rowCount: None` when fields are missing on the wire.

### `SpaceInfo`
- **Rust**: `src-tauri/src/client.rs::SpaceInfo`
- **Frontend**: `src/components/Sidebar.tsx::SpaceInfo`
- **Fields**:
  - `name: string`
  - `partitionNum: number` (Rust `partition_num: u32`, `#[serde(rename = "partitionNum")]`)
  - `replicaFactor: number` (Rust `replica_factor: u32`, `#[serde(rename = "replicaFactor")]`)
- **Source**: rows of `SHOW SPACES` (server columns `Name`, `Partition Num`, `Replica Factor`). Missing numeric columns default to `0`.

### `SchemaInfo`
- **Rust**: `src-tauri/src/client.rs::SchemaInfo`
- **Frontend**: `src/components/Sidebar.tsx::SchemaInfo`
- **Fields**:
  - `tags: string[]`
  - `edges: string[]`
- **Source**: result of `SHOW TAGS` and `SHOW EDGES`, each parsed via `parse_names`.

### `DescribeRow` (frontend only)
- **TypeScript**: `src/components/Sidebar.tsx::DescribeRow`
- **Fields** (matching server `DESCRIBE TAG/EDGE` columns):
  - `Field: string`
  - `Type: string`
  - `Null: string`
  - `Default: unknown` (JSON null when no default)

### `SavedConnection` (frontend only)
- **TypeScript**: `src/components/ServerSettings.tsx::SavedConnection`
- **Fields**:
  - `name: string`
  - `config: ConnectionConfig`
- **Storage**: `localStorage["byoridb-studio-connections"]` as a JSON array.

### `TauriError` (frontend mirror of Rust `TauriError`)
- **Rust**: `src-tauri/src/main.rs::TauriError`
- **TypeScript**: `src/App.tsx::TauriError`
- **Fields**:
  - `code: string`
  - `message: string`
- **Stable code values**: `TRANSPORT`, `AUTH_FAILED`, `SESSION_EXPIRED`, `QUERY_ERROR`, `NOT_CONNECTED`, `PROTOCOL_ERROR`, plus `UNKNOWN` synthesized by the frontend's `normalizeError` for non-conforming rejections.

### nGQL queries embedded in the studio (not strictly a model, but contractual)
- `SHOW SPACES` — used by `get_spaces`.
- `SHOW TAGS`, `SHOW EDGES` — used by `get_schema`.
- `USE <space>` — issued from `App.handleSelectSpace` on space selection (BT-6).
- `DESCRIBE TAG <name>`, `DESCRIBE EDGE <name>` — issued from `Sidebar.describe` on first expand (BT-8).
- `MATCH (v:<tag>) RETURN v LIMIT 100` — sample from clicking a tag name (BT-7 follow-up).
- `MATCH (s)-[e:<edge>]->() RETURN e LIMIT 100` — sample from clicking an edge name; the start node binds a variable per byoridb's MATCH constraint.
- `SHOW SPACES`, `SHOW TAGS`, `SHOW EDGES`, `SHOW PARTS`, `SHOW HOSTS` — sample-query buttons in `QueryEditor`.
