# NFR Requirements — Unit: monaco-ngql

## 성능 (Performance)

| 항목 | 요구사항 | 근거 |
|------|----------|------|
| 초기 로딩 | Monaco 에디터 로딩이 앱 시작을 블로킹하지 않음 | `@monaco-editor/react`의 기본 lazy loading 활용 |
| 번들 크기 | Monaco worker 파일이 Vite에서 올바르게 처리됨 | `vite.config.ts`에 `worker` 설정 추가 필요 |
| 에디터 반응성 | 타이핑 지연 없음 (Monaco 기본 성능으로 충분) | 데스크톱 앱, 단일 에디터 인스턴스 |

## 신뢰성 (Reliability)

| 항목 | 요구사항 |
|------|----------|
| 기존 테스트 | QueryEditor 8개 + 나머지 37개 프론트엔드 + 16개 백엔드 전부 통과 |
| Monaco mock | jsdom 환경에서 Monaco를 mock하여 테스트 가능하게 함 |
| 단축키 유지 | ⌘↵, ⌘↑/↓ 동작 Monaco keybinding API로 재구현 |

## 보안 (Security Baseline)

- **SECURITY-01**: N/A — 자체 데이터 저장소 없음
- **SECURITY-02**: N/A — 서버/로드밸런서 없음

## 테스트 가능성 (PBT — full blocking)

### PBT 적용 대상 식별

`src/lib/ngql-language.ts`의 Monarch 토크나이저 규칙은 순수 데이터(정규식 + 토큰 타입 매핑)이므로 직접 PBT 대상이 아닙니다.

대신 **토크나이저 검증 헬퍼 함수**를 별도로 추출하여 PBT를 적용합니다:

| 함수 | PBT 카테고리 | Invariant |
|------|-------------|-----------|
| `isNgqlKeyword(word: string): boolean` | Invariant | 알려진 키워드 집합에 속하는 단어는 항상 `true`를 반환 |
| `classifyToken(token: string): TokenType` | Oracle | 대소문자 무관하게 동일한 토큰 타입 반환 (case-insensitive invariant) |

- **PBT 프레임워크**: `fast-check`
- **테스트 파일**: `src/lib/ngql-language.test.ts`

## Tech Stack Decisions

| 결정 | 선택 | 이유 |
|------|------|------|
| Monaco 래퍼 | `@monaco-editor/react` | React 통합 최적화, lazy loading 내장 |
| 언어 정의 방식 | Monarch tokenizer | Monaco 공식 방식, JSON-like 선언적 정의 |
| PBT 프레임워크 | `fast-check` | Vitest 호환, TypeScript 지원 우수 |
| Worker 처리 | `vite-plugin-monaco-editor` 또는 수동 worker URL 설정 | Vite 7 호환 |
