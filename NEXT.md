# 다음 업무 (Next Up)

마지막 업데이트: 2026-05-15 — ROADMAP 전체 구현 완료.

장기 계획은 [ROADMAP.md](./ROADMAP.md), 작업 컨텍스트는 [CLAUDE.md](./CLAUDE.md) 참고.

---

## 현재 상태: ROADMAP 완료 ✅

모든 Phase(1~7)가 구현되었습니다.

| Phase | 내용 | 상태 |
|-------|------|------|
| 1 | 서버 연동 완성 | ✅ |
| 2 | 쿼리 에디터 강화 (Monaco, 자동완성, 멀티탭, 스니펫) | ✅ |
| 3 | 결과 뷰어 개선 (그래프 시각화, JSON 트리뷰, 내보내기) | ✅ |
| 4 | 스키마 관리 UI (Space/Tag/Edge/Index, ERD) | ✅ |
| 5 | 데이터 관리 UI (Vertex/Edge CRUD, CSV Import) | ✅ |
| 6 | 모니터링 (서버 버전, 쿼리 분석, /metrics) | ✅ |
| 7 | UX 개선 (테마, 폰트 크기, 한국어/영어) | ✅ |

코드 품질 기반:
- ESLint + Prettier + rustfmt + clippy ✅
- GitHub Actions CI ✅
- TypeScript 타입 중앙화 (`src/types.ts`) ✅
- Property-Based Testing (fast-check) ✅

---

## 향후 과제 (미구현)

- **비밀번호 OS keychain 마이그레이션** — `localStorage` 평문 저장 → Tauri secret store
- **재연결 백오프 로직** — 헬스체크 실패 시 지수 백오프 재연결
- **gRPC 클라이언트** — HTTP REST 대신 gRPC (tonic) 사용 옵션
- **비동기 쿼리 취소** — 긴 쿼리 실행 중 취소 버튼

---

## 작업 시작 전 체크리스트

- [ ] `git status` 깨끗한지 확인
- [ ] `npm test` 통과 (74개)
- [ ] `cargo test --manifest-path src-tauri/Cargo.toml` 통과 (16개)
- [ ] `npm run lint` 오류 0개
