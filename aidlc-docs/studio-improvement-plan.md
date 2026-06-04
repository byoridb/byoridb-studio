# ByoriDB Studio 추가 개발 방향

> 작성일: 2026-05-29 · 갱신: 2026-06-04
> 입력: `~/teo_ai/bench/studio-improvement.md` (벤치마크 기반 개선 제안) + 현재 코드베이스 구현 현황 + byoridb 서버 지원 현황 교차 검증
> 결론 한 줄: **제안의 P0(EXPLAIN/PROFILE 시각화)은 Studio만으로는 절반밖에 못 만든다 — 서버 작업이 선행되어야 진짜 가치가 나온다.**

> **[2026-06-04 업데이트]** byoridb 서버에 EXPLAIN 연산자 트리 + PROFILE per-operator 계측 + 풀스캔 경고가 구현됨(commit `dc5be3b`). 이로써 아래 Track B 의 최대 블로커가 해소됨. Studio 측 시각화(`ExplainView`)도 1차 구현 완료 — 하단 "진행 현황" 참조.

---

## 0. 핵심 발견 — 제안 vs 현실의 간극

벤치마크 기반 개선 제안(`studio-improvement.md`)은 "성능 가시성"을 차별점으로 제시했고 그 판단은 옳다. 하지만 제안서가 가정한 것과 실제 구현/서버 현황 사이에 두 가지 큰 간극이 있다.

**간극 1 — Table-stakes는 이미 대부분 끝났다.**
제안서가 "향후 과제"로 둔 것들(다중 포맷 뷰, 가상 스크롤, 히스토리, 다중 탭, CSV/JSON 내보내기, 메트릭 대시보드)은 이미 구현되어 있다. ROADMAP Phase 1~7이 완료된 상태이기 때문이다.

**간극 2 — 가장 중요한 P0가 서버에 막혀 있다.**
제안서의 핵심인 "EXPLAIN/PROFILE 시각화 + 풀스캔 경고"는 byoridb 서버가 아직 필요한 데이터를 주지 않는다:
- `EXPLAIN` → 논리 계획을 **단일 문자열 한 줄**로만 반환 (예: `GoPlan { from_vids: [1], over_edges: ["knows"], steps: Exactly(2) }`). 트리 구조·노드별 행수·비용 없음.
- `PROFILE` → **토큰만 있고 EXPLAIN의 별칭으로 동작**. 실제 연산자별 행수/시간 프로파일 없음.
- 쿼리 응답에 **인덱스 사용/풀스캔 여부 없음** (debug 로그로만 남음).
- 슬로우 쿼리는 **Prometheus 카운터(`byoridb_slow_queries_total`)만** 있고, 개별 쿼리 텍스트·계획 조회 불가.

→ 즉, 제안서의 "Q4 병목을 한눈에" 그림은 **서버가 연산자별 프로파일과 인덱스 정보를 응답에 실어주기 전까지는 불가능**하다.

---

## 1. 현재 구현 현황 (제안 항목 매핑)

| 제안 항목 | 상태 | 근거 |
|----------|------|------|
| 1. EXPLAIN/PROFILE 시각화 | ❌ 미구현 (+ 서버 제약) | EXPLAIN은 문자열 1줄, PROFILE은 별칭 |
| 2. 스키마 인식 자동완성 | 🟡 부분 | `src/lib/ngql-language.ts` — 키워드·태그·엣지 자동완성 O, **프로퍼티 레벨 X**, 타입/예약어 충돌 사전경고 X |
| 3. 다중 포맷 결과 뷰 | ✅ 구현 | `ResultPanel.tsx` 테이블/JSON/그래프 탭 (`TableView`/`JsonTreeView`/`GraphView`) |
| 4. 대용량 가상 스크롤 | 🟡 거의 완료 | `TableView.tsx` `@tanstack/react-virtual` 적용 O, **"10만 행 / LIMIT 확인" 경고 X** |
| 5. 단계별 쿼리 빌더 | ❌ 미구현 | — |
| 6. 운영 가시성 (메트릭) | 🟡 부분 | `MonitorPanel.tsx` + `fetch_metrics`(main.rs) Prometheus 표시 O, **SlowLog 탭·인덱스 추천 X** |
| 7-a. 쿼리 히스토리 | ✅ 구현 | `HistoryPanel.tsx` (검색·즐겨찾기 필터) |
| 7-b. 저장된 쿼리/즐겨찾기 | 🟡 키만 정의 | `types.ts` `FAVORITES_STORAGE_KEY` 존재, **UI 미구현** |
| 7-c. 다중 탭 | ✅ 구현 | `QueryEditor.tsx` |
| 7-d. CSV/JSON 내보내기 | ✅ 구현 | `ResultPanel.tsx` |
| 7-e. SSH 터널 | ❌ 미구현 | — |

요약: **"기본 UX"는 사실상 끝났고, 남은 건 '성능 가시성'의 알맹이와 자잘한 마감재다.**

---

## 2. 재정렬된 개발 방향

제안서의 우선순위를 "현재 코드 상태 + 서버 제약"으로 다시 매긴다. 핵심 기준: **서버 없이 지금 Studio만으로 사용자 가치가 나는가?**

### Track A — 지금 Studio만으로 가능 (서버 무관, 즉시 착수)

이쪽이 ROI가 가장 명확하다. 코드 기반이 이미 다 깔려 있어서 "마지막 1cm"만 채우면 된다.

| 우선순위 | 항목 | 작업 내용 | 기반 |
|---------|------|----------|------|
| **A1** | 대용량 결과 경고 | row_count가 임계값(예 10k) 초과 또는 LIMIT 없는 쿼리에서 결과 상단에 경고 배너 ("107,646행 반환됨 · LIMIT 확인 필요"). Q4 LIMIT 무시 버그 방어. | `ResultPanel.tsx`/`TableView.tsx` (가상 스크롤 이미 있음) |
| **A2** | 프로퍼티 레벨 자동완성 + 예약어/타입 경고 | `DESC TAG`/`DESC EDGE` 백그라운드 로드 → `tag.<prop>` 자동완성. `tag`·`edge` 같은 예약어를 식별자로 쓸 때 사전 경고. VID 타입 불일치 힌트. | `ngql-language.ts` + `useSchemaData` |
| **A3** | EXPLAIN 문자열 뷰어 (최소판) | 서버가 주는 EXPLAIN 한 줄 문자열을 파싱해 Plan 타입·필드를 읽기 쉬운 카드/트리로 정리. 비용·행수는 아직 없음을 명시. "풀스캔이면 LookupPlan에 인덱스명 없음" 같은 휴리스틱 경고. | 신규 `ExplainView`, `execute_query` 재사용 |
| **A4** | 저장된 쿼리/즐겨찾기 UI | 이미 정의된 `FAVORITES_STORAGE_KEY` 위에 UI만 얹기. | `HistoryPanel.tsx` 확장 |

### Track B — 서버 작업이 선행되어야 진짜 가치 (제안서의 진짜 P0)

제안서가 그린 "성능 가시성"의 핵심. **byoridb 서버 변경이 전제**다. Studio 단독으로는 못 만든다.

| 우선순위 | 항목 | 서버 선행 작업 | Studio 작업 | 상태 |
|---------|------|--------------|------------|------|
| **B1** | PROFILE 시각화 | `PROFILE`을 실제 실행 + 연산자별 {행수, 시간} 수집해 구조화 응답으로 반환 | 트리/플로우 시각화, 느린 노드 빨강, 병목 뱃지 | ✅ **완료** (서버 `dc5be3b` + Studio `ExplainView`) |
| **B2** | 풀스캔/인덱스 경고 | 쿼리 응답에 인덱스 사용 여부·풀스캔 플래그 포함 | 결과 패널 "풀스캔 경고" 뱃지 → 인덱스 추가 유도 | ✅ **완료** (EXPLAIN/PROFILE `access` 컬럼 + `⚠ FULL SCAN` 뱃지) |
| **B3** | SlowLog 탭 | 개별 슬로우 쿼리(텍스트·latency·시각) 조회 엔드포인트 추가 (현재는 카운터뿐) | SlowLog 탭, latency 히스토리 그래프, 인덱스 추천 | ⏳ 서버 작업 대기 (현재는 `byoridb_slow_queries_total` 카운터뿐) |

→ B1/B2는 서버(`dc5be3b`)와 Studio(`ExplainView`) 양쪽 1차 구현 완료. **남은 서버 작업은 B3(개별 슬로우 쿼리 조회 API)뿐.**

#### B1/B2 진행 현황 (Studio)

서버는 EXPLAIN/PROFILE 결과를 **일반 row-major DataSet**으로 반환한다(별도 엔벨로프 없음). Studio는 컬럼 시그니처로 이를 감지해 트리로 복원·시각화한다.

- `src/lib/explainPlan.ts` — 순수 파싱: `detectExplainMode`(컬럼 시그니처로 EXPLAIN 4컬럼/PROFILE 6컬럼 판별), `parsePlanNodes`(operator 2칸 들여쓰기 → 트리 depth 복원), `computePlanStats`(maxRows/maxTime, **root 제외** 병목 노드, 풀스캔 카운트).
- `src/components/ExplainView.tsx` — 트리 렌더: 들여쓰기 가이드, PROFILE 행수/시간 **히트맵 바**(green→red), `⚠ FULL SCAN` 뱃지 + 빨강 좌측 보더, `🔥 bottleneck` 뱃지(최slow non-root 연산자), 요약 바(총 시간/출력 행수/풀스캔 개수).
- `src/components/ResultPanel.tsx` — 플랜 결과 감지 시 "Plan" 탭 자동 추가·자동 선택.
- `src/lib/ngql-language.ts` — 에디터에 `EXPLAIN`/`PROFILE` 키워드 하이라이트·자동완성 추가.
- 테스트: `explainPlan.test.ts`(16) + `ExplainView.test.tsx`(5) = 21개 추가, 전체 102개 통과.

**알려진 한계** (서버 측, 후속 개선점): 서버 PROFILE 오버레이가 `ProfileOp` **종류별로 합산**하므로, 한 트리에 같은 연산자 종류 노드가 둘 이상이면(예: Compound 다중 절) 동일 합산값을 표시할 수 있음. 노드 단위 정확도가 필요하면 `ProfileRecord`에 노드 ID 부여가 후속 과제.

### Track C — 확장 (낮은 우선순위, 큰 작업)

| 항목 | 비고 |
|------|------|
| 단계별 쿼리 빌더 (MATCH 시각 조립) | 비개발자 확장. 큰 작업, 후순위 |
| SSH 터널 | 내부망 접근용. Tauri 사이드카/네이티브 작업 필요 |
| 다중 연결 | 현재 단일 연결 — space 전환은 있음 |

---

## 3. 권장 실행 순서

1. **Track A 먼저 (스프린트 1~2)** — 서버 의존 없음, 코드 기반 완비, 사용자 체감 즉시.
   순서: A1(경고) → A2(자동완성 강화) → A4(즐겨찾기) → A3(EXPLAIN 최소 뷰어).
2. **B1 응답 스키마를 byoridb 팀과 협의** — Studio가 원하는 PROFILE 응답 형태(연산자 트리 + 행수/시간)를 먼저 제안서로 정리해 서버 작업을 unblock.
3. **서버 PROFILE/인덱스 정보 도착 후 Track B** — 이때 비로소 제안서의 "성능 가시성" 핵심 완성.
4. **Track C는 별도 비전** — `/cah:vision` 트랙으로 분리 검토.

---

## 4. 다음 액션 제안

- [x] ~~B1(PROFILE 구조화 응답), B2(인덱스/풀스캔 플래그)~~ → 서버 `dc5be3b` + Studio `ExplainView` 로 완료
- [ ] byoridb 레포에 **B3(개별 SlowLog 조회 API)** 이슈 등록 — 남은 서버 작업
- [ ] `NEXT.md` 의 "향후 과제"를 Track A + (남은) B3 로 교체
- [ ] Track A 착수: A1(대용량 결과 경고)부터 — 가장 작고 효과 큼
- [ ] (선택) ExplainView 를 QueryEditor 의 "Explain"/"Profile" 단축 버튼과 연결 — 현재는 사용자가 직접 `EXPLAIN`/`PROFILE` 프리픽스 입력

---

## 참고
- 원본 제안: `~/teo_ai/bench/studio-improvement.md`
- 서버 API 참조: `../byoridb/byoridb-graph/src/server.rs`, `metrics.rs`, `byoridb-executor/src/plan.rs`
