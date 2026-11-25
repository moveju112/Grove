# 단계 2: 설계 문서 적대적 검토 (재설계용 bakeoff 대체, DEV-004)

검토 대상: `migration/RULEBOOK.md` §3 불변식과 P1·P2 구현. 관점: 보안 경계, 복구, 동시성, 데이터 손실.
검토 방식: 같은 세션의 별도 검토 패스(DEV-002). 각 결함은 수정한 뒤 회귀 시험으로 고정했다.

| # | 발견 | 위반 불변식 | 조치 | 고정한 시험 |
|---|---|---|---|---|
| R1 | cursor 없이 첫 SSE 연결 시, 조회~연결 사이 변경을 놓칠 수 있음 | §3-4 이벤트 | `hello` 수신 시 cursor가 없었으면 snapshot 재조회(`web/app/api/events.ts`) | e2e 2명 pane 시험(재연결 후 상태 일치) |
| R2 | idempotency 기록 무한 증가 | 운영 자원 | 7일 초과 기록을 이벤트 정리와 함께 삭제(`events::prune`) | 정리 함수 단위 동작(주기 작업) |
| R3 | 브라우저 로그인 무차별 대입 제한 없음 | §3-9 인증 | 5회 실패 시 15분 잠금, DB 영속, `grove unlock` 로컬 복구 | `tests/integration/api.rs::browser_login_lockout_persists_and_can_be_cleared_locally`, `tests/integration/cli.rs::unlock_clears_lockouts` |
| R4 | React Router SPA의 인라인 스크립트가 CSP와 충돌하거나, 이를 피하려 `unsafe-inline`을 허용할 위험 | 웹 보안 | 인라인 스크립트 sha256 hash만 허용, 웹 산출물 교체 시 재계산 | `web/e2e/workspace.spec.ts` CSP 시험 |
| R5 | 실행 중 턴에 "메시지 저장"을 끼워 넣으면 tool call/result 짝이 깨짐 | §3-1·모델 입력 일관성 | 활성 턴이 있으면 메시지 저장 거부, 결과 없는 tool call은 입력 구성 시 중단 결과로 합성 | `tests/integration/turns.rs::one_active_turn_per_session_and_idempotent_create`, `runner::tests::missing_tool_results_are_synthesized` |
| R6 | 승인 이후 대상 파일이 바뀌어도 쓰기 | §3-5, SEC-008 | 실행 직전 precondition(hash) 재검사, 새 파일은 `create_new` | `approved_edit_applies_once_and_conflicts_if_file_changed`, mutation M7 |
| R7 | 승인 후 symlink 교체로 경계 밖 쓰기 | §3-7 | 실행 직전에 target 경로를 다시 canonicalize해 경계 재검사 | `tools::fs::tests::resolve_blocks_escape`, mutation M6 |
| R8 | 기기 토큰 원문이 idempotency 저장본에 남음 | §3-8 비밀 | 저장본에서 일회성 필드 제거(`run_redacted`) | `tests/integration/api.rs::device_token_redacted_on_replay` |
| R9 | provider redirect로 API 키가 다른 host에 전달될 수 있음 | §3-8 | HTTP client redirect 비활성화, 오류 메시지에서 URL 제거 | `provider` 오류 분류 시험(`redirect_blocked`) |
| R10 | 재시작 시 승인 대기 턴을 interrupted로 바꾸면 기기 이동 중 승인이 유실됨 | FLOW-07 | 승인 대기 턴은 유지하고 결정 후 새 epoch로 재개 | `tests/integration/turns.rs::approval_survives_restart_and_resumes` |

남은 위험(이 단계에서 해결하지 않음, TODO에 추적):
- Windows Job Object 기반 프로세스 격리 미구현(`TODO(port)` in `src/tools/shell.rs`), Windows 실기기 미검증.
- 최근 목록 필터를 메모리에서 계산(`PERF(port)` in `src/workspace.rs`).
- 공정 실행 큐(FAIR) 미구현: 현재는 세션당 1턴 제약만 있다.
