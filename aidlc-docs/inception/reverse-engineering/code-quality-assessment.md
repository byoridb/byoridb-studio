# Code Quality Assessment

This is a snapshot assessment of the codebase as of the reverse engineering timestamp. It is intentionally factual and brownfield-focused: the goal is to surface what exists, what is missing, and the technical debt downstream stages may want to budget for.

## Test Coverage

| Surface | Status | Notes |
|---------|--------|-------|
| **Overall** | Good (for the scope this codebase attempts to test) | All UI components and the Rust client have at least basic coverage. No measured numeric coverage was checked in. |
| **Unit Tests — Frontend** | Good | 45 `it(...)` blocks across 7 test files. Co-located next to components. |
| **Unit Tests — Backend** | Fair | 16 tests in `src-tauri/src/client.rs::tests` (`#[test]` and `#[tokio::test]`). Cover all parsing helpers, error code stability, session-error heuristic, and the two methods that don't need a live server (`NotConnected` enforcement, no-op disconnect). |
| **Integration Tests** | None | No tests exercise an actual ByoriDB server. `CLAUDE.md` and `NEXT.md` acknowledge this — integration relies on manual verification. |
| **End-to-end Tests** | Partial | `src/App.test.tsx` simulates the full connect → query → disconnect UI flow with a mocked `invoke()`, including health-poll teardown via `vi.useFakeTimers`. This is the closest the suite gets to E2E and works only because the Tauri boundary is mockable. |
| **Coverage Tooling** | Configured | `@vitest/coverage-v8` configured in `vite.config.ts` (provider `v8`, reporters `text` + `html`, includes `src/**/*.{ts,tsx}`, excludes `main.tsx` and `vite-env.d.ts`). HTML report under `coverage/` (gitignored). No coverage threshold enforced. |

### Frontend test breakdown
| Test file | `it(...)` blocks |
|-----------|------------------|
| `src/App.test.tsx` | 9 |
| `src/components/Sidebar.test.tsx` | 6 |
| `src/components/QueryEditor.test.tsx` | 8 |
| `src/components/ResultPanel.test.tsx` | 9 |
| `src/components/ServerSettings.component.test.tsx` | 6 |
| `src/components/ServerSettings.test.ts` | 2 |
| `src/components/ConnectionModal.test.tsx` | 5 |
| **Total** | **45** |

### Backend test count
- `src-tauri/src/client.rs::tests` — **16** test functions (mix of `#[test]` and `#[tokio::test]`).

## Code Quality Indicators

| Indicator | Status | Detail |
|-----------|--------|--------|
| **TypeScript strictness** | Strong | `tsconfig.json` enables `strict`, `noUnusedLocals`, `noUnusedParameters`, `noFallthroughCasesInSwitch`. Type-checking runs as part of `npm run build` (`tsc && vite build`). |
| **Rust strictness** | Default | No custom `clippy.toml` or workspace lint config. `cargo build` and `cargo test` rely on default warnings. |
| **JS/TS linting** | **Not configured** | No `.eslintrc*`, `eslint.config.*`, or `prettier.config.*` is committed. The TS compiler catches type errors but not style/formatting issues. |
| **Rust formatting / lints** | **Not configured** | No `rustfmt.toml` or `clippy.toml`; default `rustfmt` and clippy are available but not wired into a script or pre-commit hook. |
| **Code style consistency** | Good | The TS/TSX code follows a single house style (functional components + hooks, `interface` for shapes, JSDoc on public types, defensive normalization at boundaries). The Rust code is similarly cohesive (enum-based errors with `code()` for the wire format, pure parser helpers for testability). No obvious style drift between files. |
| **Documentation (in-code)** | Good | All Tauri commands and `ClientError` variants have doc comments explaining intent. `CLAUDE.md` is unusually thorough and serves as a developer onboarding document. JSDoc is present on TS public types and key helpers (`normalizeError`, `HEALTH_POLL_INTERVAL_MS`, `formatValue`). |
| **Documentation (repo)** | Good | `README.md`, `CLAUDE.md`, `ROADMAP.md`, `NEXT.md` are all present and current (the latter two reflect Phase 1 completion in May 2026). |
| **CI / pre-commit hooks** | None | No `.github/`, `.gitlab-ci.yml`, `.husky/`, or `.pre-commit-config.yaml`. Build, test, and quality checks are manual via npm/cargo. |
| **Dependency lockfiles** | Committed | Both `package-lock.json` and `src-tauri/Cargo.lock` are tracked. |
| **Generated assets in VCS** | Committed | `src-tauri/gen/schemas/` and the iconset PNGs are committed (the latter despite being matched by `.gitignore`'s `src-tauri/icons/*.png` — git's already-tracked rule keeps them present; this is fine but worth knowing). |

## Technical Debt

These are not blocking, but flag them when planning Construction-phase work.

| # | Item | Where | Impact | Notes |
|---|------|-------|--------|-------|
| 1 | **Plain `<textarea>` query editor** (no syntax highlight, no autocomplete) | `src/components/QueryEditor.tsx` | DX | `ROADMAP.md` Phase 2 calls for Monaco Editor integration. Existing tests will need to be re-written or kept as behavioral tests around the wrapper. |
| 2 | **Graph view is a placeholder** | `src/components/ResultPanel.tsx::renderGraph` | Functional gap | `ROADMAP.md` Phase 3.3. No graph-rendering library has been chosen. |
| 3 | **No connection retry/backoff** | `src/App.tsx` health-poll loop | Robustness | Health failure tears down the session immediately. Acceptable for a desktop client but worth revisiting if the studio is run against intermittently flaky networks. |
| 4 | **`SESSION_EXPIRED` heuristic is text-based** | `src-tauri/src/client.rs::is_session_error` | Fragility | Matches `"session not found"` / `"session expired"` substrings (case-insensitive). Server-side `code` is currently the generic `QUERY_ERROR`. Replace with a strict code match when the server adds a dedicated code. The function is unit-tested with both positive and negative cases. |
| 5 | **CSP is `null`** | `src-tauri/tauri.conf.json::app.security.csp` | Defense in depth | Permissive CSP. Acceptable for a local-only desktop tool, but tightening it (e.g. `default-src 'self'; connect-src http://* https://*`) is cheap insurance. |
| 6 | **`tauri-plugin-shell` registered but unused** | `src-tauri/src/main.rs::main` | Surface area | Either start using it or drop the plugin and the dependency. |
| 7 | **Passwords stored in `localStorage`** | `src/components/ServerSettings.tsx` (`saveSavedConnections`) | Security | The studio writes the saved-profile password to `localStorage` in plaintext. WebView storage is per-origin and per-app on disk, but this is still a shared concern with anyone accessing the user's local profile. Tauri 2 has a secret store API and OS keychain plugins; consider migrating before any non-local-only usage. |
| 8 | **No JS/TS linting** | repo-wide | Quality | ESLint + Prettier are absent. Style is consistent now thanks to small surface area; this scales poorly. |
| 9 | **No clippy / rustfmt config or pre-commit** | repo-wide | Quality | Same as #8 for Rust. |
| 10 | **No CI** | repo-wide | Process | No automated build/test verification before merge. Manual `npm test` + `cargo test` workflow is documented in `CLAUDE.md`. |
| 11 | **Server URL hard-codes `http://`** | `src-tauri/src/client.rs` (in every URL builder) | Functional | TLS support would require a configuration option and `https://` URL construction. Currently fine for `localhost` / dev. |
| 12 | **Repeated `QueryResult` / `ConnectionConfig` interfaces in TS** | `src/App.tsx`, `src/components/*.tsx` | Maintenance | Each component re-declares its own copy of the types. Centralizing them (e.g. `src/types.ts`) is a one-screen cleanup. |
| 13 | **Duplicated default `ConnectionConfig`** | `src/components/ConnectionModal.tsx`, `src/components/ServerSettings.tsx` | Maintenance | Two `DEFAULT_CONFIG` constants. Risk: drift between modal default and settings default. |

## Patterns and Anti-patterns

### Good patterns

- **Stable error codes at the IPC boundary** (`ClientError::code()` + `TauriError`). The frontend's `SESSION_EXPIRED` and `AUTH_FAILED` branches read like a state machine, not like text matching.
- **Pure parsing helpers in Rust** kept independent of HTTP — every helper is unit-testable in isolation, which is why the backend test suite has meaningful coverage despite no live server.
- **Defensive `normalizeError`** on the JS side ensures the UI stays well-typed even when `invoke()` rejects with a non-conforming value.
- **Best-effort `disconnect`** that swallows errors rather than leaving the UI in an indeterminate state.
- **Lazy `DESCRIBE` cache, invalidated per space** in `Sidebar.tsx` — schema doesn't refetch needlessly, and a space switch can't show stale type info from a different space.
- **Server-reported `row_count` with `rows.length` fallback** — adapts to older server versions without crashing.
- **Test mocking strategy** — `vi.hoisted` + `vi.mock("@tauri-apps/api/core")` lets every component test exercise its real component while mocking the IPC boundary deterministically.
- **Health poll independent of in-flight queries** — a long query won't be torn down by a failing health check (the check runs on its own timer; it just signals connection-loss to the UI).
- **Strict `parse_session_id`** that rejects strings/missing fields with a descriptive error rather than silently coercing.

### Anti-patterns / smells

- **Multiple sources of truth for the same TS shape** (see Tech Debt #12 / #13). A single `src/types.ts` would resolve this.
- **`alert()` for user-facing failures** in `App.handleConnect` and `Sidebar`'s describe failure inline panel uses an inline error component (good), but `App` and `ServerSettings` both reach for `alert()` / `confirm()`. Acceptable for a desktop tool but a custom toast/notification primitive would be cleaner.
- **Console-logged errors that the user never sees** — many `catch (error) { console.error(...) }` paths in `Sidebar.loadSpaces` / `loadSchema`. A failure here leaves the sidebar empty without explanation. Worth surfacing via the same describe-panel pattern.
- **`DEFAULT_CONFIG` duplicated across `ConnectionModal` and `ServerSettings`** — drift risk.
- **`setExpandedItems(new Set())` patterns in `Sidebar.tsx`** rebuild the set on every toggle. Fine at current scale; flag if we ever expect very large schemas.

## Suggested Quality Improvements (non-blocking)

These are sized as small Construction units that could be tackled in any order.

1. Extract shared TS types into `src/types.ts` (`ConnectionConfig`, `QueryResult`, `SpaceInfo`, `SchemaInfo`, `TauriError`).
2. Add ESLint + Prettier configs and a `npm run lint` script.
3. Add `cargo fmt --check` and `cargo clippy -- -D warnings` to a developer-facing `make check` (or equivalent npm script wrapper).
4. Add a minimal CI workflow (GitHub Actions): `npm ci && npm test && npm run build && (cd src-tauri && cargo test && cargo fmt --check && cargo clippy)`.
5. Tighten `tauri.conf.json::app.security.csp` to a minimum that still allows the studio's runtime needs.
6. Migrate saved passwords from `localStorage` to OS keychain via Tauri's secret store plugin or `tauri-plugin-stronghold`.
7. Centralize sidebar error surfacing into the same panel pattern used for `DESCRIBE` failures.
8. Either consume `tauri-plugin-shell` or remove it.
