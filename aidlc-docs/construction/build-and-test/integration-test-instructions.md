# Integration Test Instructions

## 현황

이번 tech-debt 단위(린트/포매터/CI/타입 중앙화)는 런타임 동작 변경이 없으므로 **별도 통합 테스트 시나리오가 없습니다**.

기존 `src/App.test.tsx`가 Tauri IPC 경계를 mock하여 connect → query → disconnect 전체 흐름을 검증하는 가장 가까운 통합 테스트 역할을 합니다.

## 수동 통합 검증 (실제 서버 필요)

실제 ByoriDB 서버가 있을 때 다음 시나리오를 수동으로 검증합니다:

```bash
# 서버 기동 (../byoridb 레포)
cd ../byoridb
BYORIDB_ROOT_PASSWORD=byoridb-dev cargo run --release --bin byoridb-server

# Studio 개발 모드 실행
cd ../byoridb-studio
npm run tauri dev
```

### 시나리오 1: 연결 및 스페이스 브라우징
1. ConnectionModal에서 `127.0.0.1:19669`, `root`, `byoridb-dev` 입력 후 Connect
2. Sidebar에 Spaces 목록 표시 확인
3. 스페이스 클릭 → `USE <space>` 실행, Tags/Edges 로딩 확인

### 시나리오 2: 쿼리 실행
1. QueryEditor에 `SHOW SPACES` 입력 후 ⌘↵
2. ResultPanel에 테이블 결과 표시 확인
3. JSON 뷰 전환 확인

### 시나리오 3: 세션 만료 복구
1. 서버 재시작 (세션 무효화)
2. 쿼리 실행 → "Session expired. Please reconnect." 메시지 + 모달 재오픈 확인

## 다음 단계 (Phase 2 이후)

Monaco Editor 통합 후에는 에디터 렌더링, 구문 강조, 단축키 동작에 대한 통합 테스트 시나리오를 추가합니다.
