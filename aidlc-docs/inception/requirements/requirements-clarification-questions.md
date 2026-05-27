# Requirements Clarification Questions

답변 분석 중 아래 모순/모호함이 발견되었습니다. 해결 후 requirements.md를 작성하겠습니다.

---

## 모순 1: Q1 — A(문서화만/종료)와 B/C/E/F(코드 작업) 동시 선택

Q1에서 A("문서화만 진행, 코드 변경 없음")와 B("Phase 2 Monaco"), C("다른 Phase"), E("버그수정/리팩터링"), F("기술부채 해소")를 모두 선택하셨습니다.

A는 "이번 워크플로우는 RE 산출물 생성으로 종료"를 의미하고, B/C/E/F는 "실제 코드 변경 작업을 진행"을 의미합니다. 두 방향은 양립할 수 없습니다.

### Clarification Question 1
이번 AI-DLC 워크플로우에서 **실제 코드 변경 작업을 진행할 것인가요?**

A) **예, 코드 작업을 진행한다** — RE 산출물을 기반으로 Requirements → Workflow Planning → Code Generation까지 진행
B) **아니오, 이번은 문서화(RE 산출물)만으로 종료한다** — 나중에 새 작업 요청 시 다시 Requirements Analysis부터 시작

[Answer]: A 코드 작업을 진행함.

---

## 모호함 1: Q1 B+C+E+F — 범위가 너무 넓음

B(Phase 2 Monaco), C(다른 Phase), E(버그수정), F(기술부채)를 모두 선택하셨고, Q3에서 E(프로젝트 전반)를 선택하셨습니다. 이는 사실상 ROADMAP 전체 + 기술부채 + 버그수정을 한 번에 다루는 것입니다.

Q2 답변("기본 로드맵대로 가되, 디테일을 살리고 싶어")과 추가 요청("찬찬히 안정적으로 개발")을 함께 보면, **한 번에 전부 하기보다 순서를 정해 단계적으로 진행**하는 것이 의도에 더 맞아 보입니다.

(Clarification Q1에서 A를 선택한 경우에만 답해 주세요.)

### Clarification Question 2
**이번 첫 번째 작업 단위**로 무엇을 선택하시겠습니까?

A) **Phase 2.1 — Monaco Editor 통합** (QueryEditor를 textarea에서 Monaco로 교체, 기존 단축키/히스토리 유지)
B) **Phase 2.1 + 2.2 — Monaco + nGQL 구문 강조** (Monaco 통합 후 nGQL 토크나이저까지 한 번에)
C) **기술부채 먼저** — ESLint/Prettier/clippy/CI 설정, TS 타입 중앙화 등 코드 품질 기반 작업 후 기능 개발
D) **Phase 3.3 — 그래프 시각화** (결과 패널의 placeholder Graph 뷰 구현)
E) **복합 — 기술부채(린트/CI) + Phase 2.1 Monaco를 한 번에** (기반 정비 + 첫 기능 동시 진행)
X) Other (please describe after [Answer]: tag below)

[Answer]: C 먼저

---

모든 답을 채우신 뒤 "완료"라고 알려주세요.
