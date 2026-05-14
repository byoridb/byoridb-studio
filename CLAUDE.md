# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Current Work

For the active punch list of next tasks (priorities, acceptance criteria, status), see [NEXT.md](./NEXT.md). Check this at the start of any new work session.

## Build and Development Commands

```bash
# Install dependencies
npm install

# Run in development mode (starts both Vite dev server and Tauri)
npm run tauri dev

# Build for production
npm run tauri build

# Frontend only (without Tauri)
npm run dev          # Start Vite dev server on port 1420
npm run build        # TypeScript check + Vite build

# Tests
npm test             # Run frontend tests (Vitest, jsdom)
npm run coverage     # Frontend coverage (v8 provider, html + text reporters)
```

For Rust backend changes in `src-tauri/`:
```bash
cd src-tauri && cargo build    # Build Rust code
cd src-tauri && cargo check    # Fast type checking
cd src-tauri && cargo test     # Run Rust unit tests
```

## Architecture

ByoriDB Studio is a Tauri 2 desktop application for managing ByoriDB (a distributed graph database).

**Frontend (React/TypeScript)**
- `src/App.tsx` - Main component managing connection state, query execution, and space selection
- `src/components/` - UI components (ConnectionModal, ServerSettings, QueryEditor, ResultPanel, Sidebar)
- Uses Tauri's `invoke()` to call Rust backend commands

**Backend (Rust/Tauri)**
- `src-tauri/src/main.rs` - Tauri commands exposed to frontend: `connect`, `disconnect`, `execute_query`, `get_spaces`, `get_schema`
- `src-tauri/src/client.rs` - ByoriDB HTTP API client. Pure parsing helpers (`parse_query_response`, `parse_names`, `parse_spaces`) are extracted for unit testing.
- State management via `AppState` with `Arc<Mutex<Option<ByoriDBClient>>>`

**Communication Pattern**
Frontend calls backend via `invoke("command_name", { params })` which maps to `#[tauri::command]` functions.

**Testing**
- Frontend: Vitest + Testing Library + jsdom. Setup at `src/test/setup.ts`. Tests are co-located next to components (`*.test.tsx`).
- Backend: `cargo test` runs `#[cfg(test)] mod tests` in `client.rs`. Async tests use `#[tokio::test]`.

## ByoriDB Server (../byoridb)

The ByoriDB database server that this studio connects to. The HTTP API
surface this studio depends on lives in `../byoridb/byoridb-graph/src/server.rs`
(request/response types) and `../byoridb/byoridb-graph/src/auth.rs` (root
password policy). Update these references along with client code when the
server changes.

**Default Ports**
- gRPC: `9669` (used by byoridb-client library)
- HTTP REST: `19669` (used by this studio)

**Root Credentials**
- Username: `root` (fixed).
- Password: read from the `BYORIDB_ROOT_PASSWORD` env var at server startup.
  If the var is unset, the server generates a cryptographically random
  48-char hex password and logs it once as a warning. There is no
  hard-coded default.
- For local development, choose any value and set it on both sides — e.g.
  export `BYORIDB_ROOT_PASSWORD=byoridb-dev` before launching the server,
  then enter the same value in the studio's password field.

**HTTP REST API Endpoints**
```
POST /api/v1/session          - Authenticate (username, password) -> { session_id: i64, time_zone }
DELETE /api/v1/session/{id}   - Sign out (id as i64 in path)
POST /api/v1/query            - Execute query ({ session_id: i64, query }) -> results
POST /api/v1/query/json       - Execute query (raw JSON response)
GET /health                   - Health check ("OK" text)
GET /metrics                  - Prometheus metrics (text exposition)
GET /api/v1/metrics           - JSON metrics envelope (currently a status stub)
```

`session_id` is a JSON **number** on both request and response bodies.

**Error Response Format**

4xx/5xx responses carry a structured body:
```json
{ "error": "human-readable message", "code": "AUTH_FAILED" | "QUERY_ERROR" | ... }
```
The client surfaces `code` to the frontend via `TauriError` so the UI can
react (see `SESSION_EXPIRED` handling in `src/App.tsx`).

**Query Response Format**
```json
{
  "results": [{"column1": value, ...}],
  "latency_ms": 10,
  "row_count": 5,
  "column_names": ["column1", ...]
}
```

**Running the Server**
```bash
cd ../byoridb
BYORIDB_ROOT_PASSWORD=byoridb-dev cargo run --release --bin byoridb-server
```

## nGQL Query Language Reference

**Space Management**
```sql
CREATE SPACE my_space (vid_type = INT64);
USE my_space;
SHOW SPACES;
DROP SPACE my_space;
```

**Schema Definition**
```sql
CREATE TAG person (name STRING, age INT64);
CREATE EDGE follows (since INT64);
SHOW TAGS;
SHOW EDGES;
ALTER TAG person ADD (email STRING NULL);
```

**Data Types**: `BOOL`, `INT8`, `INT16`, `INT32`, `INT64`, `FLOAT`, `DOUBLE`, `STRING`, `TIMESTAMP`, `DATE`, `DATETIME`

**Data Manipulation**
```sql
INSERT VERTEX person (name, age) VALUES 1:('Alice', 30);
INSERT EDGE follows (since) VALUES 1 -> 2:(2020);
UPDATE VERTEX ON person 1 SET age = 31;
DELETE VERTEX 1;
DELETE EDGE follows 1 -> 2;
```

**Queries**
```sql
-- Fetch vertex properties
FETCH PROP ON person 1;
FETCH PROP ON * 1;  -- all tags

-- Graph traversal
GO FROM 1 OVER follows YIELD follows._dst AS friend_id;
GO 2 STEPS FROM 1 OVER follows YIELD vertex AS v;
GO 1..3 STEPS FROM 1 OVER follows YIELD follows._dst;
GO FROM 1 OVER follows WHERE follows.since > 2020 YIELD follows.since, follows._dst;

-- To project destination-vertex properties, use a compound statement:
$f = GO FROM 1 OVER follows YIELD follows._dst AS dst;
FETCH PROP ON person $f.dst;
-- or use MATCH (single statement):
MATCH (a:person)-[:follows]->(b:person) WHERE a.name == 'Alice' RETURN b.name;

-- Pattern matching (start node MUST have a variable; end node may be anonymous)
MATCH (n:person) WHERE n.age > 25 RETURN n;
MATCH (a:person)-[e:follows]->(b:person) RETURN a.name, b.name;

-- Index lookup
LOOKUP ON person WHERE person.age > 25 YIELD person.name;

-- Path finding
FIND SHORTEST PATH FROM 1 TO 5 OVER follows;
```

**GO YIELD column references** (what byoridb actually accepts — see
`byoridb-parser/src/parser/dql.rs::parse_go` and the executor's GO tests):
- `<edge>._src`, `<edge>._dst` — edge endpoint VIDs
- `<edge>.<prop>` — edge property
- `vertex` — destination vertex object (multi-step traversals)
- `$var` / `$var.col` — reference to a previous compound-statement result

The nGQL-standard placeholders `$^` (source vertex) and `$$` (destination
vertex) are **not implemented** in byoridb; the parser rejects them at
the `Dollar` token. Use the workarounds above (compound `$var = GO ...;
FETCH PROP ...`, or `MATCH`) when you need vertex properties.

**MATCH constraint**: byoridb requires the *start node* of a `MATCH`
pattern to bind a variable (see `byoridb-executor/src/match.rs`).
`MATCH ()-[e:follows]->()` is rejected; use `MATCH (s)-[e:follows]->()`
instead. The end node may stay anonymous.
