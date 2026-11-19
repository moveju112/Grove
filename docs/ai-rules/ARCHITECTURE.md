# 구조와 책임

Grove는 단일 Rust crate 서버와 공용 웹앱/PWA로 구성된다.
기존 제품은 동작 참고 자료이며 런타임 서버 의존성이 아니다.
Computer Use 등 기존 동작은 [Mixdog 공개 소스](https://github.com/tribgames/mixdog)를 참고할 수 있다. 코드를 가져오면 해당 라이선스·고지 의무를 유지하고 Grove의 인증·승인·취소 경계에 맞춰 통합한다.

| 영역 | 책임과 근거 |
|---|---|
| 서버 조립 | `src/lib.rs`의 `App`과 `router` |
| 영속 상태 | `src/store.rs`의 SQLite·migration·`Db::call` |
| HTTP 경계 | `src/auth.rs`, `src/error.rs`, `src/idem.rs`, `src/web.rs` |
| 실행·복구 | `src/runner.rs`, `src/startup.rs`, `src/approvals.rs`, `src/tasks.rs` |
| 모델·CLI | `src/provider/`, `src/agent_auth.rs`, `src/history.rs` |
| 서버 PC 제어·턴 한정 CLI MCP | `src/computer/`, `src/provider/cli.rs`; 데몬 OS로 Windows Win32 / Linux X11 창 메시지 backend를 자동 선택 |
| 파일 경계 | `src/project_fs.rs`, `src/tools/`, `src/files.rs` |
| 암호화 전송 | `src/e2ee.rs`, `web/app/api/transport.ts` |
| 웹 화면·조회 투영 | `web/app/components/`, `web/app/state/store.ts` |
| 계약 생성 | `tests/ts_bindings.rs`, `web/scripts/contract-metadata.mjs` |
| 빌드·배포 | `scripts/build.py`, `scripts/deploy_local.py`, `src/update.rs` |

## 데이터 흐름

HTTP 인증·Origin·호환성 검사 → 도메인 처리 → SQLite transaction → 상태·이벤트 commit → 응답과 구독자 알림.
웹은 API snapshot과 SSE 이벤트를 통해 서버 상태를 투영한다.
프로젝트별로 열린 대화와 이어갈 대화는 데몬에 저장한다. 분할 배치와 표시 설정은 기기별로 유지한다.

기본 Codex 연결(`codex_oauth`)은 Grove 이력과 도구 루프를 Codex Responses API에 연결한다. `store: false`로 호출하며 Codex CLI의 스레드를 시작하거나 재개하지 않는다. CLI 로그인 파일의 계정 자격은 메모리에서만 사용하고, 필요한 갱신은 계정 전용 CLI 호출에 맡긴다. `evidence: src/provider/codex_oauth.rs`.
같은 턴의 모델 단계는 WebSocket을 우선 재사용한다. 요청 설정과 이력 앞부분이 같을 때만 `previous_response_id`와 새 입력을 보내며, 새 연결과 HTTP/SSE 폴백은 Grove 이력 전체를 보낸다. 과부하 재시도는 부분 출력이 없는 모델 단계에만 적용한다. `evidence: src/provider/codex_oauth/ws.rs`, `src/provider/mod.rs`.

- **MUST** 서버에 전역적인 현재 프로젝트·대화 상태를 추가하지 않고 요청마다 실행 대상을 명시한다.
  - why: 여러 pane과 기기의 요청 대상이 서로 덮어써지면 안 된다.
  - ✅ `App`은 공용 자원을 보유하고 턴 요청은 `session_id`를 전달한다. `evidence: src/lib.rs:128`, `evidence: src/runner.rs:1276`.
- **MUST** 서버 상태 변경 뒤 UI 갱신은 도메인 이벤트와 조회 cache 무효화를 함께 연결한다.
  - why: API 성공만으로 다른 pane·기기의 화면이 갱신되지는 않는다.
  - ✅ `pairing.changed`와 `applyEvent`의 `invalidate("pairings")` 연결. `evidence: src/pairing.rs`, `evidence: web/app/state/store.ts`.
