# b02 / 29 — hook 실행 연결 blocker

## 상태·기준

- 상태: **blocker, 구현 미완료**. `RESOURCE-016`의 실제 실행을 구현하거나 검증하지 않았다.
- worktree: `/home/ubuntu/.local/share/paseodog/paseo/worktrees/0q796rug/b02-29-hook-execution`
- branch: `parallel/b02-hook-execution`
- 공통 기준 및 시작 HEAD: `551f551d48d1f47cd3ad67015f1737c62d576228`
- 실제 top-level·branch가 `/data/project/paseodog_opus/work/README.md`의 29번 행과 일치했다. `git merge-base HEAD 551f551`도 같은 SHA였고 시작 worktree는 깨끗했다.
- authoritative assignment: `/data/project/paseodog_opus/work/ENTRY.md`, `/data/project/paseodog_opus/work/COMMON.md`, `/data/project/paseodog_opus/work/29.md`.
- 소유 변경 파일은 `work/RESULT-29.md` 하나다. 제품 코드·시험·설정·dependency·TODO는 변경하지 않았다.

## 핵심 blocker

배정된 공통 연결 지점에는 `src/tools/mod.rs`, `src/lib.rs`, 지정된 lifecycle 호출부, migration 추가 지점만 있고 `src/approvals.rs`는 없다. COMMON은 지정하지 않은 기존 파일을 편집하지 못하도록 제한한다.

기존 실제 승인·실행 경계는 다음과 같이 `src/approvals.rs`에 있다.

| 함수 | hook에 필요한 연결 |
|---|---|
| `create_call` | DB의 hook revision·enabled·scope·matcher를 확인하고 command·cwd·환경·shell·limits를 승인 target에 고정해야 한다. 일반 `tools::plan`에는 args와 root만 전달되며, DB를 사용하는 기존 MCP plan 보강도 이 함수의 전용 분기다. |
| `execution_permission` / `check_running_execution` | 승인 이후 설정 변경·삭제·비활성화와 scope 변경을 검사해야 한다. 현재 일반 도구 정책 재검사는 있지만 hook 정의 재검사는 없다. project resource 대기 뒤 재검사도 이 경계를 사용한다. |
| `spawn_execute` | App·DB·call·cancel을 가진 hook executor로 전달해야 한다. 일반 `tools::execute`에는 App·DB·session context가 없다. 기존 MCP executor도 이 함수에서 분기한다. |
| `create_call` / `spawn_execute`의 도구 수명주기 | 도구 이벤트를 연결한다면 hook 자체 실행의 재귀 발화를 제외할 연결이 필요하다. |

`src/tools/mod.rs`에 이름만 등록하면 위 DB 기반 계획·재검사를 연결할 수 없다. 별도 실행기·전역 App 우회 저장소·별도 subprocess 경로로 대체하지 않았다. `enabled`를 실행 허가로 취급하거나 승인 snapshot만 믿고 현재 revision 검사를 생략하지 않았다.

이 좁은 `src/approvals.rs` 연결에 대한 편집 범위 확대를 질문했지만 응답 없이 닫혀 명시적 추가 승인을 받지 못했다. 이를 승인이나 거절로 추정하지 않았다. 핵심 실행 연결이 막혔을 때 blocker를 기록하고 종료한다는 COMMON 계약에 따라 미연결 구현을 추가하지 않고 종료한다.

## 제공 동작·public 계약

신규 export·props·API·migration·event emitter·executor는 없다. 기존 hook CRUD, Owner 권한, revision·idempotency·명령 가림과 `execution_state: "not_implemented"`는 그대로다. 웹의 미실행 안내도 유지했다.

기존 `tool_calls` plan·승인·실행 전 권한 검사·receipt·unknown 복구와 `tools::shell`·`procs` API를 읽었지만 변경하거나 hook에 연결하지 않았다. 모든 hook 이벤트는 기존과 같이 실행 미지원이다.

## 검사·증거

| 명령·입력 | 결과 |
|---|---|
| `git status --short --branch`, `git rev-parse HEAD` | 시작 branch 일치, 깨끗한 worktree, 기준 SHA 일치 |
| `git rev-parse --show-toplevel`, `git merge-base HEAD 551f551`, `git status --short` | 배정 경로·기준 조상 일치, 보고서 작성 전 제품 변경 없음 |

Rust 컴파일·선택 integration 시험·Vitest·typecheck는 미실행이다. 제품 코드와 시험을 변경하지 않았고 hook 동작 검증의 대상 구현이 없으므로 통과를 주장하지 않는다. E2E·전체 회귀·release·패키징도 실행하지 않았다. 실제 사용자 hook·서비스·외부 네트워크 효과·로컬 fixture 명령도 실행하지 않았다.

## RESOURCE-016 충족 범위·남은 요구

**요구 충족 없음.** 이벤트 실제 실행, 승인 계획 고정, hook revision 재검사, hook 재귀 방지, 환경 격리, timeout·명시적 취소의 소유 process cleanup, 출력 가림·상한, restart·응답 유실의 unknown/no-auto-repeat 모두 hook 경로에서는 미구현·미검증이다. 기존 공통 실행기의 기능을 이번 hook 구현의 통과 근거로 사용하지 않는다.

feature 24의 실행 설정과 feature 23의 disconnect·terminal 동작, microphone·STT는 건드리지 않았다. 다른 세션 접촉·위임·merge·push·배포·workspace 삭제도 하지 않았다.

다음 행동은 `src/approvals.rs`의 hook 전용 plan 보강·실행 직전 재검사·executor 및 필요한 도구 lifecycle 분기에 대한 편집 소유권을 명시한 뒤 실제 구현을 재개하는 것이다. 기존 일반 승인·정책·receipt·복구 계약은 유지해야 한다. 이후 격리된 로컬 fixture로 선택 Rust·웹 검사를 수행하고 통합 단계에서 관련 E2E를 검증해야 한다. 이 결과는 기능 완료나 TODO 체크의 근거가 아니다.
