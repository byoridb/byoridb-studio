# Unit Test Execution

## Frontend (Vitest + Testing Library)

```bash
# 단일 실행
npm test

# 감시 모드 (개발 중)
npx vitest

# 커버리지 리포트 (coverage/index.html)
npm run coverage
```

**기대 결과**: 7 test files, 45 tests passed, 0 failed

### 테스트 파일 목록

| 파일 | 테스트 수 | 커버 범위 |
|------|-----------|-----------|
| `src/App.test.tsx` | 9 | 연결 흐름, 헬스체크 폴링, SESSION_EXPIRED |
| `src/components/Sidebar.test.tsx` | 6 | 스키마 로딩, DESCRIBE 캐시 |
| `src/components/QueryEditor.test.tsx` | 8 | 단축키, 히스토리 |
| `src/components/ResultPanel.test.tsx` | 9 | Table/JSON/Graph 뷰 |
| `src/components/ServerSettings.component.test.tsx` | 6 | 프로필 CRUD UI |
| `src/components/ServerSettings.test.ts` | 2 | loadSavedConnections/saveSavedConnections |
| `src/components/ConnectionModal.test.tsx` | 5 | 모달 인터랙션 |

## Backend (cargo test)

```bash
cd src-tauri && cargo test
```

**기대 결과**: 16 tests passed, 0 failed

### 테스트 목록 (`src-tauri/src/client.rs::tests`)

- `parse_query_response_maps_columns_rows_and_latency`
- `parse_query_response_defaults_when_fields_are_missing`
- `parse_names_ignores_rows_without_string_name`
- `parse_spaces_reads_partition_and_replica_from_server_columns`
- `parse_spaces_defaults_missing_numeric_columns_to_zero`
- `parse_session_id_accepts_numeric_value`
- `parse_session_id_rejects_string_value`
- `parse_session_id_rejects_missing_field`
- `parse_error_response_reads_structured_body`
- `parse_error_response_falls_back_to_raw_for_non_json`
- `parse_error_response_returns_raw_when_error_field_missing`
- `is_session_error_matches_known_phrases_case_insensitively`
- `is_session_error_rejects_unrelated_messages`
- `client_error_code_is_stable`
- `execute_returns_not_connected_when_client_has_no_session` (async)
- `disconnect_without_session_is_a_noop` (async)

## Code Quality Checks

```bash
# ESLint (오류 0개 기준)
npm run lint

# Prettier (포매팅 일치 기준)
npm run format:check

# rustfmt
cd src-tauri && cargo fmt --check

# clippy (-D warnings: 경고 0개 기준)
cd src-tauri && cargo clippy -- -D warnings
```
