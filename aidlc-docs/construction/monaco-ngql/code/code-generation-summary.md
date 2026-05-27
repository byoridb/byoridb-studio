# Code Generation Summary — Unit: monaco-ngql

**Generated**: 2026-05-15T09:02:46+09:00

## 신규 생성 파일

| 파일 | 설명 |
|------|------|
| `src/lib/ngql-language.ts` | Monarch 토크나이저, Catppuccin Mocha 테마, `NGQL_KEYWORDS`, `isNgqlKeyword()`, `registerNgqlLanguage()` |
| `src/lib/ngql-language.test.ts` | 단위 테스트 + PBT (fast-check) — 9개 테스트 |

## 수정된 파일

| 파일 | 변경 내용 |
|------|-----------|
| `src/components/QueryEditor.tsx` | `<textarea>` → `@monaco-editor/react` `<Editor>` 교체; ⌘↵/⌘↑/⌘↓ keybinding 재구현; `registerNgqlLanguage` 호출; `data-testid` 추가 |
| `src/components/QueryEditor.test.tsx` | `@monaco-editor/react` mock (`vi.importActual` 기반 async mock); `../lib/ngql-language` mock; 기존 8개 테스트 동작 유지 |
| `vite.config.ts` | `optimizeDeps.include: ["@monaco-editor/react", "monaco-editor"]` 추가 |
| `src/styles/QueryEditor.css` | 라인 번호 div 스타일 제거; `.editor-container`에 `min-height: 0` 추가 |
| `package.json` | `@monaco-editor/react@4.7.0` (runtime), `fast-check@4.8.0` (devDependency) 추가 |

## 검증 결과

| 명령어 | 결과 |
|--------|------|
| `npm run lint` | ✅ 오류 0개 |
| `npm run format:check` | ✅ 통과 |
| `npm run build` | ✅ 성공 (JS 231 kB gzip 72 kB) |
| `npm test` | ✅ 54/54 (기존 45 + ngql-language 9개 신규) |
| `cargo test` | ✅ 16/16 |
