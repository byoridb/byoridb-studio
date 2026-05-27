# Code Generation Plan — Unit: monaco-ngql

**Unit**: monaco-ngql (Monaco Editor + nGQL 구문 강조)
**Workspace Root**: /Users/juikkim/byoridb-studio
**Requirements**: `aidlc-docs/inception/requirements/requirements-phase2.md`
**NFR Design**: `aidlc-docs/construction/monaco-ngql/nfr-design/nfr-design-patterns.md`

---

## Steps

### Step 1: 패키지 설치
- [x] `npm install @monaco-editor/react@4.7.0`
- [x] `npm install --save-dev fast-check@4.8.0`

### Step 2: `src/lib/ngql-language.ts` 신규 생성
- [x] `src/lib/ngql-language.ts` 신규 생성

### Step 3: `src/lib/ngql-language.test.ts` 신규 생성
- [x] `src/lib/ngql-language.test.ts` 신규 생성 (9 tests: 단위 + PBT)

### Step 4: `src/components/QueryEditor.tsx` 수정
- [ ] `@monaco-editor/react` import 추가
- [ ] `<textarea>` + 라인 번호 div → `<Editor>` 컴포넌트로 교체
- [ ] Monaco keybinding으로 ⌘↵ (execute), ⌘↑/↓ (history) 재구현
- [ ] `onMount` 콜백에서 `registerNgqlLanguage` 호출
- [ ] `isConnected=false` 시 `options={{ readOnly: true }}` 적용
- [ ] 샘플 쿼리 버튼 클릭 시 Monaco `setValue` API 사용
- [ ] Clear 버튼 시 Monaco `setValue("")` 사용

### Step 5: `src/components/QueryEditor.test.tsx` 수정
- [ ] `@monaco-editor/react` mock 추가 (`vi.mock`)
- [ ] mock Editor를 `data-testid="monaco-editor"` textarea로 구현
- [ ] 기존 8개 테스트 동작 유지 (실행, 히스토리, 단축키, 샘플 쿼리, Clear, disabled 상태)

### Step 6: `vite.config.ts` 수정 (Monaco worker 처리)
- [ ] `optimizeDeps.include`에 `monaco-editor` 관련 항목 추가

### Step 7: `src/styles/QueryEditor.css` 수정
- [ ] `.editor-container` 높이 조정 (Monaco는 명시적 height 필요)
- [ ] 라인 번호 div 관련 스타일 제거 (Monaco 내장 라인 번호 사용)

### Step 8: 코드 생성 요약 문서
- [ ] `aidlc-docs/construction/monaco-ngql/code/code-generation-summary.md` 생성

---

## 파일 변경 요약

| 파일 | 유형 | FR |
|------|------|----|
| `src/lib/ngql-language.ts` | 신규 | FR-02, FR-03 |
| `src/lib/ngql-language.test.ts` | 신규 | NFR-04 (PBT) |
| `src/components/QueryEditor.tsx` | 수정 | FR-01 |
| `src/components/QueryEditor.test.tsx` | 수정 | NFR-02 |
| `vite.config.ts` | 수정 | NFR-01 |
| `src/styles/QueryEditor.css` | 수정 | FR-01 |
| `package.json` | 수정 (deps) | FR-01, NFR-04 |

---

## 완료 기준
- [x] `npm run lint` — 오류 0개
- [x] `npm run format:check` — 통과
- [x] `npm run build` — 성공
- [x] `npm test` — 54/54 통과 (QueryEditor 8개 + ngql-language 9개 PBT 포함)
- [x] `cargo test` — 16개 통과
