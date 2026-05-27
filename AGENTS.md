# AGENTS.md — ByoriDB Studio

> 본 코드베이스에서 AI 코딩 에이전트(Claude / Cursor / Q Developer / Cline 등)가 따라야 할 공통 규칙.
> 최초 작성: 2026-05-21 (brownfield-onboard). 변경 이력은 `aidlc-docs/onboard/onboard-notes.md` 참조.

---

## 빠른 진입

```bash
# 의존성 설치
npm install

# 개발 서버 (Vite + Tauri 동시 기동)
npm run tauri dev

# 프론트엔드만 (Tauri 없이, http://localhost:1420)
npm run dev

# 프로덕션 빌드
npm run tauri build

# 프론트엔드 테스트 (Vitest, jsdom)
npm test
npm run coverage    # 커버리지 리포트 → coverage/index.html

# Rust 백엔드
cd src-tauri && cargo check    # 빠른 타입체크
cd src-tauri && cargo test     # Rust 단위 테스트
cd src-tauri && cargo build    # 전체 빌드
```

---

## 디렉토리 구조

```
byoridb-studio/
├── src/                         # React 프론트엔드
│   ├── App.tsx                  # 루트 컴포넌트 — 연결/쿼리 상태 관리 ⚠️ 분리 예정
│   ├── main.tsx                 # React 진입점 (수정 불필요)
│   ├── components/              # UI 컴포넌트 — 새 컴포넌트는 여기에
│   │   ├── ConnectionModal.tsx  # 초기 연결 다이얼로그
│   │   ├── QueryEditor.tsx      # 쿼리 입력 (현재 textarea → Monaco 교체 예정)
│   │   ├── ResultPanel.tsx      # 결과 테이블 / JSON 뷰
│   │   ├── ServerSettings.tsx   # 저장된 서버 프로필 관리 (localStorage)
│   │   └── Sidebar.tsx          # 스키마 브라우저 + DESCRIBE 캐시 ⚠️ 분리 예정
│   ├── styles/                  # 컴포넌트별 CSS ⚠️ 향후 CSS 접근법 변경 예정
│   └── test/
│       └── setup.ts             # 전역 테스트 설정 (localStorage 모킹)
├── src-tauri/
│   └── src/
│       ├── main.rs              # Tauri IPC 커맨드 라우터 — 새 커맨드는 여기 등록
│       └── client.rs            # ByoriDB HTTP API 클라이언트 — API 변경 시 여기
├── aidlc-docs/                  # AI-DLC 산출물 (감사 / 마이그레이션 문서)
├── CLAUDE.md                    # Claude Code 전용 추가 안내
├── AGENTS.md                    # 이 파일 — AI 에이전트 공통 규칙
├── NEXT.md                      # 즉시 착수 punch list (세션 시작 시 확인)
└── ROADMAP.md                   # 장기 계획 (Phase 1~7)
```

---

## 컨벤션

### 네이밍

| 대상 | 규칙 | 예시 |
|---|---|---|
| TypeScript 변수/함수 | `camelCase` | `handleConnect`, `queryResult` |
| TypeScript 컴포넌트/인터페이스 | `PascalCase` | `ConnectionModal`, `QueryResult` |
| TypeScript 상수 | `SCREAMING_SNAKE_CASE` | `HEALTH_POLL_INTERVAL_MS` |
| Rust 함수/변수/필드 | `snake_case` | `parse_query_response`, `session_id` |
| Rust struct/enum/trait | `PascalCase` | `ByoriDBClient`, `ClientError` |
| 컴포넌트 파일 | `PascalCase.tsx` | `QueryEditor.tsx` |
| 테스트 파일 | `PascalCase.test.tsx` (컴포넌트 옆에 배치) | `QueryEditor.test.tsx` |

### 폴더 구조

현재는 계층 기반(`components/`, `styles/`). 향후 Phase 2+ 신규 기능은 `src/features/<name>/` 패턴으로 feature 기반 분리 예정. 기존 컴포넌트 수정 시 현재 구조 유지.

### 에러 처리

**Rust 측**:
- 에러 타입: `ClientError` enum (variant per failure mode). 새 에러 케이스 추가 시 `ClientError` + `code()` 메서드 양쪽 업데이트.
- Tauri 커맨드 반환형: 반드시 `Result<T, TauriError>`. `anyhow::Result`는 내부 헬퍼 전용.
- `From<ClientError> for TauriError` 구현을 통해 `?` 연산자로 변환.

**TypeScript 측**:
- 모든 `invoke()` 에러는 `normalizeError(err)` 헬퍼 통과 후 `{ code, message }` 형태로 처리.
- `error.code` 기반 분기 (`"SESSION_EXPIRED"`, `"AUTH_FAILED"` 등). raw string 직접 비교 금지.
- `alert()` 직접 호출은 레거시 패턴. 신규 코드에서는 `queryResult.error` 또는 React 상태로 에러 표시.

### 로깅

- **Rust**: `tracing::info!` / `tracing::warn!` / `tracing::error!` 사용. `println!` / `eprintln!` 직접 사용 금지.
- **TypeScript**: `console.error()`는 에러 경로에만 허용. 디버그용 `console.log()`는 커밋 전 반드시 제거.

### 테스트

**Rust 단위 테스트**:
- 위치: `client.rs` 내 `#[cfg(test)] mod tests` 블록
- 범위: `parse_*` 등 순수 함수는 단위 테스트 필수
- fixture: `serde_json::json!` 매크로 사용
- 비동기: `#[tokio::test]`

**TypeScript 테스트**:
- 위치: 컴포넌트 파일과 같은 디렉토리 (`*.test.tsx`)
- IPC 격리: `vi.mock("@tauri-apps/api/core")` + `invokeMock`
- 패턴: `userEvent` + `waitFor` (비동기), `vi.useFakeTimers` (타이머)
- 전역 설정: `src/test/setup.ts` (localStorage 모킹 포함)

**의무**: 새 기능 / 버그 수정에는 최소 happy path + 에러 케이스 테스트 포함.

---

## 금지 사항

| 금지 | 이유 |
|---|---|
| 시크릿 / 자격증명 하드코딩 | `BYORIDB_ROOT_PASSWORD` 등은 env var로만 처리 |
| `.env` 파일 커밋 | `.gitignore`에 포함됨. 절대 커밋 금지 |
| `println!` / `eprintln!` (Rust) | `tracing` 매크로 사용 |
| `console.log` 커밋 (TypeScript) | 커밋 전 제거 필수 |
| `any` 타입 (TypeScript) | `tsconfig.json` strict 모드 — `unknown` + 타입 가드 사용 |
| Tauri IPC 서명 단방향 변경 | `main.rs` 커맨드와 프론트 `invoke()` 타입은 항상 동기화 |
| 테스트 없는 신규 로직 PR | 단위 테스트 또는 통합 테스트 필수 |

---

## AI 에이전트 작업 룰

1. **큰 변경 (5파일 이상)**: plan을 먼저 제시하고 사용자 확인 후 진행.
2. **라이브러리 추가 / 변경**: `package.json` 또는 `Cargo.toml` 변경 사유를 commit message에 포함.
3. **새 Tauri 커맨드 추가 순서**: `client.rs` 로직 → `main.rs` 커맨드 등록 → 프론트 `invoke()` 타입 정의.
4. **`App.tsx` 수정**: god-component 악화를 방지하기 위해 새 로직은 커스텀 훅으로 분리 우선 검토.
5. **`Sidebar.tsx` 수정**: DESCRIBE 캐시 로직과 UI 로직을 혼합 확대하지 않음.
6. **Rust 변경 후**: `cargo check` 타입체크 + `cargo test` 통과 확인.
7. **세션 시작 시**: `NEXT.md` 확인 후 작업 우선순위 파악.

---

## 변경 이력

본 문서는 회고(retro) 결과 및 주요 아키텍처 결정에 따라 업데이트됩니다.
변경 시 `aidlc-docs/onboard/onboard-notes.md`에 사유 기록.
