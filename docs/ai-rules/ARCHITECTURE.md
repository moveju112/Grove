# 구조와 책임

Grove는 단일 Rust crate 서버와 공용 웹앱/PWA로 구성된다.
기존 제품은 동작 참고 자료이며 런타임 서버 의존성이 아니다.
기존 동작은 [Mixdog 공개 소스](https://github.com/tribgames/mixdog)를 참고할 수 있다. 코드를 가져오면 해당 라이선스·고지 의무를 유지하고 Grove의 인증·승인·취소 경계에 맞춰 통합한다.

| 영역 | 책임과 근거 |
|---|---|
| 서버 조립 | `src/lib.rs`의 `App`과 `router` |
| 영속 상태 | `src/store.rs`의 SQLite·migration·`Db::call` |
| HTTP 경계 | `src/auth.rs`, `src/error.rs`, `src/idem.rs`, `src/web.rs` |
| 실행·복구 | `src/runner.rs`, `src/startup.rs`, `src/approvals.rs`, `src/tasks.rs` |
| 모델·CLI | `src/provider/`, `src/agent_auth.rs`, `src/history.rs` |
| 턴 한정 CLI MCP | `src/continuations/bridge.rs`, `src/provider/cli.rs` |
| 파일 경계 | `src/project_fs.rs`, `src/tools/`, `src/files.rs` |
| 암호화 전송 | `src/e2ee.rs`, `web/app/api/transport.ts` |
| 웹 화면·조회 투영 | `web/app/components/`, `web/app/state/store.ts` |
| 계약 생성 | `tests/ts_bindings.rs`, `web/scripts/contract-metadata.mjs` |
| 빌드·배포 | `scripts/build.py`, `scripts/deploy_local.py`, `src/update.rs` |

## 데이터 흐름

HTTP 인증·Origin·호환성 검사 → 도메인 처리 → SQLite transaction → 상태·이벤트 commit → 응답과 구독자 알림.
웹은 API snapshot과 SSE 이벤트를 통해 서버 상태를 투영한다.
프로젝트별로 열린 대화와 이어갈 대화는 데몬에 저장한다. 분할 배치와 표시 설정은 기기별로 유지한다.

기본 Codex 연결(`codex_cli`)은 데몬 계정에 설치된 `codex app-server`와 표준 입출력으로 연결한다. 자격은 CLI가 관리하며 Grove는 `item/agentMessage/delta`를 전달한다. 이전 `codex_oauth` 프로필은 ID와 Grove 이력을 유지한 채 CLI로 전환하고, 전환 이전의 CLI 스레드에 다시 붙지 않는다. CLI로 바뀐 프로필이 후보인 HTTP fallback은 비활성화한다. `evidence: src/provider/cli/codex.rs`, `src/models.rs`, `src/store.rs`.

Claude Code는 데몬 계정에 설치된 `claude`를 실행한다. 공식 CLI가 인증을 관리하며, Grove는 Claude 구독 인증을 강제하거나 로그인 코드를 중계하지 않는다. 재개가 가능하고 실행 설정이 같으면 열린 SDK JSONL 연결에 새 메시지만 보낸다. 연결이 만료되거나 실행 설정이 바뀌면 재개 가능한 CLI 세션 ID로 다시 연결한다. 턴 전용 MCP 연결은 각 턴에서 교체·해제하고, 취소·오류·서버 종료 때는 프로세스를 보존하지 않는다. 제목·요약은 별도 호출을 유지한다. `evidence: src/provider/cli/claude_session.rs`, `evidence: src/provider/cli/claude.rs`.

사용량 화면의 tok/s는 출력 토큰과 짝이 맞는 모델 요청 시간만 사용한다. Claude Code는 `result.duration_api_ms`를 사용하며, 재사용한 프로세스에선 직전 누적값을 뺀다. 시간 미보고 CLI·과거 기록에 전체 턴 시간을 대신 넣지 않는다. 저장된 입력 총량에는 캐시 읽기·쓰기가 포함되고, 화면은 새 입력과 캐시를 분리해서 표시한다. `evidence: src/provider/cli/claude_session.rs`, `evidence: src/usage/dashboard.rs`, `evidence: web/app/components/usage/dashboardModel.ts`.

외부 CLI는 같은 프로필·프로토콜·시스템 지침에서 Grove의 직전 응답까지 반영한 세션만 재개한다. 중간에 다른 모델을 썼거나 반영 범위가 확인되지 않으면 새 CLI 세션을 시작하고 Grove 이력을 이번 요청과 구분해 전달한다. CLI 자체 세션 기록을 병합하지 않는다. `evidence: src/runner.rs`, `evidence: src/provider/cli.rs`.

- **MUST** 서버에 전역적인 현재 프로젝트·대화 상태를 추가하지 않고 요청마다 실행 대상을 명시한다.
  - why: 여러 pane과 기기의 요청 대상이 서로 덮어써지면 안 된다.
  - ✅ `App`은 공용 자원을 보유하고 턴 요청은 `session_id`를 전달한다. `evidence: src/lib.rs:128`, `evidence: src/runner.rs:1276`.
- **MUST** 서버 상태 변경 뒤 UI 갱신은 도메인 이벤트와 조회 cache 무효화를 함께 연결한다.
  - why: API 성공만으로 다른 pane·기기의 화면이 갱신되지는 않는다.
  - ✅ `pairing.changed`와 `applyEvent`의 `invalidate("pairings")` 연결. `evidence: src/pairing.rs`, `evidence: web/app/state/store.ts`.
