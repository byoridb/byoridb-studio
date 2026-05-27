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

---

## AI-DLC (cah-dlc) 통합

본 코드베이스는 Connexioh cah-dlc를 적용 중입니다. 공통 에이전트 규칙은 `AGENTS.md`를 참조. 아래는 Claude Code 전용 보강입니다.

### 사용 가능한 Skill

| Skill | 용도 |
|---|---|
| `/cah:brownfield-audit` | 코드베이스 재감사 (분기별 권장) |
| `/cah:brownfield-onboard` | CLAUDE.md / AGENTS.md 재생성 / 업데이트 |
| `/cah:brownfield-migrate` | AI-DLC 마이그레이션 플랜 작성 |
| `/cah:vision` | 신규 기능 비전 작성 |
| `/cah:tech` | 신규 기능 기술 환경 문서 |
| `/cah:inception` | personas + requirements |
| `/cah:construction` | 코드 생성 + NFR + 인프라 |
| `/cah:retro` | phase 종료 / 마일스톤 / 사고 후 회고 |
| `/cah:review` | 현재 작업 상태 게이트 검사 |

### 우선 호출 순서

- **신규 기능** → `/cah:vision` → `/cah:tech` → `/cah:inception` → `/cah:construction`
- **기존 모듈 수정** → 영향 범위 파악 → `/cah:review` 사전 호출 권장
- **사고 / 장애 직후** → `/cah:retro` (incident 모드)
- **분기별 재감사** → `/cah:brownfield-audit`

### AI-DLC 산출물 위치

```
aidlc-docs/
├── audit/audit-report.md        # 최신 감사 보고서 (2026-05-21)
├── onboard/onboard-notes.md     # 문서 변경 이력
└── migration/                   # (예정) migration-plan, tech-debt, gate-grace
```

---

## 코드베이스 주의사항

audit-report에서 확인된 함정 (변경 전 인지 필수):

- **`src/App.tsx`**: M1 완료로 훅 분리됨. `useConnection` + `useQueryExecution` 사용. health poll `useEffect`만 App.tsx에 잔존 (두 훅에 걸친 cross-cutting concern).
- **`src/components/Sidebar.tsx`**: M1-3 완료로 `useSchemaData` 훅 분리됨. UI 렌더링만 담당.
- **heuristic 세션 만료 감지**: `client.rs::is_session_error()`가 메시지 텍스트 매칭으로 세션 만료를 감지. 서버가 전용 `code` 필드를 추가하면 제거 예정.
- **CSS**: Tailwind CSS v4 사용. `src/styles/index.css`에 `@theme`으로 Catppuccin Mocha 토큰 정의. 컴포넌트별 CSS 파일 없음 — 모든 스타일을 Tailwind 유틸리티 클래스로 인라인.
- **CI 없음**: `npm test` + `cargo test`는 수동. PR 전 반드시 로컬 실행.

---

## TODO (cah-dlc 도입 진행 중)

- [x] `brownfield-migrate` 완료 → `aidlc-docs/migration/` 산출물 생성됨
- [x] **M0**: GitHub Actions CI 파이프라인 구성 (`npm test` + `cargo test` 자동화)
- [x] **M1-1**: `App.tsx` → `useConnection` 훅 추출 (`src/hooks/useConnection.ts`)
- [x] **M1-2**: `App.tsx` → `useQueryExecution` 훅 추출 (`src/hooks/useQueryExecution.ts`)
- [x] **M1-3**: `Sidebar.tsx` → `useSchemaData` 훅 추출 (`src/hooks/useSchemaData.ts`)
- [x] **M2**: CSS 아키텍처 방식 결정 + 전환 → Tailwind CSS v4 (Catppuccin Mocha 테마)
- [x] **M3**: `client.rs` 모듈화 → `client/{error,types,http}.rs` (gRPC 추가 전 선행)

마이그레이션 상세: `aidlc-docs/migration/migration-plan.md` 참조.
