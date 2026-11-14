# 구조와 책임

Grove는 단일 Rust crate 서버와 공용 웹앱/PWA로 구성된다.
기존 제품은 동작 참고 자료이며 런타임 서버 의존성이 아니다.

| 영역 | 책임과 근거 |
|---|---|
| 서버 조립 | `src/lib.rs`의 `App`과 `router` |
| 영속 상태 | `src/store.rs`의 SQLite·migration·`Db::call` |
| HTTP 경계 | `src/auth.rs`, `src/error.rs`, `src/idem.rs`, `src/web.rs` |
| 실행·복구 | `src/runner.rs`, `src/startup.rs`, `src/approvals.rs`, `src/tasks.rs` |
| 모델·CLI | `src/provider/`, `src/agent_auth.rs`, `src/history.rs` |
| 파일 경계 | `src/project_fs.rs`, `src/tools/`, `src/files.rs` |
| 암호화 전송 | `src/e2ee.rs`, `web/app/api/transport.ts` |
| 웹 화면·조회 투영 | `web/app/components/`, `web/app/state/store.ts` |
| 계약 생성 | `tests/ts_bindings.rs`, `web/scripts/contract-metadata.mjs` |
| 빌드·배포 | `scripts/build.py`, `scripts/deploy_local.py`, `src/update.rs` |

## 데이터 흐름

HTTP 인증·Origin·호환성 검사 → 도메인 처리 → SQLite transaction → 상태·이벤트 commit → 응답과 구독자 알림.
웹은 API snapshot과 SSE 이벤트를 통해 서버 상태를 투영한다.
기기별 레이아웃·표시 설정과 영속 서버 상태를 같은 저장소로 취급하지 않는다.

- **MUST** 서버에 전역적인 현재 프로젝트·대화 상태를 추가하지 않고 요청마다 실행 대상을 명시한다.
  - why: 여러 pane과 기기의 요청 대상이 서로 덮어써지면 안 된다.
  - ✅ `App`은 공용 자원을 보유하고 턴 요청은 `session_id`를 전달한다. `evidence: src/lib.rs:128`, `evidence: src/runner.rs:1276`.
- **MUST** 서버 상태 변경 뒤 UI 갱신은 도메인 이벤트와 조회 cache 무효화를 함께 연결한다.
  - why: API 성공만으로 다른 pane·기기의 화면이 갱신되지는 않는다.
  - ✅ `pairing.changed`와 `applyEvent`의 `invalidate("pairings")` 연결. `evidence: src/pairing.rs`, `evidence: web/app/state/store.ts`.

상세 설계의 역사적 근거는 `migration/RULEBOOK.md`에 있다.
과거 고정 SHA·작업 배치·검증 주기를 현재 배포 대상이나 자동 실행 승인으로 해석하지 않는다.
