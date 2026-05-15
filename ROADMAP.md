# ByoriDB Studio Roadmap

ByoriDB Studio 개발 로드맵. 각 단계별 목표와 구현 항목을 정리합니다.

## 현재 상태

### 구현 완료 (전체)
- [x] 기본 연결 모달 (호스트/포트/인증)
- [x] 저장된 연결 프로필 (localStorage)
- [x] 서버 설정 UI (저장된 서버 관리 + 연결 테스트)
- [x] Monaco Editor 쿼리 에디터 (구문 강조, 자동완성, 멀티 탭, 스니펫, 선택 실행)
- [x] 쿼리 히스토리 (검색, 즐겨찾기, 실행시간/행수 표시)
- [x] 결과 패널 (테이블/JSON 트리뷰/그래프 뷰, CSV/JSON 내보내기)
- [x] 사이드바 스키마 브라우저 (Space/Tag/Edge 목록, DESCRIBE 상세)
- [x] 스키마 관리 UI (Space/Tag/Edge/Index 생성·삭제, ERD 다이어그램)
- [x] 데이터 관리 UI (Vertex/Edge CRUD 폼, CSV Import)
- [x] 그래프 시각화 (cytoscape.js, 레이아웃 옵션, Tag별 색상)
- [x] 모니터링 (서버 버전, 쿼리 실행시간, /metrics 대시보드)
- [x] UX 개선 (다크/라이트 테마, 폰트 크기, 한국어/영어 다국어)
- [x] 코드 품질 기반 (ESLint, Prettier, rustfmt, clippy, GitHub Actions CI)
- [x] Tauri 백엔드 명령어 (connect, disconnect, execute_query, execute_statement 등)
- [x] HTTP REST `/api/v1/*` 엔드포인트 연동
- [x] 테스트 인프라 (Vitest + Testing Library + fast-check PBT, `cargo test`)

### 미구현 (향후 과제)
- [ ] gRPC 클라이언트 옵션 (tonic)
- [ ] 연결 풀링
- [ ] 비동기 쿼리 취소
- [ ] 비밀번호 OS keychain 마이그레이션
- [ ] 재연결 백오프 로직

---

## Phase 1: 서버 연동 완성

**목표**: ByoriDB 서버와 실제 통신 구현

### 1.1 API 클라이언트 수정
- [x] HTTP REST API 엔드포인트 수정
  - `/api/auth` → `/api/v1/session` (POST)
  - `/api/signout` → `/api/v1/session/{id}` (DELETE)
  - `/api/query` → `/api/v1/query` (POST)
- [x] 응답 형식 파싱 수정 (column_names, results, latency_ms)
- [x] 에러 응답 처리 강화 (error, code 필드 구조화)

### 1.2 연결 관리 개선
- [x] 연결 테스트 (서버 설정 UI에서 수동 검증)
- [x] 연결 상태 확인 (`GET /health`) 자동 폴링
- [x] 세션 타임아웃 처리
- [x] 재연결 로직

### 1.3 스키마 조회 개선
- [x] `SHOW SPACES` 결과 파싱
- [x] `DESCRIBE TAG/EDGE` 명령으로 프로퍼티 정보 조회
- [x] Space 선택 시 자동 `USE space` 실행

---

## Phase 2: 쿼리 에디터 강화

**목표**: 개발자 경험(DX) 개선

### 2.1 구문 강조 (Syntax Highlighting)
- [x] Monaco Editor 또는 CodeMirror 통합
- [x] nGQL 언어 정의 (키워드, 연산자, 문자열, 숫자)
- [x] 괄호 매칭

### 2.2 자동완성 (Autocomplete)
- [x] nGQL 키워드 자동완성
  - DDL: `CREATE`, `DROP`, `ALTER`, `SHOW`, `DESCRIBE`
  - DML: `INSERT`, `UPDATE`, `DELETE`
  - DQL: `MATCH`, `GO`, `FETCH`, `LOOKUP`, `FIND`
- [x] 현재 스키마 기반 자동완성 (Tag명, Edge명, 프로퍼티명)
- [x] Space명 자동완성

### 2.3 쿼리 편의 기능
- [x] 멀티 탭 지원
- [x] 쿼리 템플릿/스니펫
- [x] 쿼리 포맷팅 (자동 정렬)
- [x] 선택 영역만 실행

### 2.4 쿼리 히스토리 강화
- [x] 히스토리 검색
- [x] 히스토리 즐겨찾기
- [x] 실행 시간, 결과 행 수 표시

---

## Phase 3: 결과 뷰어 개선

**목표**: 다양한 형태의 결과 표시

### 3.1 테이블 뷰 개선
- [x] 컬럼 정렬
- [x] 컬럼 리사이즈
- [x] 셀 값 복사
- [x] 대용량 결과 페이지네이션/가상 스크롤

### 3.2 JSON 뷰 개선
- [x] 트리 뷰 (접기/펼치기)
- [x] JSON 경로 복사
- [x] 검색

### 3.3 그래프 시각화
- [x] 그래프 렌더링 라이브러리 통합 (D3.js, Cytoscape.js, 또는 vis.js)
- [x] Vertex/Edge 시각화
  - `GO` 쿼리 결과 그래프 표시
  - `MATCH` 패턴 매칭 결과 표시
  - `FIND PATH` 경로 하이라이트
- [x] 노드/엣지 스타일링 (Tag별 색상)
- [x] 레이아웃 옵션 (Force-directed, Hierarchical, Circular)
- [x] 줌/팬 컨트롤
- [x] 노드 클릭 시 상세 정보 표시

### 3.4 결과 내보내기
- [x] CSV 내보내기
- [x] JSON 내보내기
- [x] 그래프 이미지 내보내기 (PNG/SVG)

---

## Phase 4: 스키마 관리 UI

**목표**: GUI로 스키마 생성/수정

### 4.1 Space 관리
- [x] Space 생성 폼 (vid_type 선택)
- [x] Space 삭제 (확인 다이얼로그)
- [x] Space 상세 정보 표시 (partition_num, replica_factor)

### 4.2 Tag/Edge 관리
- [x] Tag 생성 폼
  - 이름 입력
  - 프로퍼티 추가 (이름, 타입, NULL 허용, 기본값)
- [x] Edge 생성 폼
- [x] Tag/Edge 수정 (ALTER ADD)
- [x] Tag/Edge 삭제

### 4.3 인덱스 관리
- [x] `SHOW TAG/EDGE INDEXES` 목록 표시
- [x] 인덱스 생성 폼
- [x] 인덱스 삭제
- [x] 인덱스 상태 표시

### 4.4 스키마 시각화
- [x] ERD 스타일 다이어그램 (Tag-Edge 관계도)

---

## Phase 5: 데이터 관리 UI

**목표**: GUI로 데이터 CRUD

### 5.1 Vertex 관리
- [x] Vertex 생성 폼 (VID, Tag 선택, 프로퍼티 입력)
- [x] Vertex 수정 폼
- [x] Vertex 삭제

### 5.2 Edge 관리
- [x] Edge 생성 폼 (src VID, dst VID, Edge 타입, 프로퍼티)
- [x] Edge 삭제

### 5.3 데이터 Import/Export
- [x] CSV Import
- [x] Bulk Insert 진행률 표시

---

## Phase 6: 모니터링 및 진단

**목표**: 서버 상태 모니터링

### 6.1 서버 상태
- [x] 연결 헬스 체크 주기적 실행
- [x] 서버 버전 정보 표시

### 6.2 쿼리 분석
- [x] 쿼리 실행 시간 표시
- [x] 느린 쿼리 하이라이트

### 6.3 메트릭 대시보드
- [x] `/metrics` 엔드포인트 데이터 표시
- [x] 쿼리 처리량 그래프
- [x] 레이턴시 그래프

---

## Phase 7: 사용자 경험 개선

**목표**: 완성도 높은 데스크톱 앱

### 7.1 테마
- [x] 다크/라이트 테마 토글
- [x] 커스텀 테마 지원

### 7.2 설정
- [x] 폰트 크기 조절
- [x] 에디터 설정 (탭 크기, 줄 바꿈)
- [x] 키보드 단축키 커스터마이징

### 7.3 다국어
- [x] 한국어/영어 지원

### 7.4 접근성
- [x] 키보드 네비게이션 개선
- [x] 스크린 리더 지원

---

## 우선순위 요약

| 단계 | 이름 | 우선순위 | 예상 범위 | 진행률 |
|------|------|----------|-----------|--------|
| Phase 1 | 서버 연동 완성 | **Critical** | API 수정, 연결 관리 | 진행 중 (코어 완료) |
| Phase 2 | 쿼리 에디터 강화 | **High** | Monaco Editor, 자동완성 | 미착수 |
| Phase 3 | 결과 뷰어 개선 | **High** | 그래프 시각화, 내보내기 | 미착수 |
| Phase 4 | 스키마 관리 UI | **Medium** | Tag/Edge/Index 폼 | 미착수 |
| Phase 5 | 데이터 관리 UI | **Medium** | Vertex/Edge CRUD 폼 | 미착수 |
| Phase 6 | 모니터링 | **Low** | 메트릭 대시보드 | 미착수 |
| Phase 7 | UX 개선 | **Low** | 테마, 설정, 다국어 | 미착수 |

---

## 기술 스택 계획

### 추가 예정 라이브러리
- **Monaco Editor**: VS Code 기반 에디터 (구문 강조, 자동완성)
- **Cytoscape.js** 또는 **vis.js**: 그래프 시각화
- **react-virtualized** 또는 **@tanstack/react-virtual**: 대용량 테이블
- **zustand** 또는 **jotai**: 상태 관리 (현재 useState만 사용)

### 백엔드 개선
- gRPC 클라이언트 옵션 (tonic 사용, 압축 지원)
- 연결 풀링
- 비동기 쿼리 실행 (긴 쿼리 취소 지원)
