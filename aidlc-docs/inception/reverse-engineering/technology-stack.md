# Technology Stack

Versions are taken from `package.json`, `package-lock.json`, `src-tauri/Cargo.toml`, and `src-tauri/Cargo.lock` (already committed). Values use the lockfile resolution where it is meaningful; otherwise the manifest range is shown.

## Programming Languages

| Language | Version | Usage |
|----------|---------|-------|
| TypeScript | 5.9.3 (manifest `^5.9.3`) | Frontend application code (`src/`). Strict mode (`strict`, `noUnusedLocals`, `noUnusedParameters`, `noFallthroughCasesInSwitch`), `jsx: "react-jsx"`, ES2020 target, bundler module resolution. |
| Rust | Edition 2021, MSRV `1.70` | Backend application code (`src-tauri/src/`). |
| TSX/JSX | n/a | React component syntax. |
| CSS | n/a | Plain CSS, one file per component (Catppuccin Mocha palette). |
| HTML | HTML5 | `index.html` is the Vite entry. |

## Frameworks

| Framework | Version | Purpose |
|-----------|---------|---------|
| React | 19.2.3 (manifest `^19.2.3`) | UI library. Functional components + hooks (`useState`, `useEffect`, `useRef`). Renders under `<React.StrictMode>`. |
| React DOM | 19.2.3 (manifest `^19.2.3`) | DOM renderer for React. |
| Tauri (Rust crate) | 2 (manifest `2`) | Desktop runtime — packages the WebView, hosts the Rust process, exposes the IPC `invoke()` interface. |
| `@tauri-apps/api` | 2.9.1 (manifest `^2.9.1`) | Frontend-side Tauri bindings. Only `invoke` from `@tauri-apps/api/core` is used. |
| `tauri-plugin-shell` | 2 (manifest `2`) | Shell-related capabilities; registered in `main.rs` though no shell calls are currently issued from the studio code. |

## Networking / HTTP

| Library | Version | Purpose |
|---------|---------|---------|
| reqwest | 0.12 (manifest `0.12`, `json` feature) | The only HTTP client. Used by `ByoriDBClient` and the free `test_connection`. Timeouts: 5 s connect, 30 s overall. |

## Async runtime / data

| Library | Version | Purpose |
|---------|---------|---------|
| tokio | 1 (manifest `1`, feature `full`) | Async runtime; `tokio::sync::Mutex` for the singleton client lock. Tests use `#[tokio::test]`. |
| serde | 1 (manifest `1`, feature `derive`) | Wire types for both Tauri IPC and ByoriDB REST. |
| serde_json | 1 (manifest `1`) | JSON parsing for HTTP responses; `serde_json::Value` is used directly in the parsing helpers. |
| anyhow | 1 (manifest `1`) | Error wrapping at the public boundary of the free `test_connection` and the strict `parse_session_id`. |

## Logging / Observability

| Library | Version | Purpose |
|---------|---------|---------|
| tracing | 0.1 (manifest `0.1`) | Structured logging in `main.rs` and `client.rs`. |
| tracing-subscriber | 0.3 (manifest `0.3`, feature `env-filter`) | Initialized in `main.rs::main` with default directive `byoridb_studio=debug`; honors `RUST_LOG`. |

## Build Tools

| Tool | Version | Purpose |
|------|---------|---------|
| Vite | 7.3.1 (manifest `^7.3.1`) | Frontend dev server (port 1420, strict port, ignores `src-tauri/**`) and production bundler. |
| `@vitejs/plugin-react` | 5.1.2 (manifest `^5.1.2`) | React + Fast Refresh integration for Vite. |
| TypeScript compiler (`tsc`) | 5.9.3 | Run as part of `npm run build` before `vite build`. |
| Tauri CLI (`@tauri-apps/cli`) | 2.9.6 (manifest `^2.9.6`) | Drives `tauri dev` and `tauri build`. |
| `tauri-build` (Rust crate) | 2 (manifest `2`) | Build-time integration; invoked from `src-tauri/build.rs`. |
| Cargo | bundled with the toolchain (MSRV 1.70) | Builds the Rust backend; manages dependencies via `Cargo.toml`/`Cargo.lock`. |
| npm | bundled with Node 18+ | Manages frontend dependencies via `package.json`/`package-lock.json`. |

## Testing Tools

### Frontend
| Tool | Version | Purpose |
|------|---------|---------|
| Vitest | 4.1.5 (manifest `^4.1.5`) | Test runner. Configured in `vite.config.ts` (`environment: "jsdom"`, `globals: true`, `setupFiles: "./src/test/setup.ts"`). |
| `@vitest/coverage-v8` | 4.1.5 (manifest `^4.1.5`) | V8 coverage provider; reporters `text` + `html`; includes `src/**/*.{ts,tsx}` excluding `main.tsx` and `vite-env.d.ts`. |
| jsdom | 29.1.1 (manifest `^29.1.1`) | DOM emulation for Vitest. |
| `@testing-library/react` | 16.3.2 (manifest `^16.3.2`) | Component rendering helpers. |
| `@testing-library/dom` | (transitive of `@testing-library/react`) | Underlying DOM querying. |
| `@testing-library/jest-dom` | 6.9.1 (manifest `^6.9.1`) | Custom DOM matchers; imported as `@testing-library/jest-dom/vitest` from `src/test/setup.ts`. |
| `@testing-library/user-event` | 14.6.1 (manifest `^14.6.1`) | Realistic event simulation in tests. |

### Backend
| Tool | Version | Purpose |
|------|---------|---------|
| `cargo test` (built-in) | with the toolchain | Runs the `#[cfg(test)] mod tests` block in `client.rs`. |
| `tokio` test macro | (`tokio` feature `full`) | `#[tokio::test]` for async unit tests. |
| `serde_json::json!` macro | (`serde_json`) | Used in tests to feed parsed JSON literals into the parsing helpers. |

## Type Definitions (devDependencies)

| Package | Version | Purpose |
|---------|---------|---------|
| `@types/react` | 19.2.8 (manifest `^19.2.8`) | React type definitions. |
| `@types/react-dom` | 19.2.3 (manifest `^19.2.3`) | React DOM type definitions. |

## Storage

| Mechanism | Where | Purpose |
|-----------|-------|---------|
| `localStorage` (key `byoridb-studio-connections`) | WebView | Saved server profiles. |
| `localStorage` (key `byoridb-studio-query-history`) | WebView | Last 50 distinct queries entered in `QueryEditor`. |
| Process memory (`Arc<Mutex<Option<ByoriDBClient>>>`) | Rust process | The single authenticated session. Never persisted. |

## Infrastructure

This is a **client-only desktop application**. There is no server, container, or cloud infrastructure to document.

| Element | Status |
|---------|--------|
| Cloud provider / IaC | None — no AWS, GCP, Azure, CDK, Terraform, CloudFormation, etc. |
| Containerization | None — no Dockerfile or compose file. |
| CI/CD | None checked in — manual `npm`/`cargo` workflows only. |
| Distribution | Tauri-bundled installer per OS (`.app`, `.msi`, `.deb`, `.rpm`, `.AppImage`). Driven by `npm run tauri build`. |
| Networking | Outbound HTTP to a user-configured ByoriDB host (default `127.0.0.1:19669`). No inbound listening sockets. |
| Window | One window, 1280×800 default, 900×600 minimum, decorated, opaque (`tauri.conf.json`). CSP `null` (permissive — note for `code-quality-assessment.md`). |

## Build & Dev Commands

| Command | Effect |
|---------|--------|
| `npm install` | Restore frontend deps. |
| `npm run dev` | Vite dev server only (port 1420). |
| `npm run tauri dev` | Spawn the Tauri process and point the WebView at the Vite dev server. |
| `npm run build` | `tsc && vite build` → emits `dist/`. |
| `npm run tauri build` | Bundles `dist/` and the Rust binary into a platform installer. |
| `npm test` | `vitest run` (single shot, jsdom). |
| `npm run coverage` | `vitest run --coverage`; HTML report under `coverage/` (gitignored). |
| `cd src-tauri && cargo build` | Compile Rust backend. |
| `cd src-tauri && cargo check` | Fast borrow/type check. |
| `cd src-tauri && cargo test` | Run Rust unit tests. |

## Prerequisites (from README.md)
- Node.js 18+
- Rust 1.70+
- Tauri CLI prerequisites (platform-specific WebView libraries — see Tauri's official prerequisites guide).
