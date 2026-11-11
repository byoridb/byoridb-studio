# CLAUDE.md

## Current Work

Byori Studio is now a local video editor using CapCut Desktop's workspace pattern.
Preserve the name and the broad target in ROADMAP.md; do not represent remaining
advanced, cloud or generative features as implemented. NEXT.md is the active backlog.

## Development

```bash
npm install
npm run studio                       # Vite + standalone local Rust service
npm run tauri dev                    # native macOS window + service
npm run build                        # TypeScript + Vite
npm test
npm run test:core
python3 -m unittest discover -s scripts -p 'test_*.py'
npm run tauri build -- --bundles app
```

FFmpeg/ffprobe and Python 3 are required for media/MCP. Whisper is optional for
automatic captions; macOS say supplies TTS. Reuse installed CLI authentication;
never replace a user's global Claude/Codex/Gemini settings. See README.md.

## Active Architecture

- `src/App.tsx`, `src/studio/`: workspace, library, player, inspector, timeline,
  agent/memory panel, export and runtime settings.
- `src-tauri/src/editor.rs`: authoritative project, validated commands, revision,
  transactional batches, undo/redo and persistent autosave.
- `media.rs`, `render.rs`: probing, thumbnails, waveforms and FFmpeg rendering.
- `service.rs`: loopback RPC/upload/assets, origin and bearer-token checks.
- `runtime.rs`: ByoriDB setup/memory and CLI provider processes.
- `speech.rs`: cancellable Whisper and system TTS jobs.
- `main.rs`: native shell/file dialogs; `bin/studio-service.rs`: browser dev service.
- `scripts/studio-mcp.py`: project-scoped tools shared by the three CLI providers.

UI, CLI and MCP must share the same editor state and validated command path.
Pass expectedRevision for edits; reject stale asynchronous results. Keep user
media untouched, cancellation explicit, and preview/export output consistent.
The app stores projects in `~/.byori-studio`; automated integration tests must use
isolated BYORI_STUDIO_HOME/port, never a user's current project. See IMPLEMENTATION.md.
Legacy DB browser components and `client.rs` remain as historical source.

## Historical DB Explorer Reference

The following material predates the product pivot. It is not the active UI or
runtime contract. In particular, current ByoriDB session IDs may be decimal strings;
`runtime.rs` handles the actual current API. Do not copy the old numeric-only assumption.

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
GO FROM 1 OVER follows YIELD $$.person.name;
GO 2 STEPS FROM 1 OVER follows;

-- Pattern matching
MATCH (n:person) WHERE n.age > 25 RETURN n;
MATCH (a:person)-[e:follows]->(b:person) RETURN a.name, b.name;

-- Index lookup
LOOKUP ON person WHERE person.age > 25 YIELD person.name;

-- Path finding
FIND SHORTEST PATH FROM 1 TO 5 OVER follows;
```

**Special Variables in GO**
- `$^` - Source vertex
- `$$` - Destination vertex
- `follows._src`, `follows._dst` - Edge endpoints
