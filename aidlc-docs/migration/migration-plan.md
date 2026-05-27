# Migration Plan: ByoriDB Studio → cah-dlc

- **작성일**: 2026-05-21
- **기반**: audit-report 2026-05-21 + brownfield-onboard 2026-05-21

---

## 배경

ByoriDB Studio는 Tauri 2 + React 19 + Rust/tokio 기반의 단독 개발 데스크톱 앱이다.
Phase 1 (서버 연동) 이 완료되었고, Phase 2 (Monaco Editor 통합) 진입 전에 코드베이스를
AI-DLC 스타일로 전환하는 것이 목표다. 전체를 빠르게 적용하는 적극적 전략으로, 모든 파일이
수정 대상이다.

---

## 가용 자원

| 항목 | 내용 |
|---|---|
| 인력 | 솔로 개발 |
| 시간 | 틈새 시간 (전담 아님) — 주당 실질 2-5시간 추정 |
| Phase 2 진입 조건 | M1 Quick Wins 완료 후 |
| 동결 모듈 | 없음 |
| 리스크 수용 | 적극적 — 전체를 빠르게 AI-DLC 스타일로 |

---

## 우선순위 매트릭스

```
            임팩트 ↑ (1-5)
              5 │  [App.tsx 훅]          [CI 파이프라인]
                │  [Sidebar.tsx 훅]
              4 │                         [커버리지 강화]
                │
              3 │  [CSS 아키텍처]         [client.rs 모듈화]
                │
              2 │
                │
              1 │
                └────────────────────────────────────→ 노력 ↑ (1-5)
                        1       2       3       4       5
```

| 모듈 | 임팩트 | 노력 | 라벨 | Phase 2 선행 조건? |
|---|---|---|---|---|
| CI 파이프라인 | 5 | 1 | **Quick Win** | 예 — 회귀 방지 |
| `App.tsx` 훅 분리 | 5 | 2 | **Quick Win** | 예 — 상태 폭발 방지 |
| `Sidebar.tsx` 훅 분리 | 4 | 2 | **Quick Win** | 예 — 기능 추가 전 정리 |
| 테스트 커버리지 강화 | 4 | 3 | **마일스톤** | 아니요 |
| CSS 아키텍처 교체 | 3 | 4 | **마일스톤** | 아니요 |
| `client.rs` 모듈화 | 3 | 3 | **마일스톤** | gRPC 추가 시 선행 |

---

## 마일스톤

### M0 — 기반 다지기 (W1, ~3시간)

목표: 이후 작업이 안전하게 진행될 수 있는 인프라 확보.

- [ ] **GitHub Actions CI 구성** — `npm test` + `cargo test` 자동화
  - 트리거: PR + main push
  - 파일: `.github/workflows/ci.yml`
  - 완료 기준: PR 시 자동으로 두 테스트 모두 통과 확인

완료 기준: `git push` 하면 CI가 돌고 결과가 보인다.

---

### M1 — Quick Wins: 훅 분리 (W2-W5, ~10-15시간)

목표: App.tsx god-component와 Sidebar.tsx 혼재 로직 해소. Phase 2 진입 전 필수.

#### M1-1. `useConnection` 훅 추출 (~3시간)

대상: `src/App.tsx`의 연결 관련 상태 + 핸들러

분리 대상:
- 상태: `isConnected`, `showConnectionModal`, `connectionConfig`
- 핸들러: `handleConnect`, `handleDisconnect`, `handleConnectionLost`
- Effect: 헬스체크 폴링 (`useEffect`)

출력: `src/hooks/useConnection.ts`

완료 기준:
- `App.tsx`에서 연결 상태 관련 코드가 사라지고 `useConnection()` 호출로 대체
- `App.test.tsx` 기존 테스트 통과 유지
- `useConnection.test.ts` 신규 작성 (connect/disconnect/session-expired/health-check 케이스)

#### M1-2. `useQueryExecution` 훅 추출 (~2시간)

대상: `src/App.tsx`의 쿼리 실행 관련 상태 + 핸들러

분리 대상:
- 상태: `queryResult`, `isExecuting`
- 핸들러: `handleExecuteQuery`

출력: `src/hooks/useQueryExecution.ts`

완료 기준:
- `App.tsx` 총 줄 수가 100줄 이하로 감소 (현재 256줄)
- 기존 테스트 통과 유지

#### M1-3. `useSchemaData` 훅 추출 (~4시간)

대상: `src/components/Sidebar.tsx`의 스키마/DESCRIBE 로직

분리 대상:
- 상태: `spaces`, `schema`, `describeCache` (Map), `isLoadingSchema`
- 핸들러: `refreshSchema`, `toggleDescribe`, `fetchDescribe`

출력: `src/hooks/useSchemaData.ts`

완료 기준:
- `Sidebar.tsx` 총 줄 수가 200줄 이하로 감소 (현재 360줄)
- `Sidebar.test.tsx` 기존 테스트 통과 유지
- `useSchemaData.test.ts` 신규 작성

M1 완료 게이트:
- `npm test` 통과 (새 훅 테스트 포함)
- `cargo test` 통과
- CI 녹색

---

### M2 — CSS 아키텍처 교체 (W5-W8, ~8시간)

목표: 컴포넌트별 CSS 파일 패턴에서 선택된 접근법으로 이전.

> **결정 필요**: CSS Modules / Tailwind CSS / CSS custom properties 중 선택.
> Phase 2 진입 시 선택. 현재는 기존 패턴 유지.

대상: `src/styles/` 7개 CSS 파일 전체

작업 순서: 신규 컴포넌트(Phase 2) 먼저 새 방식 적용 → 기존 컴포넌트 이전

완료 기준:
- 모든 컴포넌트가 동일한 CSS 방식 사용
- 비주얼 리그레션 없음

---

### M3 — `client.rs` 모듈화 (W8+, ~4시간, gRPC 추가 시 선행)

목표: `client.rs` 단일 파일(588줄) 분리.

분리 계획:
- `src-tauri/src/error.rs` — `ClientError` + `parse_error_response`
- `src-tauri/src/types.rs` — `ConnectionConfig`, `QueryResult`, `SpaceInfo`, `SchemaInfo`
- `src-tauri/src/parser.rs` — `parse_query_response`, `parse_names`, `parse_spaces`, `parse_session_id`
- `src-tauri/src/client.rs` — `ByoriDBClient` 구현만

트리거: gRPC 클라이언트 추가(Phase 3 예정) 전에 선행.

---

### Phase 2 진입 조건 체크리스트

M1 완료 이후 아래가 모두 충족되면 Phase 2 시작:

- [ ] CI 파이프라인 동작 중
- [ ] `App.tsx` ≤ 100줄
- [ ] `Sidebar.tsx` ≤ 200줄
- [ ] `npm test` 통과 (새 훅 커버리지 포함)
- [ ] `cargo test` 통과

---

## 위험 / 가정

| 위험 | 가능성 | 완화 |
|---|---|---|
| 훅 분리 중 타이머 클린업 버그 | 중 | 기존 `App.test.tsx`의 `vi.useFakeTimers` 테스트 가장 먼저 실행 |
| CSS 아키텍처 결정 지연 | 중 | Phase 2 시작 시 즉시 결정. 지연되면 CSS Modules(기존 CSS와 가장 유사)로 기본값 |
| 솔로+틈새 시간으로 인한 컨텍스트 손실 | 높음 | NEXT.md 를 각 마일스톤 완료 시마다 업데이트. `aidlc-docs/` 산출물이 컨텍스트 역할 |
| client.rs 모듈화 중 Rust 빌드 시간 | 낮음 | `cargo check` 먼저 검증 |

---

## 진행 추적

본 문서는 각 마일스톤 완료 시 + 분기별 retro에서 업데이트.
상태 변경 시 체크박스 체크 + `aidlc-docs/onboard/onboard-notes.md`에 날짜 기록.
