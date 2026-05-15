# Requirements Document — Phase 2: Monaco Editor + nGQL 구문 강조

## Intent Analysis Summary

| 항목 | 내용 |
|------|------|
| **User Request** | ROADMAP Phase 2 구현 — Monaco Editor 통합 + nGQL 구문 강조 |
| **Request Type** | Enhancement (기존 QueryEditor 컴포넌트 업그레이드) |
| **Scope** | 프론트엔드 단일 컴포넌트 (`QueryEditor.tsx`) + 새 언어 정의 파일 |
| **Complexity** | Moderate — Monaco API 학습 곡선 있으나 범위는 명확 |
| **Key Constraint** | 기존 단축키(⌘↵, ⌘↑/↓)·히스토리·샘플 쿼리 버튼 동작 유지 |

---

## Functional Requirements

### FR-01: Monaco Editor 통합
- **설명**: `QueryEditor.tsx`의 `<textarea>` 기반 에디터를 `@monaco-editor/react`로 교체한다.
- **유지해야 할 동작**:
  - ⌘↵ (Ctrl+Enter) — 쿼리 실행
  - ⌘↑ / ⌘↓ (Ctrl+Up/Down) — 히스토리 탐색
  - 샘플 쿼리 버튼 클릭 시 에디터에 쿼리 삽입 후 포커스
  - Clear 버튼 — 에디터 내용 초기화
  - `isConnected=false` 시 에디터 비활성화 (읽기 전용)
  - 쿼리 히스토리 localStorage 저장/복원 (`byoridb-studio-query-history`)
- **완료 기준**:
  - Monaco 에디터가 렌더링된다.
  - 기존 `QueryEditor.test.tsx` 8개 테스트가 모두 통과하거나 동등한 커버리지로 재작성된다.

### FR-02: nGQL 언어 정의 (구문 강조)
- **설명**: Monaco용 nGQL 토크나이저를 `src/lib/ngql-language.ts`에 정의하고 등록한다 (`monaco.languages.register` + `monaco.languages.setMonarchTokensProvider`).
- **토큰 분류** (CLAUDE.md nGQL 레퍼런스 기준):
  - **DDL 키워드**: `CREATE`, `DROP`, `ALTER`, `SHOW`, `DESCRIBE`
  - **DML 키워드**: `INSERT`, `UPDATE`, `DELETE`
  - **DQL 키워드**: `MATCH`, `GO`, `FETCH`, `LOOKUP`, `FIND`, `RETURN`, `YIELD`, `WHERE`, `FROM`, `OVER`, `STEPS`, `PATH`, `SHORTEST`
  - **공통 키워드**: `USE`, `ON`, `AS`, `IN`, `NOT`, `AND`, `OR`, `LIMIT`, `OFFSET`, `ORDER`, `BY`, `ASC`, `DESC`, `VERTEX`, `EDGE`, `TAG`, `SPACE`, `PROP`, `VALUES`, `SET`
  - **데이터 타입**: `BOOL`, `INT8`, `INT16`, `INT32`, `INT64`, `FLOAT`, `DOUBLE`, `STRING`, `TIMESTAMP`, `DATE`, `DATETIME`
  - **문자열 리터럴**: 작은따옴표 / 큰따옴표
  - **숫자 리터럴**: 정수, 소수
  - **주석**: `#` 한 줄 주석, `//` 한 줄 주석
  - **연산자**: `->`, `<-`, `|`, `==`, `!=`, `>=`, `<=`, `>`, `<`
  - **특수 변수**: `$^`, `$$`, `$var` 패턴
- **완료 기준**: `MATCH (n:person) RETURN n` 같은 쿼리에서 키워드·문자열·숫자가 색상 구분된다.

### FR-03: Catppuccin Mocha 테마 적용
- **설명**: Monaco 에디터의 색상 테마를 기존 앱 테마(Catppuccin Mocha)에 맞춰 커스텀 정의한다 (`monaco.editor.defineTheme`).
- **완료 기준**: 에디터 배경·텍스트·키워드 색상이 앱 나머지 UI와 어울린다.

---

## Non-Functional Requirements

### NFR-01: 성능
- Monaco 에디터 초기 로딩이 앱 시작을 블로킹하지 않아야 한다 (lazy import 또는 `@monaco-editor/react`의 기본 lazy loading 활용).
- 번들 크기 증가는 허용하되, Monaco worker 파일은 Vite 설정으로 올바르게 처리해야 한다.

### NFR-02: 신뢰성
- 기존 `QueryEditor.test.tsx` 8개 테스트가 통과하거나 동등한 커버리지로 재작성된다.
- 나머지 37개 프론트엔드 테스트 + 16개 백엔드 테스트는 변경 없이 통과해야 한다.

### NFR-03: 보안 (Security Baseline — full blocking)
- `SECURITY-01`, `SECURITY-02`: N/A (자체 저장소·서버 없음, 이번 변경과 무관).

### NFR-04: 테스트 가능성 (PBT — full blocking)
- nGQL 토크나이저(`ngql-language.ts`)는 순수 함수로 구현하여 단위 테스트 가능하게 한다.
- PBT 적용 대상: 토크나이저의 토큰 분류 함수 — 임의의 nGQL 키워드 입력에 대해 올바른 토큰 타입을 반환하는 invariant 검증.
- PBT 프레임워크: `fast-check` (Vitest와 호환).

---

## 제외 범위

| 항목 | 이유 |
|------|------|
| 자동완성 (Autocomplete) | ROADMAP Phase 2.2 — 별도 워크플로우 |
| 멀티 탭 | ROADMAP Phase 2.3 |
| 쿼리 포매팅 | ROADMAP Phase 2.3 |
| 선택 영역만 실행 | ROADMAP Phase 2.3 |

---

## 수용 기준

- [ ] Monaco 에디터가 앱에서 렌더링된다
- [ ] ⌘↵ 실행, ⌘↑/↓ 히스토리, Clear, 샘플 쿼리 버튼 동작 유지
- [ ] `isConnected=false` 시 에디터 읽기 전용
- [ ] nGQL 키워드 구문 강조 동작
- [ ] Catppuccin Mocha 테마 적용
- [ ] `npm run lint` — 오류 0개
- [ ] `npm run format:check` — 통과
- [ ] `npm run build` — 성공
- [ ] `npm test` — 전체 통과 (QueryEditor 테스트 포함)
- [ ] `cargo test` — 16개 통과
