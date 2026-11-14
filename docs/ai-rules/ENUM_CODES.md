# 실행 상태와 오류 코드

새 상태를 추가할 때는 문자열 목록보다 상태 전이와 복구 의미를 먼저 정한다.

| 정본 | 함께 확인할 곳 |
|---|---|
| 턴 | `src/runner.rs`의 `TURN_TRANSITIONS`, DB CHECK, 웹 투영 |
| 도구 승인·실행 | `src/approvals.rs`, `src/tools/`, `src/store.rs` |
| 프로세스·터미널 | `src/tasks.rs`, `src/terminals.rs`, 재시작 복구 |
| API 오류 | `src/error.rs`, `web/app/api/client.ts` |

- **MUST** 종료된 턴을 실행 중 상태로 되돌리지 않고 재시도는 새 턴으로 만든다.
  - why: 기존 실행의 결과·소유권·receipt를 재사용하면 이력이 모호해진다.
  - ✅ `TURN_TRANSITIONS`에는 종료 상태에서 나가는 전이가 없다. `evidence: src/runner.rs:185`.
- **MUST** `idle`·`canceling` 같은 화면상 상태와 DB에 저장되는 턴 상태를 구분한다.
  - why: UI 표시를 SQL enum으로 추가하면 실행 상태 모델이 왜곡된다.
  - ✅ `idle`은 활성 턴이 없는 대화이며 별도 행이 아니다. `evidence: src/runner.rs:185`.
- **MUST** 취소 접수·프로세스 종료·결과 확정을 구분한다.
  - why: 취소 신호는 부작용이 중단되거나 되돌아갔다는 증거가 아니다.
  - ✅ `cancel_turn`과 실행 경로의 종료 처리·소유 작업 대기 구분. `evidence: src/runner.rs`.
- **MUST** DB CHECK·서버 전이·웹 표시·SSE cache 무효화를 함께 검토한다.
  - why: 한 계층에만 새 상태가 있으면 저장 실패나 갱신되지 않는 화면이 생긴다.
  - ✅ 턴 CHECK, `TURN_TRANSITIONS`, `applyEvent`를 대조한다. `evidence: src/store.rs:132`, `evidence: web/app/state/store.ts`.

`unknown`과 `interrupted`를 같은 의미로 합치지 않는다.
턴 소유권 epoch 상실과 외부 도구의 결과 불명은 다른 복구 상황이다. `evidence: src/runner.rs:365`.
