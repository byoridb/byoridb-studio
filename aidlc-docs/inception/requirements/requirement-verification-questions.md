# Requirements Verification Questions

각 질문에 대해 `[Answer]:` 태그 뒤에 알파벳 한 글자로 답해 주세요. 보기에 적합한 항목이 없으면 `X` (또는 마지막 옵션)를 고르고 자유 서술을 덧붙여 주세요. 모든 답을 채우신 뒤 "완료" 또는 비슷한 표현으로 알려주시면 분석을 진행하겠습니다.

---

## Intent Analysis (지금까지의 사용자 입력 요약)

지금까지 audit.md에 기록된 사용자 입력은 다음 세 건입니다:

1. `"ai-dlc-workflow 에 따라.. 필요한 문서들 중 빠진거 확인해봐"` — 누락 문서 점검 요청
2. `"A"` — Workspace Detection + Reverse Engineering 실행 선택
3. `"ㅇㅇ 넘어가자"` — Reverse Engineering 산출물 승인

여기까지의 입력만으로는 **앞으로 어떤 변경/기능을 구현할지**가 명시되지 않았습니다. 아래 질문에 답해 주시면 그에 맞춰 Requirements를 작성합니다.

---

## Question 1
이번 AI-DLC 워크플로우의 **즉시 목표**는 무엇인가요?

A) **문서화만 진행**: 지금 생성한 RE 산출물에서 워크플로우를 종료. 실제 코드 변경은 없음
B) **ROADMAP / NEXT.md의 다음 항목을 구현**: Phase 2 — 쿼리 에디터 강화 (Monaco Editor + nGQL 구문 강조)
C) **ROADMAP의 다른 단계 항목 구현**: Phase 3(결과 뷰어 / 그래프 시각화), Phase 4(스키마 관리 UI), Phase 5(데이터 관리 UI), Phase 6(모니터링), Phase 7(UX 개선) 중 선택
D) **새로운 기능 추가**: ROADMAP에 없는 새로운 요구사항을 가지고 있음
E) **버그 수정 / 리팩터링**: 기존 동작의 결함 수정이나 코드 정리
F) **기존 기술 부채 해소**: code-quality-assessment.md의 기술부채 항목 (예: ESLint/CI/타입 중복/CSP/keychain) 작업
X) Other (please describe after [Answer]: tag below)

[Answer]: A,B,C,E,F

---

## Question 2 (Q1에서 B/C/D를 골랐을 때만)
구체적으로 어떤 기능/항목을 작업하고 싶으신가요? **자유 서술**로 답해 주세요.
- B(Phase 2 Monaco)를 고른 경우: 추가 요구가 있으면 적어주세요. 없으면 "기본 ROADMAP대로"라고 적어도 됩니다.
- C(다른 Phase) 또는 D(새 기능)를 고른 경우: 어떤 기능인지, 어떤 사용자 시나리오를 만족시키고 싶은지, 우선순위는 어떤지 적어주세요.

(Q1이 A/E/F이면 이 질문은 건너뛰셔도 됩니다.)

[Answer]: 기본 로드맵대로 가되, 디테일을 살리고 싶어.

---

## Question 3
이번 작업의 **범위(scope)**는?

A) 단일 파일 / 단일 컴포넌트 변경
B) 프론트엔드만 (예: UI 추가만, 백엔드 명령은 변경 없음)
C) 백엔드만 (예: 새로운 Tauri 명령 추가, UI 변경 없음)
D) 프론트엔드 + 백엔드 동시 변경
E) 프로젝트 전반 변경 (테스트/CI/빌드 도구 포함)
X) Other (please describe after [Answer]: tag below)

[Answer]: E

---

## Question 4
이번 작업에 **우선적으로 신경 써야 할 비기능 요건(NFR)**은? (가장 중요한 1~2가지를 골라주세요. X로 자유서술 가능)

A) **성능** — UI 반응성, 대용량 결과 렌더링 등
B) **보안** — 비밀번호/세션 처리, CSP, OS keychain 등 (우선순위 높음 → Question 5 보안 확장 활성화 권장)
C) **신뢰성/회복성** — 재연결, 백오프, 세션 만료 처리 강화 등
D) **개발자 경험(DX)** — 린트/포매터/CI/타입 정리, 테스트 커버리지 강화 등
E) **사용자 경험(UX)** — 접근성, 다국어, 키보드 단축키 등
F) **특별히 강조할 NFR 없음** — 기존 코드 품질 수준 유지면 충분
X) Other (please describe after [Answer]: tag below)

[Answer]: A,C

---

## Question 5: Security Extensions
이 프로젝트에 보안 확장 규칙을 강제 적용할까요?

A) Yes — 모든 SECURITY 규칙을 blocking constraint로 적용 (프로덕션 수준 앱에 권장)
B) No — 모든 SECURITY 규칙을 건너뜀 (PoC, 프로토타입, 실험적 프로젝트에 적합)
X) Other (please describe after [Answer]: tag below)

[Answer]: A

---

## Question 6: Property-Based Testing Extension
이 프로젝트에 property-based testing(PBT) 규칙을 강제 적용할까요?

A) Yes — 모든 PBT 규칙을 blocking constraint로 적용 (비즈니스 로직, 데이터 변환, 직렬화, stateful 컴포넌트가 있는 프로젝트에 권장)
B) Partial — pure function과 직렬화 round-trip에만 PBT 규칙 적용 (알고리즘 복잡도가 제한적인 프로젝트에 적합)
C) No — 모든 PBT 규칙을 건너뜀 (단순 CRUD, UI 전용, 비즈니스 로직이 적은 thin integration layer에 적합)
X) Other (please describe after [Answer]: tag below)

[Answer]: A

---

## 추가 요청 (선택)
ROADMAP/NEXT.md에 적힌 항목 외에 명시적으로 **포함해야 할** 또는 **명시적으로 제외해야 할** 사항이 있다면 자유 서술로 적어 주세요.

[Answer]: 찬찬히 안정적으로 개발
