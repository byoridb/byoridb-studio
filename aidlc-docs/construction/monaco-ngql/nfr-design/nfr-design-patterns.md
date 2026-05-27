# NFR Design — Unit: monaco-ngql

## 패턴 및 설계 결정

### 1. Monaco Worker 처리 (Vite 7 호환)

`@monaco-editor/react`는 내부적으로 Monaco의 web worker를 사용합니다. Vite 7에서는 worker URL을 명시적으로 처리해야 합니다.

**접근법**: `vite.config.ts`에 `optimizeDeps.include`와 `build.rollupOptions` 설정 추가.

```ts
// vite.config.ts 추가 설정
optimizeDeps: {
  include: ["@monaco-editor/react", "monaco-editor"],
}
```

### 2. Monaco Mock 전략 (테스트)

jsdom 환경에서 Monaco는 DOM API 부재로 렌더링 불가. `vi.mock`으로 `@monaco-editor/react`를 단순 `<textarea>`로 대체합니다.

```ts
// 테스트 파일 상단
vi.mock("@monaco-editor/react", () => ({
  default: ({ value, onChange, onMount }: MockEditorProps) => (
    <textarea
      data-testid="monaco-editor"
      value={value}
      onChange={(e) => onChange?.(e.target.value)}
    />
  ),
}));
```

### 3. PBT 설계 — 토크나이저 검증

`src/lib/ngql-language.ts`에서 키워드 집합을 export하여 테스트에서 재사용합니다.

```ts
// ngql-language.ts에서 export
export const NGQL_KEYWORDS: readonly string[] = [
  "MATCH", "GO", "FETCH", "LOOKUP", "FIND", "RETURN", "YIELD",
  // ... 전체 목록
];

export function isNgqlKeyword(word: string): boolean {
  return NGQL_KEYWORDS.includes(word.toUpperCase());
}
```

**PBT Invariant**:
- `isNgqlKeyword(kw)` === `isNgqlKeyword(kw.toLowerCase())` (대소문자 무관)
- `isNgqlKeyword(kw)` === `true` for all `kw` in `NGQL_KEYWORDS`
- `isNgqlKeyword(nonKeyword)` === `false` for arbitrary non-keyword strings

### 4. Catppuccin Mocha 테마 매핑

기존 CSS 변수(`src/styles/index.css`)에서 색상값을 추출하여 Monaco 테마에 적용합니다.

| Monaco 역할 | Catppuccin Mocha 색상 | CSS 변수 |
|-------------|----------------------|----------|
| 에디터 배경 | `#1e1e2e` (Base) | `--bg-primary` |
| 기본 텍스트 | `#cdd6f4` (Text) | `--text-primary` |
| DDL 키워드 | `#cba6f7` (Mauve) | — |
| DQL 키워드 | `#89b4fa` (Blue) | `--accent-primary` |
| DML 키워드 | `#f38ba8` (Red) | — |
| 문자열 | `#a6e3a1` (Green) | — |
| 숫자 | `#fab387` (Peach) | — |
| 주석 | `#6c7086` (Overlay0) | `--text-muted` |
| 연산자 | `#89dceb` (Sky) | — |

## 논리 컴포넌트

```
src/
├── lib/
│   ├── ngql-language.ts        # Monarch 토크나이저 + NGQL_KEYWORDS export + isNgqlKeyword()
│   └── ngql-language.test.ts   # PBT + 단위 테스트
└── components/
    ├── QueryEditor.tsx          # Monaco Editor 통합 (기존 파일 수정)
    └── QueryEditor.test.tsx     # Monaco mock 기반 테스트 (기존 파일 수정)
```
