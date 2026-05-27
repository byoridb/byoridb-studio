# Tech Debt Catalog: ByoriDB Studio

- **작성일**: 2026-05-21
- **기반**: brownfield-audit 2026-05-21 + migration-plan 2026-05-21

> 이 카탈로그는 "빚이지 컨벤션이 아니다"를 명시하기 위해 존재한다.
> 미래의 작업자(인간 또는 AI)가 기존 패턴을 따르지 말아야 할 이유를 알 수 있도록 기록.

---

## 카탈로그

| ID | 영역 | 설명 | 위험도 | 해소 마일스톤 |
|---|---|---|---|---|
| TD-001 | `src/App.tsx` | God-component: 상태 6개 + 비즈니스 로직(연결/쿼리/헬스체크) 집중. 단일 컴포넌트에 너무 많은 책임 | High | M1 (useConnection, useQueryExecution 훅 분리) |
| TD-002 | `src/components/Sidebar.tsx` | DESCRIBE 캐시 Map + 스키마 조회 로직이 UI 렌더링과 혼재. Phase 2 기능 추가 시 더 비대해질 위험 | High | M1 (useSchemaData 훅 분리) |
| TD-003 | `src-tauri/src/client.rs` | 단일 파일에 에러 타입, 데이터 타입, 파싱 헬퍼, 클라이언트 로직, 테스트 혼재 (588줄) | Medium | M3 (gRPC 추가 시 선행) |
| TD-004 | CI/CD | GitHub Actions 없음. `npm test` + `cargo test`가 수동. PR 검증 자동화 없음 | High | M0 (즉시) |
| TD-005 | CSS 아키텍처 | 컴포넌트별 개별 CSS 파일 (7개). Tailwind / CSS Modules / 커스텀 속성 없이 plain CSS. 변경 예정임에도 신규 CSS가 같은 패턴으로 추가될 위험 | Medium | M2 (Phase 2 진입 전후) |
| TD-006 | Rust HTTP 클라이언트 | `reqwest::Client`를 각 메서드(`authenticate`, `execute`, `disconnect`, `test_connection`)에서 매번 새로 생성. 연결 풀링 없음 | Low | M3 또는 Phase 3 |
| TD-007 | heuristic 세션 만료 감지 | `client.rs::is_session_error()`가 HTTP 응답 메시지 텍스트 매칭으로 세션 만료를 감지. 서버 응답 형식이 바뀌면 묵묵히 실패 | Medium | 서버가 전용 `code` 필드 추가 시 |
| TD-008 | TypeScript `alert()` 직접 호출 | `App.tsx`와 `Sidebar.tsx`에서 `alert()` 직접 사용. 모달 기반 에러 표시가 아님 | Low | Phase 2+ (에러 UI 개선 시) |
| TD-009 | Rust 통합 테스트 없음 | `client.rs` 테스트는 순수 함수(파싱 헬퍼) 위주. 실제 HTTP 서버 대상 통합 테스트 없음 | Medium | 별도 트래킹 (서버 테스트 인프라 필요) |
| TD-010 | TypeScript 프론트 로깅 | `console.error()` 직접 호출. 구조화된 로깅 없음. 릴리즈 빌드에서도 콘솔 출력 | Low | Phase 7 (UX 개선) |
| TD-011 | HTTPS 미사용 | 로컬 전용 개발 도구라 현재 허용 범위이나, 프로덕션 배포 시 TLS 필요 | Info | 프로덕션 배포 시 |
| TD-012 | `ServerSettings.tsx` 인터페이스 중복 | `ConnectionConfig` 인터페이스가 `App.tsx`, `Sidebar.tsx`, `ServerSettings.tsx`에 각각 정의됨 | Low | M1 리팩토링 시 자연 해소 |

---

## 빚 아님 — 의도된 패턴

헷갈릴 수 있는 항목들을 명시:

| 항목 | 빚 아닌 이유 |
|---|---|
| `client.rs`의 `is_session_error()` heuristic | 서버 버전에 따른 임시 타협. `client.rs` 주석에 교체 조건 명시됨 (TD-007로 추적) |
| `App.tsx`의 `normalizeError()` 인라인 함수 | Tauri IPC 에러 형태를 `{ code, message }`로 표준화하는 의도된 패턴 — 이동 대상이 아님 |
| `src/test/setup.ts`의 localStorage 모킹 | 테스트 환경 제약 해소를 위한 의도된 설정 |
| Tauri `AppState`의 `Arc<Mutex<>>` | Tauri의 thread-safe 상태 공유 요구사항 — 제거 대상 아님 |

---

## 해소 완료

| ID | 해소일 | 방법 |
|---|---|---|
| (없음) | — | — |
