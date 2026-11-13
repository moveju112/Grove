# b01 / 09 — 승인 카드 명확화 인계

- 상태: 독립 구현 종료, 공통 화면 연결·실행 검증 대기. 제품 기능 전체 완료 아님.
- worktree: `/home/ubuntu/.local/share/paseodog/paseo/worktrees/0q796rug/b01-09-approval-ui`
- branch: `parallel/b01-approval-ui`
- 공통 기준: `c186b31ab62734c9f91803cf7848b639ad9871fb`
- 시작 상태: clean. 실제 top-level·브랜치가 README의 09 행과 일치하고 merge-base가 공통 기준과 일치했다.
- 세션 상태 조회는 런타임 오류 `session: cross-session control is unavailable in this runtime`로 불가능했다. 다른 세션에 연락하거나 원본 프로젝트를 수정하지 않았다.

## 소유 변경

- `web/app/components/approvals/ApprovalCard.tsx`: typed props 기반 승인 카드.
- `web/app/components/approvals/projection.ts`: 제한된 대상 projection, effect·선택지 adapter, 상태·오류 분류.
- `web/app/components/approvals/decision.ts`: identity에 결합된 단일 전송과 폐기 처리.
- `web/app/components/approvals/approval.css`, `web/app/components/approvals/index.ts`.
- `web/app/components/approvals/fixtures.test-support.ts`.
- `web/app/components/approvals/projection.test.ts`, `web/app/components/approvals/decision.test.ts`, `web/app/components/approvals/ApprovalCard.test.ts`.
- `web/e2e/approval-presentation.spec.ts`.
- `work/RESULT-09.md`.

## 동작·공개 계약

`web/app/components/approvals/index.ts`에서 `ApprovalCard`, `ApprovalCardProps`, `ApprovalFeedback`, `currentApprovalContract`, `approvalFailure`, `approvalKey`, `projectApproval` 및 승인 관련 타입을 export한다.

- `call: ToolCallRow`: 기존 generated 타입 그대로 사용한다. `args`를 표시하지 않으며 서버의 `target`만 allowlist projection한다.
- `effect: ApprovalEffect | null`: read/write/execute/delegate/conversation을 별도 주입한다. 알 수 없는 effect로는 승인할 수 없다.
- `choices: readonly ApprovalDecision[]`: approve/approve_session/deny 중 제공받은 선택지만 버튼으로 만든다.
- `currentApprovalContract(name)`: 현재 `src/tools/mod.rs::specs`의 effect와 `src/approvals.rs::decide`의 선택 제한을 반영한다. agent·mcp_call은 이번만 승인·거부만, ask_user는 기존 질문 카드 영역이다. 미등록 도구는 effect null·선택지 없음으로 반환한다. 신규 도구나 서버 계약 변경 때 adapter도 갱신해야 한다.
- `onDecision(request): Promise<ToolCallRow>`: `{ id, session_id, revision, decision }`를 받는다. 호출부는 요청의 id와 revision을 사용해야 하며 최신 선택 카드의 값을 나중에 다시 읽으면 안 된다. API 실패를 삼키지 않고 reject해야 한다.
- `feedback?`: id/session_id/revision이 같은 외부 pending 또는 failed만 적용한다. 외부 오류는 `approvalFailure(error)`로 정규화해 주입하고 API 원문을 넣지 않는다.
- `onRefresh?(identity): Promise<void>`: 해당 요청을 재조회하는 동작이다. 자동 승인·재전송은 하지 않는다. 재조회 실패도 별도로 알린다. 같은 revision에서 전송이 실패한 카드는 재승인되지 않으며, 서버의 새 revision 또는 확정 상태를 반영해야 한다.
- `focusOnMount?`: 기본 false. 새 요청에 초점을 보내기로 호출부가 결정했을 때만 true를 준다. 승인 버튼이 아니라 거부 버튼(없으면 제목)으로 초점을 보낸다.

대상에는 경로, 명령·cwd·실행 제한·백그라운드 방식, 패치별 추가/수정/삭제/이동, agent 대상, MCP 서버/revision/namespace/도구/목적지를 표시한다.
전체 인자, 파일 preview/diff, 위임 brief, MCP arguments와 stdio args는 DOM에 넣지 않는다. 일반 표시값의 알려진 credential 형식과 URL 인증·query를 가리고 길이·파일 개수를 제한한다. 생략된 부분도 승인 범위에 포함된다는 경고를 표시한다. 이 처리는 임의의 비밀값을 완벽히 검출하는 범용 DLP가 아니므로 명령의 비정형 secret까지 안전하다고 간주하면 안 된다.

대화 허용은 “현재 대상만”이 아니라 “이 대화의 해당 도구 전체”임을 설명하며 금지·읽기 전용 우선 및 해제 위치를 알린다. 별도 영구 정책이나 새 권한을 만들지 않는다.
승인됨/실행 중/완료/거부/만료/실패/취소/결과 불명을 구분한다. 승인 응답은 실행 성공이 아니다. 취소는 이미 발생한 부작용의 부재를 보장하지 않는다.
동기 전송 잠금으로 빠른 중복 클릭을 막고, session/id/revision 교체 시 내부 인스턴스를 폐기해 늦은 결과를 버린다. 응답의 identity·revision·상태를 검증하며 잘못된 응답·전송 유실은 결과 불명으로 잠근다. 만료는 타이머와 클릭 시점 양쪽에서 확인하지만 최종 권한·만료 판단은 서버가 한다.
기본 버튼 키보드 조작, 연결된 제목·상태 설명, 상태 live region 및 오류 alert, focus-visible 스타일을 제공한다. 즉시 읽어야 하는 승인 정보이므로 등장 애니메이션은 추가하지 않았다.

## 공통 연결 지점

1. `web/app/components/SessionView.tsx`의 기존 로컬 `ApprovalCard`를 제거하고 신규 export를 import한다. 기존 pending 카드 위치에서 `call={c}`와 `currentApprovalContract(c.name)`의 effect/choices를 전달한다. CSS는 컴포넌트 import에 포함돼 있다.
2. `onDecision`은 `api.post<ToolCallRow>(\`/tool-calls/${request.id}/decision\`, { decision: request.decision, expected_revision: request.revision })` 결과를 반환한다. 기존 `act`는 오류를 삼킬 수 있으므로 그대로 감싸지 않는다. 기존 API 클라이언트의 인증·Idempotency-Key를 유지한다.
3. 재조회·SSE/store 갱신은 동일 id/session으로 한정하고, 다른 대화의 선택 상태를 덮어쓰지 않도록 한다. `onRefresh`에도 요청 identity를 사용한다. 승인 후 재실행을 추가하지 않는다.
4. 현재 SessionView는 pending_approval만 카드로 보여 준다. 오류·확정 상태를 읽을 수 있는 표시 수명과 카드 제거 후의 초점 복귀를 연결해야 한다. UI가 unknown을 성공으로 바꾸거나 새 요청처럼 자동 재전송하지 않게 유지한다. 기존 UnknownCard의 관찰·검토 절차를 대체하지 않는다.
5. `TODO.md`, 공통 store/API/서버는 수정하지 않았다. 통합 후 실제 검증 근거에 따라 UI-015를 판단한다.

## 검증 근거·미실행

- 실행: `git rev-parse --show-toplevel --abbrev-ref HEAD`, `git status --short --branch`, `git merge-base HEAD c186b31ab62734c9f91803cf7848b639ad9871fb`. 작업 위치·기준 확인.
- 실행: `source .envrc.dev && python3 scripts/build.py test --vitest app/components/approvals/projection.test.ts app/components/approvals/decision.test.ts app/components/approvals/ApprovalCard.test.ts --dry-run`. exit 0, 세 파일의 Vitest 선택 명령만 출력했다. 실제 시험 통과 근거가 아니다.
- 실행: `git diff --check`. 오류 출력 없음.
- 단위 시험 미실행: 이 worktree의 `web/`에 `node_modules`가 없다. 설치·복사·npx 자동 다운로드를 하지 않았다.
- 작성한 단위 시험: 현재 effect/선택지, 민감 본문 제외·credential 가림·길이 제한·패치 대상, identity/revision 확인, 만료/권한/경합/전송 오류, 중복 전송·늦은 성공/실패 폐기, SSR 대상/범위/상태/잠금/외부 feedback.
- typecheck·웹/Rust 빌드·E2E 미실행: COMMON의 독립 단계 자원 제한과 화면 미연결에 따라 통합 단계로 이관했다.
- 작성한 E2E: 실제 disposable 서버의 직접 tool-call API로 승인 요청을 만들고 대상/범위·비밀 본문 제외, 키보드 거부 후 파일 미생성, 응답 대기 잠금, 403 오류, transport abort 후 결과 불명과 재승인 차단을 확인한다. 시간 지연 대신 요청 도착·응답 barrier를 사용한다. 실행 전 SessionView 연결이 필요하며, 서버 처리 뒤 응답만 유실되는 전체 복구 시나리오를 검증했다고 주장하지 않는다.

## UI-015 판단·다음 단계

대상·부작용·허용 범위·거부·진행·실패를 표현하는 독립 구현과 시험은 작성됐다. 화면 연결 및 실행 검증 전이므로 UI-015 전체 요구 충족이나 완료 후보로 단정하지 않는다.
구현 자체를 막는 계약 충돌은 없다. 남은 blocker는 공통 화면 미연결과 로컬 시험 의존성 미준비다.
통합 담당은 연결 후 위 선택 Vitest와 `python3 scripts/build.py test --typecheck --e2e e2e/approval-presentation.spec.ts e2e/workspace.spec.ts`를 실행하고, 실제 초점 이동·카드 제거 수명·새 도구 effect/승인 선택지 경계를 확인해야 한다. 환경 복구는 통합 환경의 승인된 의존성·공통 빌드 환경을 사용한다.
push·merge·배포·서비스 중단은 수행하지 않는다. 이 파일과 소유 코드·시험만 로컬 커밋 후 작업을 종료한다.
