# Requirements Document

## Intent Analysis Summary

| 항목 | 내용 |
|------|------|
| **User Request** | ByoriDB Studio 코드베이스를 기술부채 해소부터 시작해 ROADMAP 순서대로 단계적으로 개발 |
| **Request Type** | 복합 — 기술부채 해소(Refactoring) → 기능 개발(New Feature, Enhancement) 순차 진행 |
| **Scope** | 프로젝트 전반 (프론트엔드 + 백엔드 + 테스트/CI/빌드 도구) |
| **Complexity** | Moderate~Complex — 여러 컴포넌트에 걸친 변경, 단계별 진행 |
| **Key Constraint** | "찬찬히 안정적으로" — 각 단계를 완전히 완료하고 검증한 뒤 다음 단계로 |

---

## 작업 순서 (이번 워크플로우 범위)

사용자 답변(Clarification Q2=C)에 따라 **이번 워크플로우는 기술부채 해소를 첫 번째 작업 단위로 진행**한다. 이후 Phase 2(Monaco+nGQL)는 별도 워크플로우로 진행한다.

```
[이번 워크플로우]
  Unit 1: 기술부채 해소
    - ESLint + Prettier (프론트엔드 린트/포매터)
    - clippy + rustfmt (Rust 린트/포매터)
    - CI 워크플로우 (GitHub Actions)
    - TypeScript 타입 중앙화 (src/types.ts)

[다음 워크플로우 — 별도 진행]
  Phase 2: Monaco Editor + nGQL 구문 강조
  Phase 3+: 그래프 시각화, 스키마 관리 UI 등
```

---

## Functional Requirements

### FR-01: ESLint 설정 (프론트엔드)
- **설명**: `eslint.config.ts` (flat config) 를 추가하여 TypeScript + React 코드에 린트 규칙을 적용한다.
- **포함 규칙**: `@typescript-eslint/recommended`, `eslint-plugin-react-hooks`, `eslint-plugin-react-refresh`
- **npm 스크립트**: `npm run lint` (검사), `npm run lint:fix` (자동 수정)
- **완료 기준**: `npm run lint`가 기존 코드베이스에서 오류 없이 통과한다.

### FR-02: Prettier 설정 (프론트엔드)
- **설명**: `.prettierrc` 및 `.prettierignore`를 추가하여 코드 포매팅을 통일한다.
- **npm 스크립트**: `npm run format` (포매팅 적용), `npm run format:check` (CI용 검사)
- **완료 기준**: `npm run format:check`가 통과한다.

### FR-03: rustfmt 설정 (백엔드)
- **설명**: `src-tauri/rustfmt.toml`을 추가하여 Rust 코드 포매팅 규칙을 명시한다.
- **완료 기준**: `cargo fmt --check`가 `src-tauri/` 전체에서 통과한다.

### FR-04: clippy 설정 (백엔드)
- **설명**: `src-tauri/clippy.toml` 또는 `Cargo.toml`의 `[lints]` 섹션에 clippy 규칙을 추가한다.
- **완료 기준**: `cargo clippy -- -D warnings`가 `src-tauri/`에서 경고 없이 통과한다.

### FR-05: GitHub Actions CI 워크플로우
- **설명**: `.github/workflows/ci.yml`을 추가하여 PR/push 시 자동으로 빌드·테스트·린트를 실행한다.
- **포함 단계**:
  1. `npm ci`
  2. `npm run lint`
  3. `npm run format:check`
  4. `npm run build` (`tsc && vite build`)
  5. `npm test`
  6. `cd src-tauri && cargo fmt --check`
  7. `cd src-tauri && cargo clippy -- -D warnings`
  8. `cd src-tauri && cargo test`
- **트리거**: `push` (main 브랜치), `pull_request`
- **완료 기준**: CI 워크플로우가 현재 코드베이스에서 모두 green으로 통과한다.

### FR-06: TypeScript 타입 중앙화
- **설명**: 여러 컴포넌트에 중복 선언된 공통 타입을 `src/types.ts`로 통합한다.
- **대상 타입**:
  - `ConnectionConfig` — `App.tsx`, `ConnectionModal.tsx`, `ServerSettings.tsx`에 중복
  - `QueryResult` — `App.tsx`, `Sidebar.tsx`, `ResultPanel.tsx`에 중복
  - `SpaceInfo` — `App.tsx`(암묵적), `Sidebar.tsx`에 중복
  - `SchemaInfo` — `Sidebar.tsx`에만 있으나 `get_schema` 반환 타입으로 공유 필요
  - `TauriError` — `App.tsx`에만 있으나 향후 컴포넌트에서 재사용 가능
  - `SavedConnection` — `ServerSettings.tsx`에서 export 중이나 `src/types.ts`로 이동
- **완료 기준**:
  - `src/types.ts`에 위 타입들이 정의된다.
  - 기존 컴포넌트들이 `src/types.ts`에서 import한다.
  - `DEFAULT_CONFIG` 상수가 `src/types.ts` 또는 단일 위치로 통합된다.
  - `npm test`가 모두 통과한다.
  - `npm run lint`가 통과한다.

---

## Non-Functional Requirements

### NFR-01: 성능 (Performance)
- 기술부채 해소 작업 자체는 런타임 성능에 영향을 주지 않아야 한다.
- 타입 중앙화 리팩터링 후 번들 크기가 증가하지 않아야 한다 (`vite build` 출력 확인).
- CI 워크플로우는 합리적인 시간 내에 완료되어야 한다 (목표: 10분 이내).

### NFR-02: 신뢰성 (Reliability)
- 모든 기존 테스트(45개 프론트엔드 + 16개 백엔드)가 리팩터링 후에도 통과해야 한다.
- 타입 중앙화 후 런타임 동작이 변경되어서는 안 된다 (순수 타입 레벨 변경).
- CI가 실패하는 코드는 main 브랜치에 머지되지 않아야 한다.

### NFR-03: 유지보수성 (Maintainability)
- 린트/포매터 규칙은 기존 코드 스타일과 충돌하지 않도록 설정한다 (초기 도입 시 경고 0개 목표).
- 타입 중앙화 후 새 컴포넌트 작성 시 `src/types.ts`를 단일 참조점으로 사용할 수 있어야 한다.

### NFR-04: 보안 (Security — Security Baseline 확장 활성화)
- Security Baseline 확장이 **full blocking** 모드로 활성화되어 있다.
- 이번 기술부채 작업 범위에서 직접적인 보안 변경은 없으나, 코드 변경 시 기존 보안 속성을 저하시켜서는 안 된다.
- `SECURITY-01` (암호화 at rest/in transit): 이 프로젝트는 자체 데이터 저장소가 없으므로 **N/A**.
- `SECURITY-02` (네트워크 중개자 접근 로깅): 이 프로젝트는 서버/로드밸런서/API 게이트웨이가 없으므로 **N/A**.
- 향후 기능 개발 단계(Phase 2+)에서 새로운 보안 관련 코드가 추가될 때 Security Baseline 규칙을 적용한다.

### NFR-05: 테스트 가능성 (Testability — PBT 확장 활성화)
- Property-Based Testing 확장이 **full blocking** 모드로 활성화되어 있다.
- 이번 기술부채 작업(린트/CI/타입 중앙화)은 새로운 비즈니스 로직을 추가하지 않으므로 PBT 신규 작성 대상이 아니다.
- 기존 `client.rs`의 순수 파싱 헬퍼(`parse_query_response`, `parse_session_id`, `parse_spaces` 등)는 PBT 후보이나, 이번 단계에서는 기존 단위 테스트를 유지하는 것으로 충분하다.
- PBT 규칙은 Phase 2(Monaco 통합, nGQL 토크나이저) 이후 비즈니스 로직이 추가될 때 본격 적용한다.

---

## 제외 범위 (이번 워크플로우)

다음 항목은 이번 워크플로우에서 **명시적으로 제외**한다. 별도 워크플로우로 진행한다.

| 항목 | 이유 |
|------|------|
| Phase 2 — Monaco Editor 통합 | 기술부채 해소 완료 후 별도 진행 |
| Phase 2 — nGQL 구문 강조 | 동상 |
| Phase 3 — 그래프 시각화 | 동상 |
| Phase 4 — 스키마 관리 UI | 동상 |
| Phase 5 — 데이터 관리 UI | 동상 |
| Phase 6 — 모니터링 | 동상 |
| Phase 7 — UX 개선 (다국어, 테마) | 동상 |
| 비밀번호 OS keychain 마이그레이션 | 보안 개선이나 이번 단계 범위 초과 |
| CSP 강화 | 동상 |
| tauri-plugin-shell 제거 | 동상 |
| 재연결 백오프 로직 | 동상 |

---

## 수용 기준 (Acceptance Criteria)

이번 워크플로우 완료 조건:

- [ ] `npm run lint` — 오류 0개
- [ ] `npm run format:check` — 통과
- [ ] `npm run build` — 성공 (`tsc` 오류 0개 + Vite 빌드 성공)
- [ ] `npm test` — 45개 테스트 모두 통과
- [ ] `cargo fmt --check` — 통과
- [ ] `cargo clippy -- -D warnings` — 경고 0개
- [ ] `cargo test` — 16개 테스트 모두 통과
- [ ] GitHub Actions CI — 모든 단계 green
- [ ] `src/types.ts` 존재 — 공통 타입 6종 이상 정의
- [ ] 기존 컴포넌트들이 `src/types.ts`에서 import — 중복 선언 제거

---

## 기술 컨텍스트 참조

- 기존 코드베이스 분석: `aidlc-docs/inception/reverse-engineering/`
- 기술 스택: `technology-stack.md` (TypeScript 5.9.3, Rust 1.70+, Vite 7, Vitest 4.1.5)
- 기술부채 목록: `code-quality-assessment.md` (항목 #1~#13)
- 파일 인벤토리: `code-structure.md`
