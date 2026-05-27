# Onboard Notes — ByoriDB Studio

변경 이력 및 머지 결정 사유를 기록합니다.

---

## 2026-05-21 — 최초 onboard

**실행**: `brownfield-onboard` (cah-dlc v0.3.0)
**입력**: `aidlc-docs/audit/audit-report.md` (2026-05-21 스캔)

### AGENTS.md

- **상태**: 신규 생성
- **내용**: 빠른 진입 명령어, 디렉토리 구조, 네이밍/에러/로깅/테스트 컨벤션, 금지 사항, AI 에이전트 작업 룰

### CLAUDE.md

- **상태**: merge (기존 내용 유지 + 3개 섹션 추가)
- **추가된 섹션**:
  - `## AI-DLC (cah-dlc) 통합` — 사용 가능한 skill 목록 + 우선 호출 순서 + 산출물 위치
  - `## 코드베이스 주의사항` — audit-report High finding (App.tsx, Sidebar.tsx) + 알려진 함정
  - `## TODO (cah-dlc 도입 진행 중)` — migration, CI, 훅 분리 등 후속 항목
- **유지된 내용**: 빌드/테스트 명령어, 아키텍처 설명, ByoriDB 서버 API 명세, nGQL 레퍼런스 — 전체 보존

### 머지 결정 사항

| 항목 | 결정 | 이유 |
|---|---|---|
| 기존 CLAUDE.md 빌드 명령어 | 유지 | 실제 작동 중인 명령어 |
| 기존 CLAUDE.md API 명세 | 유지 | 서버 API 레퍼런스로 필수 |
| 기존 CLAUDE.md nGQL 레퍼런스 | 유지 | 쿼리 작성 시 참조 필수 |
| cah-dlc skill 안내 | 추가 | Claude Code 전용, 기존 내용과 충돌 없음 |
| 코드베이스 함정 | 추가 | audit에서 확인된 High 위험 모듈 명시 |
| CSS 컨벤션 | "변경 예정"으로 표기 | 사용자 확인: 현재 패턴은 임시 |

### 사용자 확인 결과 (audit 인터뷰 기반)

- AI-DLC 도입 동기: 전체 리팩토링 포함 (기존 코드도 점진 정리)
- App.tsx / Sidebar.tsx: 실제 위험으로 확인, 분리 예정
- CSS 접근법: 변경 예정

### 다음 권장 단계

1. `/cah:brownfield-migrate` — 마이그레이션 플랜 (모듈 우선순위, grace period, CI 도입 일정)
2. Phase 2 진입 전 App.tsx / Sidebar.tsx 훅 분리
