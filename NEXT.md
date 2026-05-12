# 다음 업무 (Next Up)

직전 세션에서 v1 엔드포인트 연동·서버 설정 UI·테스트 인프라가 완료됨.
이 문서는 ROADMAP의 항목 중 **즉시 착수 가능한 다음 작업**을 우선순위로 정리한 punch list.

장기 계획은 [ROADMAP.md](./ROADMAP.md), 작업 컨텍스트는 [CLAUDE.md](./CLAUDE.md) 참고.

마지막 업데이트: 2026-05-11 — Phase 1 마무리 완료 (헬스체크 폴링, 자동 USE 정리, DESCRIBE TAG/EDGE). ByoriDB 스펙 변경(세션 i64, argon2/env 기반 root 비밀번호, 구조화된 에러, DESCRIBE TAG/EDGE/SPACE) 대응도 함께 완료.

---

## 우선순위 1: Phase 1 마무리 ✅ 완료

### 1. 서버 에러 응답 구조화 ✅ 완료 (2026-05-11)

- **완료 내용**: `ClientError` 열거형 + `TauriError { code, message }` 보드리 도입. 프론트에서 `code`별 분기 가능 (현재는 `SESSION_EXPIRED`, `AUTH_FAILED` 분기).
- 참고: `src-tauri/src/client.rs::ClientError`, `src-tauri/src/main.rs::TauriError`, `src/App.tsx::normalizeError`.

### 2. `GET /health` 헬스체크 ✅ 완료 (2026-05-11)

- **완료 내용**: `App.tsx`의 `useEffect`에서 30초 주기로 `test_connection` 커맨드 폴링. 실패 시 `handleConnectionLost("health")`가 연결 상태 리셋, 모달 재오픈, result panel에 "Lost connection to server" 메시지 표시. 타이머는 `setInterval`, 클린업은 `clearInterval` + cancelled flag.
- 테스트: `App.test.tsx`의 `drops the connection when the health poll reports the server as unreachable` (`vi.useFakeTimers` + `act` 사용).

### 3. Space 선택 시 자동 `USE space` ✅ 완료 (2026-05-11)

- **완료 내용**: 이전 버전은 `handleExecuteQuery`를 재사용해 result panel을 오염시키고, 실패해도 `currentSpace`를 업데이트하던 두 가지 버그가 있었음. `handleSelectSpace`가 직접 `invoke("execute_query", ...)`를 호출하도록 변경하고, 성공 시에만 `setCurrentSpace`. `SESSION_EXPIRED`는 `handleConnectionLost("session")`로, 기타 실패는 alert로 처리.
- 테스트: `App.test.tsx`의 `selects a space silently without overwriting the result panel` + `does not switch the current space when the USE command fails`.

### 4. `DESCRIBE TAG/EDGE`로 스키마 상세 조회 ✅ 완료 (2026-05-11)

- **완료 내용**: ByoriDB 서버 커밋 `c1151ad`가 `DESCRIBE TAG|EDGE|SPACE`를 추가함. 사이드바 각 태그/엣지 항목에 expand 화살표를 추가, 첫 expand 시 `DESCRIBE TAG <name>` 호출, 결과는 `(kind, space, name)` 단위로 캐시. 이름 클릭은 기존대로 `MATCH` 쿼리 실행, expand 버튼은 별도 affordance. Space 변경 또는 수동 refresh 시 캐시 무효화.
- 참고: `src/components/Sidebar.tsx::describe/toggleDescribe/refreshSchema`, `src/styles/Sidebar.css` 하단 describe-panel 블록.
- 테스트: `Sidebar.test.tsx`의 `lazy-loads DESCRIBE TAG on expand and caches the result` + `surfaces DESCRIBE errors inline without affecting name-click behavior`.

---

## 우선순위 2: Phase 2 진입 — 쿼리 에디터 강화

DX 가장 큰 개선 포인트. 1주 분량.

### 5. Monaco Editor 통합

- **할 일**:
  - `@monaco-editor/react` 설치
  - `QueryEditor` 컴포넌트 교체 (현재 `<textarea>`)
  - 폰트·테마는 Catppuccin Mocha에 맞춰 커스텀
- **완료 기준**:
  - Cmd+Up/Down 히스토리, Cmd+Enter 실행 단축키 유지
  - 기존 테스트(`QueryEditor.test.tsx`) 통과 또는 등가 커버리지 재작성

### 6. nGQL 키워드 구문 강조

- **할 일**:
  - Monaco용 nGQL 토크나이저 정의 (`monaco.languages.register`)
  - 키워드: DDL/DML/DQL 분리 (`CLAUDE.md` 참조)
  - 문자열·숫자·주석 토큰화
- **완료 기준**:
  - `MATCH (n:person) RETURN n` 같은 쿼리가 색상 구분
  - 잘못된 토큰은 별도 처리하지 않음 (Phase 2.2 자동완성에서 재방문)

---

## 우선순위 3: 추후 (보류)

- **세션 타임아웃 처리**: 부분 완료 (2026-05-11). 서버가 세션 만료 시
  heuristic(`Session not found`/`Session expired` 메시지 매칭)으로 감지해
  `SESSION_EXPIRED` 코드를 프론트에 전달, 재연결 모달 자동 재오픈.
  서버가 전용 `code` 필드를 추가하면 heuristic 제거 가능 — `is_session_error()`
  참고.
- **재연결 로직 (백오프)**: 헬스체크(항목 2)가 먼저 들어가야 의미 있음. 보류.

---

## 작업 시작 전 체크리스트

- [ ] `git status` 깨끗한지 확인
- [ ] `npm test` 통과
- [ ] `cargo test --manifest-path src-tauri/Cargo.toml` 통과

---

## 메모

- `coverage/` 디렉터리는 gitignore됨. 커버리지 리포트는 `npm run coverage` 후 `coverage/index.html` 확인.
- Rust 단위 테스트는 `client.rs`의 순수 함수 위주. 통합 테스트(실제 HTTP)는 미작성 — 서버 띄우고 수동으로만 검증.
- 서버 root 비밀번호는 `BYORIDB_ROOT_PASSWORD` env 기반 (서버 측 기본값 없음 — 미지정 시 무작위 생성). 로컬에서는 서버 기동 시 `BYORIDB_ROOT_PASSWORD=byoridb-dev`처럼 임의 값을 지정하고 Studio 비밀번호 필드에 동일한 값을 입력. `CLAUDE.md` 참조.
