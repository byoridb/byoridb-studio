# 다음 업무

## 현재 구현 — 2026-11-01

Byori Studio를 영상 편집기로 전환했다. 전체 목표와 기능별 구현/후속 범위는
[ROADMAP.md](ROADMAP.md), 검증 근거는 [VALIDATION.md](VALIDATION.md)를 따른다.
이전 DB 탐색기 체크리스트는 역사적 기록이며 현재 작업 지시가 아니다.

완료한 기반:

- CapCut Desktop형 작업 공간, 로컬 프로젝트·미디어·다중 트랙 편집과 실행 취소.
- UI·CLI가 공유하는 리비전 검증 명령, 정밀 미리보기와 실제 FFmpeg 출력.
- 변형·합성·키프레임·색보정·LUT·안정화·오디오 보정.
- Whisper 자동 자막, macOS TTS, 자막 입출력.
- Claude Code·Codex 실제 도구 편집, Gemini 어댑터와 인증 오류 처리.
- ByoriDB 창작 기억 기록·검색, 최신 버전·설치·업데이트 관리.
- TTF/OTF 글꼴과 사용자 필터·효과 프리셋 추가·저장·가져오기·내보내기, CLI 공통 소재 도구.
- 즉시 빠른 재생, 슬라이더·텍스트·필터 임시 미리보기, 편집 잠금과 분리한 정밀 프레임·캐시.
- 오디오 요소 유지·메타데이터/버퍼링 동기화, 전체 미리보기 음소거, 재생 차단 오류 표시와 정밀 재생 중 중복 소리 방지.
- 연속 재생과 명시적 탐색 분리, 불필요한 강제 탐색·동일 재생 속도 대입 제거, 가까운 오디오 사전 로딩과 정적 타임라인 시각 요소 재사용.
- 커버 이미지가 있는 MP3의 오디오 분류 및 기존 소재 재검사·클립 복구, 단일 실행 취소.
- 영상·오디오·자막 트랙 추가·선택·이름 변경, 호환 레이어 간 세로 이동과 선택 클립의 새 트랙 분리. 새 영상은 자막 아래에 합성.
- 나누기·앞부분/뒷부분 자르기 버튼과 ⌘B/Q/W, 보이는 트림 손잡이·1프레임 조절, 여러 레이어의 원자적 편집. UI·MCP 공통 `edit.trim`이 배속·역재생 원본 구간·키프레임·페이드를 보존.
- Higgsfield MCP 설정·OAuth 연결 확인과 세 CLI의 조회 도구 전달.

## 백로그 — 2026-11-11 구현 상태 감사 반영

2026-11-11 코드 감사(편집 코어, 렌더·미디어, 서비스·런타임, 타임라인·플레이어, 패널,
빌드·테스트·출시)로 확인한 항목이다. 실측: 프런트엔드 18개 파일 147개(편집기 대상 111개),
Rust 73개(편집기 대상 57개), Python MCP 4개, TypeScript·Vite 빌드와 clippy 통과(경고 4건),
프런트엔드 라인 커버리지 72.6%. `tauri build`는 이 감사에서 다시 실행하지 않았다.
위 "완료한 기반" 가운데 전환·스티커·내장 효과/필터 프리셋·저장 상태 표시는 실제 범위가
좁으며 아래 항목으로 관리한다. 우선순위는 1 → 2 → 3, 그다음 4·5를 배포 전 관문으로 둔다.

### 1. 작업 보호

- [ ] 전환 이후 작업 전체 커밋(수정 15·미추적 22 항목, `src/studio/`와 Rust 신규 모듈 포함).
- [ ] CI 구성과 단일 검증 명령(vitest + cargo test + Python unittest + 빌드).
- [ ] 레거시 정리: CLAUDE.md 하단 DB 탐색기 문서. (`src/components/`, `client.rs`, 크레이트 이름, `tauri-plugin-shell` 은 정리됨)
- [ ] `src/App.test.tsx:302` 선택/리플 삭제 테스트의 간헐 실패(2회 중 1회) 원인 확인.

### 2. 데이터 안전·안정성

- [ ] `current.json` 손상·검증 실패 시 복구 경로(`editor.rs:45-50`). 현재는 서비스가 기동하지 못하고 네이티브 앱이 안내 없이 panic 종료한다(`main.rs:40-41`).
- [ ] 프로젝트 스키마 버전과 마이그레이션.
- [ ] 누락 소재 감지·재연결 명령과 UI.
- [ ] 내보내기·`project.save`·`captions.export`의 기존 파일 덮어쓰기 확인과 MCP 경로 제한.
- [ ] 에이전트 패널: 닫아도 실행 중 작업 유지, 취소 후 상태 갱신, 프로젝트 전환 시 상태 초기화.
- [ ] 같은 트랙의 클립 겹침 정책 결정과 코어 검증.
- [ ] 임시 파일 정리: 미리보기·렌더 임시 파일, `imports/` 업로드 사본, 에이전트 작업 폴더, 누적되는 작업 상태.
- [ ] `expectedRevision`이 선택 사항인 코어 계약 정리, 캔버스 드래그 경로의 revision 보호.
- [ ] 단일 인스턴스 보장과 서비스 기동 실패 안내.

### 3. 확인된 버그

- [ ] 파형이 100Hz 리샘플로 실제 음량을 반영하지 못함. 앞 600초·128버킷 고정, 클립 트림 미반영.
- [ ] 클립 클릭 후 Space가 재생으로 가지 않음. 한글 입력 상태에서 Q/W/M 단축키 불능 가능.
- [ ] 캔버스 조작이 키프레임을 무시하고 정적 transform에 기록.
- [ ] 텍스트의 브라우저 미리보기와 출력의 폭·줄바꿈 계산 불일치(`render.rs:923-951`).
- [ ] 로그 문자열 기반 로그인 필요 판정이 정상 에이전트 작업을 실패로 뒤집을 수 있음.
- [ ] ByoriDB 미설치 상태에서 설치 버튼이 바로 보이지 않음.
- [ ] 색상 입력이 `onChange`마다 편집 명령 전송.
- [ ] 컨셉 탭 입력 중 리비전이 바뀌면 미저장 입력 초기화.
- [ ] 내장 필터가 UI(`Library.tsx`)와 `editor.rs`에 다른 id·값으로 이중 정의. 필터 적용 시 color 객체 통째 교체.
- [ ] `fadeIn/fadeOut` 직접 수정 시 `transitionIn/Out` duration과 어긋남.
- [x] `scripts/studio-cli.py`가 `BYORI_STUDIO_HOME`을 무시.
- [ ] 저장 상태 표시가 하드코딩된 "저장됨". 화면 비율 라벨이 실제 비율과 무관.
- [ ] 출력 해상도 비율이 프로젝트와 다르면 화면이 늘어남. FFmpeg stderr를 64KB까지만 읽음.

### 4. 성능 — 긴 타임라인·4K

- [ ] 프레임 한 장도 타임라인 0초부터 전부 합성하는 렌더 구조 개선(구간 한정 입력·시크).
- [ ] 소재 프록시 생성과 프록시·캐시 관리.
- [ ] 정밀 프레임 렌더의 서버 측 취소.
- [ ] 타임라인 가상화, `video` 요소 상시 마운트 제거, 재생 중 App 전체 리렌더 축소.
- [ ] 1.2초 전체 Project JSON 폴링을 변경 알림 또는 리비전 조건부 조회로 교체.
- [ ] 가져오기·LUT 복사 중 편집기 잠금 유지 해소, 프로브 타임아웃.
- [ ] 긴 4K 프로젝트의 미리보기 캐시/프로세스 자원 관리와 성능 측정.

### 5. 보안·배포

- [ ] 에이전트용 토큰 범위 제한과 서버 측 allowlist. `/session`의 Origin 단독 신뢰 보완.
- [ ] CSP와 Tauri capabilities 정의.
- [ ] 배포용 코드 서명·공증·업데이터, 번들 메타데이터(식별자, 최소 macOS 버전, targets).
- [ ] LICENSE·NOTICE와 서드파티 고지.
- [ ] `cargo audit` 22건·npm 개발 의존성 13건 검토.
- [ ] FFmpeg·Python 3 미번들 대응, Finder 실행 시 node 기반 CLI·`npx` 탐색 경로.
- [ ] ByoriDB 설치 파일 무결성 검증 필수화, LaunchAgent 중지·제거 경로.
- [ ] Gemini 어댑터 권한 범위를 다른 두 어댑터 수준으로 축소.
- [ ] 버전·릴리스 체계(CHANGELOG, 태그, 세 곳의 버전 동기화).
- [ ] macOS 외 운영체제와 Intel Mac 검증.

### 6. 기본 UX 공백

- [ ] 홈 화면(새 프로젝트·최근 프로젝트·프로젝트 관리)과 프로젝트 삭제·복제 명령, 첫 실행 온보딩.
- [ ] 복사·잘라내기·붙여넣기.
- [ ] 플레이헤드 드래그 스크럽, 재생 중·드래그 가장자리 자동 스크롤, 휠 줌·맞춤 줌.
- [ ] 트랙 삭제·재정렬, 마커 수정·삭제와 스냅 대상 포함.
- [ ] 플레이어 미리보기 확대, 볼륨, 구간 반복. 캔버스 회전·크롭 핸들.
- [ ] 라이브러리 소재 삭제 UI, 검색·정리·즐겨찾기.
- [ ] 패널 폭 조절, 모달 Esc·포커스 트랩.
- [ ] 내보내기 대화상자: 오디오 형식에서 무관한 옵션 비활성.
- [ ] 기억 패널 자동 로드·프로젝트 범위, 에이전트 대화 이력·인증 상태 표시.
- [ ] 기존 디자인 훅 항목 정리: `src/styles/studio.css` 199건·`src/studio/panels.css` 116건(대부분 토큰화되지 않은 색상).

### 7. 검증 대기

- [x] 속도 흔들림 후속 수정에 대해 사용자가 “해결된거 같아”라고 확인했다. 아래 장시간·백그라운드·청취의 별도 검증 범위는 유지한다.
- [ ] 네이티브 전경/백그라운드 전환과 긴 타임라인의 음영상 동기화 검증. 숨겨진 CUA Safari/WebKit의 RAF 정지·타이머 제한을 전경 성능 수치로 사용하지 않는다. Chrome 독립 오디오 검사는 macOS 앱의 합성 화면·청취 검증과 구분한다.
- [ ] 데이터 준비 후 play promise만 지연되는 경우 다른 준비된 레이어가 시계보다 먼저 진행할 수 있는 경계 사례 검증. 일반 데이터 버퍼링 경로는 다른 레이어도 멈추고, 지연은 15초 오류 처리로 제한된다.
- [ ] 네이티브 앱에서 실제 스피커/헤드폰으로 빠른·정밀 재생을 청취 검증. 여러 오디오 레이어, 나중에 시작하는 클립, 탐색·일시정지·음소거와 영상/자막 합성을 함께 확인. 자동 검사의 재생 호출·상태 확인을 실제 청취 완료로 간주하지 않는다.
- [ ] Gemini CLI 로그인 후 실제 편집 → UI 반영 → 실행 취소 검증.
- [ ] 별도 빈 설치 환경에서 ByoriDB 설치·업데이트를 실제 배포물로 검증.
- [ ] Higgsfield 실제 계정 로그인·CLI 조회 종단 검증. allowlist 도구 이름이 실제 서버 도구와 일치하는지 확인.
- [ ] 통합·E2E 자동 테스트. 포트·Origin 은 `BYORI_STUDIO_PORT`/`BYORI_STUDIO_DEV_PORT`/`VITE_STUDIO_PORT` 로 격리할 수 있다.
- [ ] 테스트 공백: `Settings.tsx`·`api.ts` 0%, AssistantPanel·CurveEditor·전환/효과/스티커 탭, 프로젝트 수명주기·자막 dispatch·마커·소재 제거, 렌더, runtime 프로세스·speech·service 라우팅.

### 8. 로드맵 기능 확장

이름만 있는 기능을 먼저 채운다.

- [ ] 클립 간 전환(크로스 디졸브 등). 현재 전환은 단일 클립 페이드의 별칭이다.
- [ ] 키프레임 이징과 추가 속성, 인·아웃·반복 애니메이션 프리셋.
- [ ] 스티커·효과·필터·텍스트 프리셋 카탈로그(현재 TSX 하드코딩 4~8개, 스티커는 텍스트 배지).
- [ ] 빠른 재생에 크롭·마스크·크로마키·LUT 반영 범위 확대.
- [ ] 속도 곡선·정지 프레임·블렌드 모드·복합 클립·롤/슬립 편집.
- [ ] 2패스 안정화·객체 추적·색상 휠·영상 효과.
- [ ] 텍스트 외곽선·그림자·자간, 자막 일괄 교정·번역·이중 언어·단어 강조, 자막 번인 선택과 자막 트랙 출력.
- [ ] 녹음·피치·보컬 분리·비트 동기화·더킹.
- [ ] 출력 코덱·비트레이트·하드웨어 인코딩 선택.
- [ ] 소재 누락 재연결·글꼴/LUT 의존성을 포함한 프로젝트 패키지.
- [ ] 자동 장면/무음 분석·자동 리프레임·배경 제거.
- [ ] Higgsfield 유료 생성 비용 확인·승인 흐름.
- [ ] 이미지·음악 직접 생성: 공급자 생성 요청과 결과 가져오기, 생성/미리보기·미리듣기/적용 흐름, UI·CLI 공통 도구, ByoriDB 생성 이력 연동. 상세 검토는 ROADMAP 참조.
- [ ] 생성형 영상·스톡/템플릿 카탈로그·클라우드 공유 설계 및 구현.
- [ ] 창작 기억 검색 고도화(현재 기록·부분 문자열 검색), 에이전트 다중 턴 세션.
- [ ] i18n(현재 한국어 문자열 고정), 여러 프로젝트·여러 창.

---

## 이전 작업 이력 — DB 관리 도구

아래 우선순위와 체크리스트는 전환 이전 기록이며 현재의 작업 지시가 아니다.

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
