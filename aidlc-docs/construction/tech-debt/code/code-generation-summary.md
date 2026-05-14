# Code Generation Summary — Unit: tech-debt

**Generated**: 2026-05-14T19:40:38+09:00

## 신규 생성 파일

| 파일 | 설명 |
|------|------|
| `src/types.ts` | TypeScript 공통 타입 중앙화 (`ConnectionConfig`, `QueryResult`, `SpaceInfo`, `SchemaInfo`, `TauriError`, `SavedConnection`, `DEFAULT_CONNECTION_CONFIG`) |
| `eslint.config.ts` | ESLint flat config (TypeScript + React Hooks + React Refresh) |
| `.prettierrc` | Prettier 설정 (2칸 들여쓰기, 쌍따옴표, 세미콜론, printWidth 100) |
| `.prettierignore` | Prettier 제외 경로 |
| `src-tauri/rustfmt.toml` | rustfmt 설정 (edition 2021, max_width 100) |
| `.github/workflows/ci.yml` | GitHub Actions CI (macOS, Node 20, Rust stable) |

## 수정된 파일

| 파일 | 변경 내용 |
|------|-----------|
| `src/App.tsx` | 로컬 `ConnectionConfig`, `QueryResult`, `TauriError` 선언 제거 → `src/types.ts` import |
| `src/components/ConnectionModal.tsx` | 로컬 `ConnectionConfig`, `SavedConnection`, `DEFAULT_CONFIG` 제거 → `src/types.ts` import |
| `src/components/ServerSettings.tsx` | 로컬 `ConnectionConfig`, `SavedConnection`, `DEFAULT_CONFIG` 제거 → `src/types.ts` import; `export type { ... }` re-export 추가 |
| `src/components/Sidebar.tsx` | 로컬 `SpaceInfo`, `SchemaInfo`, `QueryResult` 제거 → `src/types.ts` import |
| `src/components/ResultPanel.tsx` | 로컬 `QueryResult` 제거 → `src/types.ts` import |
| `package.json` | devDependencies 추가 (eslint, typescript-eslint, prettier 등); scripts 추가 (`lint`, `lint:fix`, `format`, `format:check`) |
| `src-tauri/Cargo.toml` | `[lints.clippy] all = "warn"` 추가 |
| `src-tauri/src/client.rs` | `cargo fmt` 적용 (스타일 정규화) |
| `src-tauri/src/main.rs` | `cargo fmt` 적용 (스타일 정규화) |
| `src/**/*.{ts,tsx,css}` | `prettier --write` 적용 (스타일 정규화) |

## 검증 결과

| 명령어 | 결과 |
|--------|------|
| `npm run lint` | ✅ 오류 0개 (경고 7개 — 기존 코드 패턴, non-blocking) |
| `npm run format:check` | ✅ 통과 |
| `npm run build` | ✅ 성공 |
| `npm test` | ✅ 45/45 통과 |
| `cargo fmt --check` | ✅ 통과 |
| `cargo clippy -- -D warnings` | ✅ 경고 0개 |
| `cargo test` | ✅ 16/16 통과 |
