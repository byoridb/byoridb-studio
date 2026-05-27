# Audit Report: ByoriDB Studio

- **스캔 일자**: 2026-05-21
- **Git revision**: fe104426f6ed5ef04ad1cab56e3ea91fe1559287
- **스캐너**: brownfield-audit (cah-dlc v0.3.0)

---

## 요약

ByoriDB Studio는 ByoriDB 분산 그래프 데이터베이스를 관리하기 위한 Tauri 2 기반 크로스플랫폼 데스크톱 애플리케이션이다. 프론트엔드는 React 19 + TypeScript 5.9, 백엔드는 Rust (tokio + reqwest)로 구성되어 있으며, Tauri IPC(`invoke()`)를 통해 두 레이어가 통신한다. 코드베이스는 총 약 4,000줄(TS/TSX ~2,800줄, Rust ~750줄)로 소규모이나 Phase 2+ (Monaco Editor, 그래프 시각화 등) 진입 시 급격히 확장될 예정이다. 주요 위험은 `App.tsx`의 god-component 패턴과 `Sidebar.tsx`의 캐시/UI 로직 혼재이며, 사용자가 전체 리팩토링을 포함한 AI-DLC 도입을 목표로 하고 있다.

---

## 스택

| 영역 | 도구 | 버전 | 비고 |
|---|---|---|---|
| 데스크톱 프레임워크 | Tauri | 2.x | `@tauri-apps/api ^2.9.1` |
| 프론트엔드 UI | React | 19.2.3 | React 19 (최신) |
| 언어 (프론트) | TypeScript | 5.9.3 | strict 모드 활성화 |
| 번들러 | Vite | 7.3.1 | `port: 1420` |
| 언어 (백엔드) | Rust | edition 2021, MSRV 1.70 | |
| 비동기 런타임 | tokio | 1.x | features: full |
| HTTP 클라이언트 | reqwest | 0.12 | features: json |
| 직렬화 | serde / serde_json | 1.x | |
| 로깅 | tracing / tracing-subscriber | 0.1 / 0.3 | env-filter 사용 |
| 에러 처리 | anyhow | 1.x | Rust 측 내부 에러 |
| 프론트 테스트 | Vitest | 4.1.5 | jsdom 환경 |
| 테스트 유틸 | @testing-library/react | 16.3.2 | + user-event 14 |
| 커버리지 | @vitest/coverage-v8 | 4.1.5 | html + text 리포터 |
| Rust 테스트 | cargo test (내장) | — | `#[cfg(test)]` 블록 |

---

## 디렉토리 구조

```
byoridb-studio/
├── src/                         # React 프론트엔드
│   ├── App.tsx                  # 루트 컴포넌트 — 상태 6개, 연결/쿼리 비즈니스 로직
│   ├── main.tsx                 # React 진입점
│   ├── components/              # UI 컴포넌트 (5개)
│   │   ├── ConnectionModal.tsx  # 초기 연결 다이얼로그
│   │   ├── QueryEditor.tsx      # 쿼리 입력 (현재 textarea)
│   │   ├── ResultPanel.tsx      # 결과 테이블/JSON 뷰
│   │   ├── ServerSettings.tsx   # 저장된 서버 프로필 관리
│   │   └── Sidebar.tsx          # 스키마 브라우저 + DESCRIBE 캐시
│   ├── styles/                  # 컴포넌트별 CSS 파일 (7개)
│   └── test/
│       └── setup.ts             # localStorage 모킹 등 전역 설정
├── src-tauri/
│   └── src/
│       ├── main.rs              # Tauri 명령어 라우터 (165줄)
│       └── client.rs            # ByoriDB HTTP API 클라이언트 (588줄)
├── public/                      # 정적 자산
├── CLAUDE.md                    # AI 협업 문서 (상세)
├── NEXT.md                      # 즉시 착수 가능 punch list
└── ROADMAP.md                   # Phase 1~7 장기 계획
```

---

## 컨벤션 (관찰됨)

- **네이밍**:
  - TypeScript: `camelCase` (변수/함수), `PascalCase` (컴포넌트/인터페이스), `SCREAMING_SNAKE_CASE` (상수 e.g. `HEALTH_POLL_INTERVAL_MS`)
  - Rust: `snake_case` (함수/변수), `PascalCase` (struct/enum)
- **폴더 구조**: 기능 기반이 아닌 계층 기반 (components, styles 분리). 향후 feature 기반으로 이동 예정.
- **에러 처리**:
  - Rust: `ClientError` enum (variant per failure mode) → `TauriError { code, message }` 직렬화로 프론트에 노출. `anyhow::Result`는 내부 함수용
  - TypeScript: `normalizeError()` 헬퍼로 Tauri IPC 에러를 `{ code, message }` 형태로 표준화. `code` 기반 분기 (`SESSION_EXPIRED`, `AUTH_FAILED`)
- **로깅**: Rust에서 `tracing::info!` 사용. 프론트에서 `console.error()` (래퍼 없음)
- **테스트 스타일**:
  - Rust: `serde_json::json!` 매크로로 test fixture 구성. 순수 함수(`parse_*`) 위주 단위 테스트. 통합 테스트 없음.
  - TypeScript: `vi.mock("@tauri-apps/api/core")` + `invokeMock`으로 Tauri IPC 격리. `userEvent` + `waitFor` 비동기 패턴. `vi.useFakeTimers`로 타이머 테스트.
- **CSS**: 컴포넌트별 개별 CSS 파일 (CSS 커스텀 속성 미사용, Tailwind 없음). **변경 예정** (사용자 확인).
- **주석**: Rust 측에 `///` doc comment + inline 설명 다수. TypeScript 측은 JSDoc 블록 최소화.

**샘플 인용 — `client.rs:78-90` (에러 처리 패턴)**:
```rust
fn parse_error_response(raw: &str) -> (Option<String>, String) {
    match serde_json::from_str::<serde_json::Value>(raw) {
        Ok(body) => {
            let code = body.get("code").and_then(|v| v.as_str()).map(String::from);
            let message = body.get("error")...;
            (code, message)
        }
        Err(_) => (None, raw.to_string()),
    }
}
```

**샘플 인용 — `App.tsx:32-44` (에러 정규화)**:
```typescript
function normalizeError(err: unknown): TauriError {
  if (err && typeof err === "object" && "code" in err && "message" in err) {
    return err as TauriError;
  }
  return { code: "UNKNOWN", message: String(err) };
}
```

---

## 의존성

### 외부 라이브러리

| 라이브러리 | 버전 | 금지 목록 위반? |
|---|---|---|
| @tauri-apps/api | ^2.9.1 | 해당 없음 |
| react | ^19.2.3 | 해당 없음 |
| react-dom | ^19.2.3 | 해당 없음 |
| typescript | ^5.9.3 | 해당 없음 |
| vite | ^7.3.1 | 해당 없음 |
| @vitejs/plugin-react | ^5.1.2 | 해당 없음 |
| vitest | ^4.1.5 | 해당 없음 |
| @testing-library/react | ^16.3.2 | 해당 없음 |
| jsdom | ^29.1.1 | 해당 없음 |
| tokio | 1.x | 해당 없음 |
| reqwest | 0.12 | 해당 없음 |
| serde/serde_json | 1.x | 해당 없음 |
| tracing | 0.1 | 해당 없음 |
| anyhow | 1.x | 해당 없음 |

> `standards/library-denylist.md` 미확인 (파일 없음). 위반 여부는 N/A.

### 사내 하네스 사용

| 하네스 | 사용 중? | 비고 |
|---|---|---|
| standards/harnesses/ | 미확인 | `standards/` 디렉토리 없음 — 사내 하네스 정의 파일 미존재 |

---

## 위험 모듈

| 모듈 / 파일 | 위험 신호 | 우선도 | 사용자 확인 |
|---|---|---|---|
| `src/App.tsx` (256줄) | 상태 6개 (`isConnected`, `showConnectionModal`, `connectionConfig`, `currentSpace`, `queryResult`, `isExecuting`) + 연결/쿼리/헬스체크 비즈니스 로직 집중. 단일 컴포넌트에 side-effect 4개(`useEffect` 1개, 핸들러 5개). | High | 실제 위험 — 분리 예정 |
| `src/components/Sidebar.tsx` (360줄) | DESCRIBE 캐시 상태(`Map<key, DescribeState>`)와 스키마 조회 로직 + UI 렌더링이 혼재. 탭 상태, 확장 상태, 스키마 데이터 등 상태 6개. Phase 2 기능 추가 시 더 비대해질 위험. | High | 실제 위험 — 분리 예정 |
| `src-tauri/src/client.rs` (588줄) | 단일 파일에 클라이언트 구조체, 에러 타입, 파싱 헬퍼, 테스트가 혼재. 현재는 관리 가능한 크기이나 gRPC 클라이언트 추가 시 분리 필요. | Medium | 의도된 구조이나 성장 주의 |

---

## CI / 인프라

- **CI**: 없음 (`.github/workflows/` 미존재). 수동 `npm test` + `cargo test` 검증만.
- **Dockerfile / IaC**: 없음 (데스크톱 앱이므로 서버 인프라 불필요).
- **배포**: Tauri 빌드 (`npm run tauri build`) → 플랫폼별 인스톨러. 자동화 없음.

---

## AI 협업 문서 현황

- **CLAUDE.md**: 존재 ✓ — 빌드 명령어, 아키텍처 설명, HTTP API 명세, nGQL 레퍼런스 포함. 상세하고 최신 상태.
- **AGENTS.md**: 없음
- **기타 (.cursorrules 등)**: 없음
- **aidlc-docs/**: 이번 audit 전까지 없음 (신규 생성)

---

## 시크릿 / 보안 Finding

| 등급 | 항목 | 상세 |
|---|---|---|
| Info | `.env` 파일 없음 | 시크릿 커밋 위험 없음. `.gitignore`에 `.env`, `.env.local`, `.env.*.local` 패턴 포함 — 커버리지 양호. |
| Info | 루트 비밀번호 처리 | `BYORIDB_ROOT_PASSWORD` env var 서버 측 읽기. 클라이언트(스튜디오)는 사용자 입력값을 `POST /api/v1/session`에 전달. 코드에 하드코딩 없음. |
| Info | 세션 ID 처리 | `session_id: i64`를 HTTP body에 포함해 전송. HTTPS 미사용 (로컬 전용 개발 도구이므로 현재는 허용 범위). 프로덕션 배포 시 TLS 필요. |

---

## 디자인 자산 현황

- **디자인 도구**: Figma / Sketch / Penpot 등 흔적 없음
- **UI 라이브러리**: 없음 — 컴포넌트 직접 제작 + 컴포넌트별 CSS
- **디자인 토큰**: 없음 (`tailwind.config` 없음, CSS 커스텀 속성 미사용)
- **Storybook**: 없음
- **접근성**: `aria-*` 속성이 `Sidebar.tsx`에서만 소수 사용됨 — 부분 지원
- **반응형**: 없음 (데스크톱 전용 앱)
- **i18n**: 없음. ROADMAP Phase 7에 한국어/영어 지원 계획.
- **다크모드**: 없음. ROADMAP Phase 7에 계획.

---

## 사용자 확인 결과

| 항목 | 답변 |
|---|---|
| 주력 스택 | Tauri 2 + React 19 + Rust/tokio 맞음 |
| 컨벤션 (컴포넌트별 CSS 등) | **변경 예정** — CSS 접근법 교체 계획 있음 |
| 위험 모듈 (App.tsx, Sidebar.tsx) | **실제 위험 — 분리 예정** |
| AI-DLC 도입 동기 | **전체 리팩토링 포함** — 기존 코드도 점진적으로 AI-DLC 스타일로 정리 |

---

## AI-DLC 도입 권고

**brownfield-onboard 단계 진입 가능.**

우선 처리 권고 사항:

1. **AGENTS.md 생성** (onboard 단계) — AI 에이전트가 코드베이스에서 작업하기 위한 규칙 정의
2. **CLAUDE.md 보강** — 현재 CLAUDE.md는 상세하나 AI-DLC 컨벤션 섹션 추가 필요
3. **CI 파이프라인 도입** (migration 계획에 포함) — `npm test` + `cargo test`가 수동이므로 GitHub Actions 추가 권고
4. **App.tsx 분해** — 연결 상태 관리를 커스텀 훅(`useConnection`)으로 분리. Phase 2 진입 전 선행 권고.
5. **Sidebar.tsx 분해** — DESCRIBE 캐시 로직을 훅으로 분리. Phase 2 기능 추가 전 선행 권고.

차단 사유: 없음. Critical/High 보안 finding 없음.
