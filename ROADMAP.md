# ByoriDB Studio Roadmap

ByoriDB Studio 개발 로드맵. 각 단계별 목표와 구현 항목을 정리합니다.

## 현재 상태

### 구현 완료
- [x] 기본 연결 모달 (호스트/포트/인증)
- [x] 저장된 연결 프로필 (localStorage)
- [x] 서버 설정 UI (저장된 서버 관리 + 연결 테스트)
- [x] 쿼리 에디터 (기본 텍스트 입력)
- [x] 쿼리 히스토리 (Cmd+Up/Down)
- [x] 결과 패널 (테이블/JSON 뷰)
- [x] 사이드바 스키마 브라우저 (Space/Tag/Edge 목록)
- [x] Tauri 백엔드 명령어 (connect, disconnect, execute_query)
- [x] HTTP REST `/api/v1/*` 엔드포인트 연동 (session, query)
- [x] 응답 파싱 (column_names, results, latency_ms)
- [x] 개발용 Mock 데이터 폴백
- [x] 테스트 인프라 (Vitest + Testing Library, `cargo test`)

### 미구현
- [ ] 구문 강조 (Syntax Highlighting)
- [ ] 그래프 시각화
- [ ] 스키마 상세 정보 (프로퍼티, 타입)
- [ ] 인덱스 관리
- [ ] 결과 내보내기

---

## Phase 1: 서버 연동 완성

**목표**: ByoriDB 서버와 실제 통신 구현

### 1.1 API 클라이언트 수정
- [x] HTTP REST API 엔드포인트 수정
  - `/api/auth` → `/api/v1/session` (POST)
  - `/api/signout` → `/api/v1/session/{id}` (DELETE)
  - `/api/query` → `/api/v1/query` (POST)
- [x] 응답 형식 파싱 수정 (column_names, results, latency_ms)
- [ ] 에러 응답 처리 강화 (error, code 필드 구조화)

### 1.2 연결 관리 개선
- [x] 연결 테스트 (서버 설정 UI에서 수동 검증)
- [ ] 연결 상태 확인 (`GET /health`) 자동 폴링
- [ ] 세션 타임아웃 처리
- [ ] 재연결 로직

### 1.3 스키마 조회 개선
- [x] `SHOW SPACES` 결과 파싱
- [ ] `DESCRIBE TAG/EDGE` 명령으로 프로퍼티 정보 조회
- [ ] Space 선택 시 자동 `USE space` 실행

---

## Phase 2: 쿼리 에디터 강화

**목표**: 개발자 경험(DX) 개선

### 2.1 구문 강조 (Syntax Highlighting)
- [ ] Monaco Editor 또는 CodeMirror 통합
- [ ] nGQL 언어 정의 (키워드, 연산자, 문자열, 숫자)
- [ ] 괄호 매칭

### 2.2 자동완성 (Autocomplete)
- [ ] nGQL 키워드 자동완성
  - DDL: `CREATE`, `DROP`, `ALTER`, `SHOW`, `DESCRIBE`
  - DML: `INSERT`, `UPDATE`, `DELETE`
  - DQL: `MATCH`, `GO`, `FETCH`, `LOOKUP`, `FIND`
- [ ] 현재 스키마 기반 자동완성 (Tag명, Edge명, 프로퍼티명)
- [ ] Space명 자동완성

### 2.3 쿼리 편의 기능
- [ ] 멀티 탭 지원
- [ ] 쿼리 템플릿/스니펫
- [ ] 쿼리 포맷팅 (자동 정렬)
- [ ] 선택 영역만 실행

### 2.4 쿼리 히스토리 강화
- [ ] 히스토리 검색
- [ ] 히스토리 즐겨찾기
- [ ] 실행 시간, 결과 행 수 표시

---

## Phase 3: 결과 뷰어 개선

**목표**: 다양한 형태의 결과 표시

### 3.1 테이블 뷰 개선
- [ ] 컬럼 정렬
- [ ] 컬럼 리사이즈
- [ ] 셀 값 복사
- [ ] 대용량 결과 페이지네이션/가상 스크롤

### 3.2 JSON 뷰 개선
- [ ] 트리 뷰 (접기/펼치기)
- [ ] JSON 경로 복사
- [ ] 검색

### 3.3 그래프 시각화
- [ ] 그래프 렌더링 라이브러리 통합 (D3.js, Cytoscape.js, 또는 vis.js)
- [ ] Vertex/Edge 시각화
  - `GO` 쿼리 결과 그래프 표시
  - `MATCH` 패턴 매칭 결과 표시
  - `FIND PATH` 경로 하이라이트
- [ ] 노드/엣지 스타일링 (Tag별 색상)
- [ ] 레이아웃 옵션 (Force-directed, Hierarchical, Circular)
- [ ] 줌/팬 컨트롤
- [ ] 노드 클릭 시 상세 정보 표시

### 3.4 결과 내보내기
- [ ] CSV 내보내기
- [ ] JSON 내보내기
- [ ] 그래프 이미지 내보내기 (PNG/SVG)

---

## Phase 4: 스키마 관리 UI

**목표**: GUI로 스키마 생성/수정

### 4.1 Space 관리
- [ ] Space 생성 폼 (vid_type 선택)
- [ ] Space 삭제 (확인 다이얼로그)
- [ ] Space 상세 정보 표시 (partition_num, replica_factor)

### 4.2 Tag/Edge 관리
- [ ] Tag 생성 폼
  - 이름 입력
  - 프로퍼티 추가 (이름, 타입, NULL 허용, 기본값)
- [ ] Edge 생성 폼
- [ ] Tag/Edge 수정 (ALTER ADD)
- [ ] Tag/Edge 삭제

### 4.3 인덱스 관리
- [ ] `SHOW TAG/EDGE INDEXES` 목록 표시
- [ ] 인덱스 생성 폼
- [ ] 인덱스 삭제
- [ ] 인덱스 상태 표시

### 4.4 스키마 시각화
- [ ] ERD 스타일 다이어그램 (Tag-Edge 관계도)

---

## Phase 5: 데이터 관리 UI

**목표**: GUI로 데이터 CRUD

### 5.1 Vertex 관리
- [ ] Vertex 생성 폼 (VID, Tag 선택, 프로퍼티 입력)
- [ ] Vertex 수정 폼
- [ ] Vertex 삭제

### 5.2 Edge 관리
- [ ] Edge 생성 폼 (src VID, dst VID, Edge 타입, 프로퍼티)
- [ ] Edge 삭제

### 5.3 데이터 Import/Export
- [ ] CSV Import
- [ ] Bulk Insert 진행률 표시

---

## Phase 6: 모니터링 및 진단

**목표**: 서버 상태 모니터링

### 6.1 서버 상태
- [ ] 연결 헬스 체크 주기적 실행
- [ ] 서버 버전 정보 표시

### 6.2 쿼리 분석
- [ ] 쿼리 실행 시간 표시
- [ ] 느린 쿼리 하이라이트

### 6.3 메트릭 대시보드
- [ ] `/metrics` 엔드포인트 데이터 표시
- [ ] 쿼리 처리량 그래프
- [ ] 레이턴시 그래프

---

## Phase 7: 사용자 경험 개선

**목표**: 완성도 높은 데스크톱 앱

### 7.1 테마
- [ ] 다크/라이트 테마 토글
- [ ] 커스텀 테마 지원

### 7.2 설정
- [ ] 폰트 크기 조절
- [ ] 에디터 설정 (탭 크기, 줄 바꿈)
- [ ] 키보드 단축키 커스터마이징

### 7.3 다국어
- [ ] 한국어/영어 지원

### 7.4 접근성
- [ ] 키보드 네비게이션 개선
- [ ] 스크린 리더 지원

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
