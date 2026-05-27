# Build Instructions

## Prerequisites

| 항목 | 버전 |
|------|------|
| Node.js | 18+ |
| Rust | 1.70+ (MSRV) |
| npm | Node.js 번들 |
| Tauri CLI | `@tauri-apps/cli ^2.9.6` (devDependency) |

## Build Steps

### 1. Install Dependencies
```bash
npm install
```

### 2. Frontend Build (TypeScript + Vite)
```bash
npm run build
# tsc (타입 체크) → vite build → dist/ 생성
```

### 3. Full Desktop App Build (Tauri)
```bash
npm run tauri build
# npm run build 실행 후 Rust 바이너리 컴파일 → 플랫폼 인스톨러 생성
```

### 4. Rust Backend Only
```bash
cd src-tauri && cargo build
```

## Verify Build Success

- **Frontend**: `dist/index.html`, `dist/assets/` 생성 확인
- **Desktop**: macOS → `src-tauri/target/release/bundle/` 하위 `.app` 생성
- **Bundle size (현재)**: JS ~212 kB (gzip ~66 kB), CSS ~17 kB (gzip ~3 kB)

## Troubleshooting

### `tsc` 오류
- `src/types.ts` import 경로 확인 — 상대 경로 `../types` (컴포넌트에서) 또는 `./types` (App.tsx에서)

### Tauri 빌드 실패
- macOS: Xcode Command Line Tools 설치 필요 (`xcode-select --install`)
- WebView 의존성: Tauri 공식 prerequisites 가이드 참조
