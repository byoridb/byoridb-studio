# ByoriDB Studio

Desktop management tool for [ByoriDB](https://github.com/byoridb/byoridb) — a distributed graph database with nGQL support.

> ⚠️ **개발 중 (Under active development)**
>
> 본 프로젝트는 현재 활발한 개발 단계에 있습니다. API, UI, 기능 사양은 사전 공지 없이 변경될 수 있으며 일부 기능은 미완성 상태입니다. 프로덕션 환경 사용은 권장하지 않습니다.
>
> *This project is under active development. APIs, UI, and feature specifications may change without notice, and some features remain incomplete. Production use is not recommended.*

---

## Features

### 연결 관리 / Connection
- 다중 ByoriDB 서버 프로파일 저장·전환 (host/port/credentials)
- 30초 주기 헬스체크 폴링 + 자동 재연결 모달
- 구조화된 에러 코드 (`AUTH_FAILED`, `SESSION_EXPIRED`, `QUERY_ERROR`, …)

### 쿼리 에디터 / Query Editor
- Monaco 기반 다중 탭 에디터
- nGQL 키워드·연산자·문자열 시맨틱 하이라이트 (Catppuccin Mocha)
- `⌘↵` 전체 실행 · `⌘⇧↵` 선택 영역 실행 · `⌘↑/↓` 히스토리
- 스니펫 드롭다운, 실행 취소(Cancel), 쿼리 히스토리(즐겨찾기)

### 결과 패널 / Result Panel
- 가상화 테이블 뷰 (큰 결과 셋 부드러운 스크롤)
- JSON / Table / Graph 보기 전환
- 셀 클릭 복사, CSV/JSON 내보내기
- 컬럼 정렬

### 스키마 관리 / Schema Manager
- **Spaces**: CREATE/DROP, 현재 스페이스 표시 + 자동 `USE`
- **Tags / Edges**: 생성·삭제, 필드 상세 인라인 표시, 이름 검색
- **Indexes**: `SHOW TAG/EDGE INDEXES` 목록, REBUILD/DROP, 생성 폼
- **Statistics**: `SHOW STATS` 기반 tag·edge별 레코드 수, 전체 합계
- **ERD**: 데이터 샘플링으로 tag 간 edge 관계 추론, 컬러 노드 + dangling edge 점선 표시

### 사이드바
- 상단 탭 `Schema · Manage · Data`, 하단 풋터 `📊 Monitor · 🕒 History · ⚙️ Settings`
- 폭 드래그 가능 (180~600px, 설정 영속화)

### 기타
- macOS / Windows / Linux 빌드 지원 (Tauri 2)
- 가벼운 크기 (~5 MB DMG)
- 다국어 (한국어 / 영어)

---

## nGQL 호환 안내

ByoriDB는 nGQL 표준을 따르지만 일부 표현은 아직 미구현 상태입니다. 현재 ByoriDB Studio가 권장하는 패턴:

```sql
-- 프로퍼티 명시 (가장 안정)
MATCH (v:person) RETURN v.person.name, v.person.age, v.person.city LIMIT 100

-- 인덱스 기반 조회
LOOKUP ON person YIELD person.name, person.age LIMIT 100

-- VID 알 때 빠른 조회
FETCH PROP ON person 1, 2, 3

-- 집계
MATCH (n:person) RETURN COUNT(*) AS cnt
MATCH (n:person) RETURN n.person.city AS city, COUNT(*) AS cnt
GROUP BY n.person.city ORDER BY cnt DESC LIMIT 10
```

`RETURN v` (vertex 객체 반환) · `properties(v)` · `RETURN v.*` 등 일부 nGQL 표현은 ByoriDB 서버에서 구현 진행 중입니다.

---

## Development

### Prerequisites

- Node.js 22+
- Rust 1.70+
- [Tauri CLI](https://tauri.app/start/prerequisites/)
- macOS / Windows / Linux

### Setup

```bash
# 의존성 설치
npm install

# 개발 모드 (Vite + Tauri)
npm run tauri dev

# 프로덕션 빌드 (macOS: .dmg + .app)
npm run tauri build
```

### Testing

```bash
# 프론트엔드 (Vitest + Testing Library + jsdom)
npm test
npm run coverage

# 백엔드 (cargo test)
cd src-tauri && cargo test
```

### Quality Gates

```bash
npm run lint           # ESLint
npm run format:check   # Prettier
cd src-tauri && cargo fmt --check
cd src-tauri && cargo clippy --all-targets --no-default-features -- -D clippy::correctness
```

CI는 GitHub Actions (`.github/workflows/ci.yml`)에서 위 게이트 + 테스트를 모두 자동 실행합니다.

### Project Structure

```
byoridb-studio/
├── src/                    # React frontend
│   ├── components/         # UI components (+ co-located *.test.tsx)
│   │   ├── ConnectionModal.tsx
│   │   ├── QueryEditor.tsx       # Monaco 기반 에디터
│   │   ├── ResultPanel.tsx       # 결과 뷰 (Table/JSON/Graph)
│   │   ├── TableView.tsx         # 가상화 테이블
│   │   ├── GraphView.tsx         # cytoscape 그래프
│   │   ├── SchemaManager.tsx     # 스키마/인덱스/통계/ERD 통합
│   │   ├── ErdDiagram.tsx        # NebulaGraph Studio 스타일 ERD
│   │   ├── MonitorPanel.tsx      # 메트릭/서버 상태
│   │   ├── HistoryPanel.tsx
│   │   ├── DataManager.tsx
│   │   ├── ServerSettings.tsx
│   │   └── Sidebar.tsx
│   ├── hooks/              # useConnection, useQueryExecution, useSchemaData, useToast
│   ├── lib/                # ngql-language, graph-parser, query-tabs, i18n
│   ├── styles/             # 컴포넌트별 CSS (Catppuccin Mocha)
│   ├── test/               # Vitest setup
│   ├── types.ts            # 공유 TypeScript 타입
│   ├── App.tsx
│   └── main.tsx
├── src-tauri/              # Tauri/Rust backend
│   ├── src/
│   │   ├── main.rs         # Tauri commands (connect, query, fetch_metrics, …)
│   │   └── client.rs       # ByoriDB HTTP API 클라이언트 (+ 단위 테스트)
│   ├── icons/              # 앱 아이콘 (icns/ico/PNG)
│   ├── Cargo.toml
│   └── tauri.conf.json
├── aidlc-docs/             # AI-DLC 산출물 (audit, migration, …)
├── .github/workflows/ci.yml
├── package.json
└── vite.config.ts
```

### Tauri 커맨드 목록

| Command | 설명 |
|---|---|
| `connect` / `disconnect` | 세션 인증 / 종료 |
| `execute_query` | 결과 셋 반환 쿼리 |
| `execute_statement` | DDL/DML (반환 행 없음) |
| `cancel_query` | 실행 중 쿼리 취소 |
| `get_spaces` / `get_schema` | 스페이스·스키마 조회 |
| `get_indexes` | `SHOW TAG/EDGE INDEXES ON <name>` |
| `test_connection` | 헬스체크 |
| `fetch_metrics` | Prometheus metrics 프록시 (WebView CSP 우회) |

---

## ByoriDB 서버

ByoriDB 서버 자체에 대한 정보는 [byoridb 리포지토리](https://github.com/byoridb/byoridb)를 참조하세요. 기본 포트:

| 프로토콜 | 포트 |
|---|---|
| HTTP REST (Studio 사용) | `19669` |
| gRPC (byoridb-client 라이브러리용) | `9669` |

루트 비밀번호는 서버 시작 시 `BYORIDB_ROOT_PASSWORD` 환경변수로 지정하며, 미지정 시 무작위 48자 hex가 자동 생성되어 로그에 한 번만 출력됩니다.

```bash
# 로컬 개발 예시
BYORIDB_ROOT_PASSWORD=byoridb-dev cargo run --release --bin byoridb-server
```

---

## Tech Stack

- **Frontend**: React 19, TypeScript 5, Vite 7
- **Editor**: Monaco Editor + 자체 nGQL Monarch tokenizer
- **Graph**: Cytoscape.js
- **Backend**: Rust, Tauri 2, reqwest
- **Testing**: Vitest, Testing Library, jsdom, fast-check (frontend); `cargo test` (backend)
- **Styling**: CSS variables (Catppuccin Mocha 라이트/다크 테마)

---

## Roadmap

마이그레이션 상세는 [`aidlc-docs/migration/migration-plan.md`](./aidlc-docs/migration/migration-plan.md) 참조.

진행 중인 작업과 다음 작업은 [`NEXT.md`](./NEXT.md), 장기 계획은 [`ROADMAP.md`](./ROADMAP.md) 를 확인하세요.

---

## License

Apache-2.0
