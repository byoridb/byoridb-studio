# Code Generation Plan — Unit: tech-debt

**Unit**: tech-debt (기술부채 해소)
**Workspace Root**: /Users/juikkim/byoridb-studio
**Project Type**: Brownfield (Tauri 2 desktop app)
**Requirements Reference**: `aidlc-docs/inception/requirements/requirements.md` (FR-01 ~ FR-06)

---

## Unit Context

- **목적**: 코드 품질 기반 확립 — 린트/포매터/CI/타입 중앙화
- **런타임 동작 변경**: 없음 (순수 도구 설정 + 타입 재배치)
- **기존 테스트 보호**: 45개 프론트엔드 + 16개 백엔드 테스트 전부 통과 유지 필수
- **의존성**: 없음 (다른 unit 없음)

---

## Steps

### Step 1: TypeScript 공통 타입 중앙화 — `src/types.ts` 생성
- [x] `src/types.ts` 신규 생성
- 포함 타입: `ConnectionConfig`, `QueryResult`, `SpaceInfo`, `SchemaInfo`, `TauriError`, `SavedConnection`
- `DEFAULT_CONNECTION_CONFIG` 상수 포함 (기존 두 곳의 `DEFAULT_CONFIG` 통합)
- `loadSavedConnections`, `saveSavedConnections` 헬퍼는 `ServerSettings.tsx`에 유지 (로직 포함이므로 타입 파일 범위 초과)

### Step 2: 컴포넌트 import 경로 수정
- [x] `src/App.tsx` — `ConnectionConfig`, `QueryResult`, `TauriError` → `src/types.ts`에서 import
- [x] `src/components/ConnectionModal.tsx` — `ConnectionConfig`, `SavedConnection` → `src/types.ts`에서 import; `loadSavedConnections`는 `ServerSettings`에서 계속 import
- [x] `src/components/ServerSettings.tsx` — `ConnectionConfig`, `SavedConnection` → `src/types.ts`에서 import; 로컬 선언 제거; `DEFAULT_CONFIG` → `DEFAULT_CONNECTION_CONFIG` from `src/types.ts`
- [x] `src/components/Sidebar.tsx` — `SpaceInfo`, `SchemaInfo`, `QueryResult` → `src/types.ts`에서 import
- [x] `src/components/ResultPanel.tsx` — `QueryResult` → `src/types.ts`에서 import
- [x] `src/components/QueryEditor.tsx` — 타입 변경 없음 (자체 타입 없음)

### Step 3: ESLint 설정 — `eslint.config.ts` 신규 생성
- [x] `eslint.config.ts` 신규 생성 (flat config 형식)
- [x] `package.json` devDependencies에 ESLint 관련 패키지 추가
- [x] `package.json` scripts에 `"lint": "eslint src"`, `"lint:fix": "eslint src --fix"` 추가

### Step 4: Prettier 설정 — `.prettierrc` + `.prettierignore` 신규 생성
- [x] `.prettierrc` 신규 생성 (기존 코드 스타일 기준: 2칸 들여쓰기, 쌍따옴표, 세미콜론)
- [x] `.prettierignore` 신규 생성
- [x] `package.json` devDependencies에 Prettier 관련 패키지 추가
- [x] `package.json` scripts에 `"format"`, `"format:check"` 추가

### Step 5: rustfmt 설정 — `src-tauri/rustfmt.toml` 신규 생성
- [x] `src-tauri/rustfmt.toml` 신규 생성 (기존 코드 스타일 기준)

### Step 6: clippy 설정 — `src-tauri/Cargo.toml` `[lints]` 섹션 추가
- [x] `src-tauri/Cargo.toml`에 `[lints.clippy]` 섹션 추가

### Step 7: GitHub Actions CI — `.github/workflows/ci.yml` 신규 생성
- [x] `.github/workflows/ci.yml` 신규 생성

### Step 8: 코드 생성 요약 문서
- [x] `aidlc-docs/construction/tech-debt/code/code-generation-summary.md` 생성
- 변경된 파일 목록, 신규 파일 목록, 검증 명령어 기록

---

## 파일 변경 요약

| 파일 | 유형 | FR |
|------|------|----|
| `src/types.ts` | 신규 | FR-06 |
| `src/App.tsx` | 수정 (import 경로) | FR-06 |
| `src/components/ConnectionModal.tsx` | 수정 (import 경로) | FR-06 |
| `src/components/ServerSettings.tsx` | 수정 (import 경로 + 로컬 타입 제거) | FR-06 |
| `src/components/Sidebar.tsx` | 수정 (import 경로) | FR-06 |
| `src/components/ResultPanel.tsx` | 수정 (import 경로) | FR-06 |
| `eslint.config.ts` | 신규 | FR-01 |
| `.prettierrc` | 신규 | FR-02 |
| `.prettierignore` | 신규 | FR-02 |
| `package.json` | 수정 (deps + scripts) | FR-01, FR-02 |
| `src-tauri/rustfmt.toml` | 신규 | FR-03 |
| `src-tauri/Cargo.toml` | 수정 (`[lints]` 추가) | FR-04 |
| `.github/workflows/ci.yml` | 신규 | FR-05 |
| `aidlc-docs/construction/tech-debt/code/code-generation-summary.md` | 신규 | — |

---

## 완료 기준 (체크리스트)
- [x] `npm run lint` — 오류 0개
- [x] `npm run format:check` — 통과
- [x] `npm run build` — 성공
- [x] `npm test` — 45개 통과
- [x] `cargo fmt --check` — 통과
- [x] `cargo clippy -- -D warnings` — 경고 0개
- [x] `cargo test` — 16개 통과
