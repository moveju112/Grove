<!-- grove-handoff:v1
{"state":"ready","remaining":[],"blockers":[],"integration_checks":[]}
-->

# b02 / 29 — 승인형 lifecycle hook 실행

## 상태·기준

- worktree: `/home/ubuntu/.local/share/paseodog/paseo/worktrees/0q796rug/b02-29-hook-execution`
- branch: `parallel/b02-hook-execution`
- 공통 기준: `551f551d48d1f47cd3ad67015f1737c62d576228`
- 재개 HEAD: `3cb8d0ec34e9bf35b8b09bbb2dc44391f9b8cb81`. 최초 소유권 누락을 기록한 이 커밋은 보존했다. 갱신된 `/data/project/paseodog_opus/work/29.md`와 사용자의 replacement assignment가 `src/approvals.rs`의 좁은 hook 연결 소유권을 명시해 blocker가 해소됐다. 권한 거절을 뒤집은 작업이 아니다.
- 브라우저 인수 후속의 재개 HEAD는 `538fc9955de2ba2b9d38e4f145ea02b1c61a3123`이다. 원본 `35f0baf:work/29.md`와 live COMMON의 후속 소유권을 확인했다. 기존 커밋·기준·지원 범위는 보존했다.
- ENTRY·COMMON·갱신된 29를 읽고 실제 top-level·branch·깨끗한 재개 상태를 확인했다. README의 배정 경로·branch는 이전 확인과 일치한다.
- 상태: **지원 범위 구현·선택 검증·배정된 브라우저 인수 완료**. 실행 가능한 소유 잔여와 외부 blocker는 없다. 아래 미지원 이벤트·발생 경로·플랫폼 구분은 그대로이며 `RESOURCE-016` 전체 이벤트 완료를 주장하지 않는다.

## 제공 동작·이벤트 계약

이벤트는 원래 동작과 같은 DB transaction에서 접수한다. 전역 hook과 해당 프로젝트 hook을 합산하고 enabled·event·glob이 일치하면 `hook` tool call을 만든다. 이벤트·hook 쌍은 한 번만 계획되며, 저장·enabled·`tools.allow`·과거 session grant만으로 새 이벤트의 실행을 시작하지 않는다. 매 이벤트마다 새 계획 승인이 필요하다.

| 이벤트 | 실제 연결 | matcher 대상 |
|---|---|---|
| `SessionStart` | `sessions::create`의 직접 대화 생성 API | 생성된 대화 ID |
| `UserPromptSubmit` | `runner::enqueue_with_attachments`의 source 없는 직접 턴 접수, `sessions::post_message` | 대화 ID |
| `PostToolUse` | Grove `approvals::spawn_execute`의 non-hook 도구 receipt 확정. 성공·실패 모두 포함 | 도구 이름 |
| `Stop` | `runner::finish_turn`의 조건부 종료 전이. 정상 완료뿐 아니라 실패·취소·재시작 중단도 포함 | 대화 ID |
| `PreToolUse` | **미지원**. 원래 도구의 시작을 hook 승인·결과로 차단하는 계약은 구현하지 않음 | 실행하지 않음 |
| `SessionEnd` | **미지원**. 보관·삭제·연결 종료를 임의의 실행 트리거로 취급하지 않음 | 실행하지 않음 |

지원 실행은 Linux의 `bash`·`sh`에 한정한다. 다른 플랫폼·셸은 실행하지 않는다. fork·자식/봇 세션 생성, followup/steer 접수, 예약·부모 agent가 보낸 입력, CLI/모델 내부 도구 활동은 위 이벤트에 연결하지 않았다. 웹에 이 미연결 범위도 표시한다.

hook은 **원래 작업을 차단하지 않는 독립 알림형 실행**이며 `turn_id`는 null이다. 원래 턴의 완료·실패를 hook 승인·결과로 바꾸지 않고, 원래 턴 취소가 독립 hook을 취소한다는 계약도 없다. hook은 전용 실행 요청의 취소 버튼/기존 tool-call cancel API로 취소한다. 프로젝트 실행 guard는 기존 Execute 도구와 공유한다.

## 안전·복구 계약

- 기존 `approvals::create_call` → 승인 → 조건부 running claim → project guard 뒤 `check_running_execution` → receipt 확정을 재사용한다. hook 전용 계획 보강·현재 정의 검사·executor 분기·non-hook PostToolUse 연결만 추가했다. 일반 승인·MCP·receipt 상태 전이를 교체하지 않았다.
- 승인 target에 command 표시와 SHA-256, canonical cwd, hook revision·scope·matcher, event·match target, shell, 환경 전체, timeout, 기존 메모리·CPU 한도를 고정한다. command 원문은 응답 직렬화에서 제외되는 기존 private precondition에 보관하며 target binding도 검사한다.
- 실행 전에는 활성 대화·현재 project/worktree root·hook 존재·enabled·revision·scope·event·matcher·원문 일치·현재 limits를 재검사한다. 현재 hook 정책과 shell 정책의 deny/read_only가 모두 우선한다. guard 대기 중 설정 변경 및 session grant 철회도 실행을 차단한다.
- 신규 이벤트는 항상 별도 승인 대기다. 일반 decision API의 `approve_session`으로 현재 요청을 처리한 경우에는 기존 grant 철회 검사도 적용하지만, 다음 이벤트를 자동 허용하지 않는다. hook 전용 웹 UI는 이번만 승인·거부만 제공한다.
- 기본 timeout은 기존 `shell::DEFAULT_TIMEOUT_MS`인 120000ms다. 기존 이벤트에 대한 직접 tool request는 100~120000ms를 지정할 수 있으며 승인 후 바뀌지 않는다. 실행 설정 키·정의는 변경하지 않았다. 승인 대기 TTL은 기존 서버 setting을 읽고 미설정 fallback은 1800초다.
- `tools::shell::command`와 `procs::{prepare,adopt,Owned,reap_leftovers}`를 재사용한다. 환경은 `env_clear` 후 고정 PATH(`/usr/bin:/bin`), LANG(`C.UTF-8`), 소유 call ID·hook event·session·matcher 표식만 넣는다. host HOME·TMPDIR·BASH_ENV/ENV·자격증명·서버 설정을 상속하지 않는다.
- 프로세스 소유 표식은 영속 tool call ID다. timeout·명시적 취소·서버 종료 및 실행 future 정리 시 소유 그룹/표식 자손을 회수한다. stdout/stderr를 실행 중 함께 drain해 큰 출력의 pipe 교착을 막는다. 브라우저 연결 종료를 취소 신호로 사용하지 않는다.
- stdout/stderr는 각각 4096바이트만 보관하고 전체 바이트 수·truncated를 제공한다. 기존 hook command의 보수적 sensitive 판별을 출력에도 적용하며, command가 민감하면 출력 전체를 가린다. nonzero exit·timeout·cancelled·출력 회수 실패를 성공으로 바꾸지 않는다.
- 재시작 때 running hook의 소유 표식 프로세스를 회수하고 기존 runner가 running을 `unknown`, 실행 전 approved를 cancelled로 확정한다. 기존 unknown 관찰·검토 API를 그대로 사용하며, 미검토 unknown 동안 새 hook 실행을 막는다. 검토 후에도 같은 event·hook 쌍을 재실행하지 않는다.
- hook executor 자체의 완료는 PostToolUse를 발화하지 않는다. 새 이벤트 입력용 HTTP endpoint나 untracked subprocess 실행 경로를 추가하지 않았다.

## 소유 변경·public 연결

| 경로 | 변경 |
|---|---|
| `src/hooks/mod.rs`, `src/hooks/execution.rs` | 지원 상태·이벤트 접수·계획·재검사·실행·회수·전용 조회 |
| `src/approvals.rs` | hook 계획 보강, 개별 승인 강제, 실행 전 정의 검사, executor dispatch, 자기 hook 재귀 제외 |
| `src/tools/mod.rs` | `hook` schema·Execute metadata·plan placeholder·unknown 관찰 안내 |
| `src/runner.rs`, `src/sessions.rs` | 위 표의 정확한 lifecycle 호출과 startup 회수 연결 |
| `src/store.rs` | 기존 migration 보존, 끝에 `hook_events`·`hook_runs` 독립 migration 추가 |
| `src/lib.rs` | `GET /api/v1/hooks/executions` 연결 |
| `tests/hook_execution.rs` | 실제 HTTP·격리 DB·로컬 프로세스 fixture integration 10개 |
| `web/app/api/hooks.ts` | 실행 상태·지원 이벤트 API 타입 |
| `web/app/components/hooks/HooksSettings.tsx`, `web/app/components/hooks/HooksSettings.test.ts` | 이벤트별 지원·미연결·독립 실행·matcher 안내, 전용 승인 화면 mount와 시험 |
| `web/app/components/hooks/HookExecutions.tsx`, `web/app/components/hooks/HookExecutions.test.ts` | 기존 ApprovalCard 재사용, 고정 계획·승인·거부·취소·결과·unknown 안내와 시험 |
| `web/e2e/hook-execution.spec.ts` | 실제 승인·거부·receipt·reload, 탭 종료 비취소·재연결 취소·자식 PID 회수, 승인 응답 transport abort 비반복의 브라우저 시나리오 3개 |
| `web/e2e/hooks.spec.ts` | 기존 4개 시나리오 보존. 활성 설정 label과 Stop row의 개별 승인 안내 기대만 현재 계약에 맞게 수정 |
| `work/RESULT-29.md` | 현재 인계로 교체 |

새 export: `hooks::{SUPPORTED_EVENTS, capture, plan_call, validate_call, execute_call, recover, executions}`. `capture`·`plan_call`은 기존 lifecycle/create_call transaction 안에서 호출하는 내부 연결 API다. `hook_runs.call_id` FK는 같은 transaction 안에서 tool call이 뒤이어 생성되도록 deferred 제약을 사용한다. 실행 기록은 설정 삭제로 지우지 않는다.

도구 입력은 `{hook_id,event_id,timeout_ms?}`이며 실제 접수된 해당 대화의 event ID가 필요하다. arbitrary command/cwd/env 입력은 받지 않는다. 생성 실패는 기존 create_call 계약대로 실행 없는 failed tool receipt로 남는다. `hook_already_planned`, `hook_not_applicable`, `hook_config_changed`, `hook_cwd_changed`, `hook_limits_changed`, `hook_shell_unsupported`, `unknown_pending_review` 등은 원인별 명시적 실패다.

기존 `GET /hooks`는 `supported_events`·`execution_note`를 추가하고 Linux에서 listing `execution_state: "partial"`을 반환한다. 개별 Hook은 지원 이벤트에만 `approval_required`, 미지원 이벤트에는 `not_implemented`를 반환한다. 기존 CRUD·revision·Owner 권한·원문 보존은 유지한다.

`GET /hooks/executions[?project_id=P]`는 Owner 전용이며 최근 hook tool call 최대 100개를 반환한다. project query가 없으면 모든 프로젝트다. 인증 없음 401, device 403이며 기존 scope 검사를 적용한다. private precondition은 응답하지 않는다.

웹 export는 기존 `HooksSettings({projectId?,projectName?})`와 신규 `HookExecutions({projectId?})`다. hook 설정의 아래쪽에서 기존 `ApprovalCard`에 명시적 Execute·이번만 승인/거부 props를 주입한다. 실행 결정·취소·상태 조회는 기존 tool-calls API, unknown 관찰·검토는 기존 대화 카드에서 수행한다. 현재 공통 대화 승인 whitelist에 hook을 추가하지 않았으므로 **승인은 hook 설정 화면에서** 한다. 도구 이벤트의 기존 recovery invalidation을 재사용하며 공통 store는 변경하지 않았다.

## 실제 검증

아래 첫 표는 `538fc995`까지의 유효한 기존 근거다. 이번 브라우저 후속에서는 제품 Rust·웹 코드, 해당 Rust·Vitest 시험, dependency·lockfile을 변경하지 않아 이를 재사용했다. 변경 입력은 정확히 두 E2E spec과 이 RESULT뿐이다. 동일 입력의 기존 Rust·Vitest 검사는 재실행하지 않았다.

모든 검사는 `source /data/project/paseodog_opus/.envrc.dev` 후 실행했다. Rust 명령은 `flock /home/ubuntu/.cache/grove-rust-check.lock`으로 감쌌다. worktree의 build.py가 `.dev`를 기준으로 환경을 설정하므로 `.dev`를 `/data/project/paseodog_opus/.dev`에 symlink했고, `web/node_modules`도 COMMON대로 메인 것을 symlink했다. 이번 후속에서도 이 공용 환경을 그대로 사용했다. 설치·복사·dependency 변경은 없으며 두 링크는 ignore 대상이다.

| 실제 명령 | 결과·유효 범위 |
|---|---|
| `python3 scripts/build.py test --rust hook_execution hooks turns shared_resources recovery mcp_connect` | exit 0. 초기 hook 8, hooks CRUD 5, turns 38, shared_resources 6, recovery 6, mcp_connect 23 통과. wall 153.62s / CPU 260.98s. 일반 승인·정책·복구·MCP 경계 회귀에 사용 |
| `python3 scripts/build.py test --typecheck --vitest app/components/hooks/HooksSettings.test.ts app/components/approvals/ApprovalCard.test.ts` | exit 0. 초기 hook 설정 6·기존 ApprovalCard 12. typecheck wall 10.43s / CPU 12.33s, Vitest wall 1.22s / CPU 2.64s. 이후 hook UI 검사는 아래 최종 검사로 대체; ApprovalCard 12개 근거 재사용 |
| `python3 scripts/build.py test --rust hook_execution hooks` | exit 0. 조회 route·최종 executor가 컴파일된 상태에서 hook 9·CRUD 5 통과. wall 56.65s / CPU 57.31s |
| `python3 scripts/build.py test --typecheck --vitest app/components/hooks/HooksSettings.test.ts app/components/hooks/HookExecutions.test.ts` | 동일 명령 두 번 모두 exit 0. 마지막 UI 안내까지 설정 6·실행 UI 3 통과. 마지막 typecheck wall 21.26s / CPU 11.44s, Vitest wall 1.62s / CPU 2.46s |
| `python3 scripts/build.py test --rust hook_execution` | exit 0. 마지막 시험 보강까지 포함한 integration 10개. wall 16.46s / CPU 8.94s |
| `git diff --check` | 통과. 동작 검증이 아닌 공백 검사 |

최종 integration은 지원 lifecycle 실제 실행, 저장/allow만으로 미실행, scope/glob·disabled 분리, prompt/decision 동일 키 재전송, command·matcher·revision·scope·cwd·limits 변경 차단, deny/read_only, guard 대기 중 config·grant 철회, 자식 PID 정리, timeout·nonzero exit, 출력 상한·가림·영속 기록 비밀 비노출, Owner 조회, bash·sh 환경 격리를 검증했다. 자원 한도는 fixture shell의 실제 `ulimit` 값으로 512MiB·CPU 2초 적용을 확인했다.

재시작 시험은 running receipt를 격리 DB에 준비하고 그 call ID 표식을 가진 실제 로컬 프로세스를 띄운 뒤 서버를 재시작한다. 회수·unknown 유지·관찰/검토 후에도 같은 이벤트의 비반복을 확인했다. 서버 프로세스 자체를 SIGKILL한 end-to-end crash 시험을 실행했다는 뜻은 아니다. 이 Rust 재전송 시험과 별개로, 이번 후속의 실제 브라우저 transport-abort는 아래처럼 검증했다.

실패한 검사·미해결 compile/type 오류는 없다. fixture의 timeout·cancelled·nonzero exit는 기대한 제품 결과이며 검사 실패가 아니다. 추가 route·지원 셸 검사는 최종 hook 검사로 검증했고, 이후 일반 승인/MCP/turn 경로에는 변경이 없어 위 회귀 근거를 재사용한다.

### 이번 브라우저 후속의 새 근거

실행 명령:

```bash
source /data/project/paseodog_opus/.envrc.dev
CARGO_TARGET_DIR=/data/project/paseodog_opus/target flock /home/ubuntu/.cache/grove-rust-check.lock python3 scripts/build.py test --e2e e2e/hooks.spec.ts e2e/hook-execution.spec.ts
python3 scripts/build.py test --typecheck
```

E2E는 공용 target과 기존 고정 포트를 유지하고 debug 서버·웹 빌드부터 브라우저 종료까지 전체 명령에 잠금을 적용했다. 실행기가 산출한 해당 worktree의 debug 바이너리와 정적 웹을 실제 Chrome에서 사용했다. 기존 서버나 다른 검사를 중단하지 않았고 branch 동기화·dependency 설치·런타임 설정 변경을 하지 않았다.

| 단계 | 결과 | 실행기 wall / CPU |
|---|---|---|
| server debug build | exit 0 | 68.81s / 80.79s |
| web build | exit 0 | 3.55s / 4.76s |
| 배정된 두 E2E spec | exit 0, desktop Chrome 7개 모두 통과 | 9.04s / 8.17s |
| spec 변경 후 typecheck | exit 0 | 7.26s / 11.53s |

`hook-execution.spec.ts`의 실제 관찰:

- 이벤트 접수 후 pending 상태와 부작용 파일 부재를 확인했다. 브라우저에서 고정 계획의 revision·환경·한도와 명령을 확인하고 이번만 승인한 뒤 실행 완료·정확한 stdout·단일 부작용을 확인했다. reload 후 같은 receipt만 복원하며 새 호출은 없었다. 두 번째 이벤트의 브라우저 거부는 추가 부작용을 만들지 않았다.
- 실제 fixture 자손 PID가 실행 중인 상태에서 브라우저 탭을 닫았다. 서버 receipt는 running이고 해당 PID도 살아 있었다. 같은 browser context의 새 탭으로 재접속해 실행 중 상태를 복원하고, UI의 명시적 취소로 cancelled receipt와 자손 PID 종료를 확인했다. reload 후에도 부작용은 한 번뿐이었다.
- 실제 승인 POST를 `route.fetch()`로 서버에 전달한 뒤 `route.abort("connectionfailed")`로 브라우저 응답을 유실시켰다. HTTP 오류 응답으로 대체하지 않았다. UI 상태 확인·reload는 running receipt를 복원했으며 새 승인 버튼이나 자동 POST 재전송이 없었다. 승인 POST는 정확히 1회, event의 tool call도 1개, 실제 부작용도 1회였다. 마지막에는 브라우저 취소와 자손 회수를 확인했다.

기존 `hooks.spec.ts`의 CRUD·명령 가림·revision 충돌 초안 보존·범위/기기 권한·설정 저장 응답 transport abort 후 동일 키 확인 4개도 모두 통과했다. 기존 시나리오는 유지하고 바뀐 label과 지원 Stop 이벤트의 상태 기대만 고쳤다.

각 실행 시험은 `mkdtemp`로 할당한 독립 프로젝트·fixture 파일을 사용하고, 자기 hook의 활성 호출 종료를 확인한 뒤에만 그 fixture 디렉터리를 회수한다. 임의 sleep/retry로 성공을 만들지 않고 ready 파일·receipt·PID·UI 상태를 관찰했다.

검사 실패·취소·중단·외부 blocker는 없었다. 웹 build의 기존 500kB chunk 경고와 React Router future-flag 안내는 남아 있으며 이 범위와 무관한 코드를 수정하지 않았다. 전체 회귀·release·패키징·다른 플랫폼 및 미지원 이벤트 E2E는 실행하지 않았고 통과를 주장하지 않는다.

## RESOURCE-016 남은 요구·위험·통합

- 지원한 네 이벤트의 독립 승인 실행과 계획 고정·현재 정책/정의 재검사·timeout·취소·환경/프로세스 격리·receipt/unknown 비반복은 위 시험으로 확인했다. 모든 이벤트·모든 발생 경로의 구현 완료나 `RESOURCE-016` 전체 체크 근거는 아니다.
- PreToolUse 차단 계약, SessionEnd 의미, 위 표 밖 emitter, Linux 외 플랫폼·bash/sh 외 셸은 미지원이며 API/UI/이 인계에 명시했다. hook은 원래 턴의 차단·취소 종속 작업이 아니다.
- 환경 격리는 filesystem/container/network sandbox가 아니다. 승인한 임의 셸 명령의 파일·외부 시스템 접근 자체를 금지하지 않는다. sensitive 판별은 기존 보수적 heuristic이므로 표식 없는 임의 비밀값의 완벽한 탐지를 보장하지 않는다. 원문은 기존 hook 설정 및 private 계획 DB에 보관된다.
- 소유 프로세스 회수는 기존 procs의 플랫폼·표식 경계를 따른다. 그룹을 벗어나면서 소유 환경 표식까지 지운 자손에 대한 완전한 회수는 보장하지 않는다.
- 후속 배정으로 기존 `web/e2e/hooks.spec.ts`의 영향 기대 수정과 두 정확한 spec의 브라우저 인수까지 직접 끝냈다. 이를 통합 담당의 실행 가능한 잔여로 넘기지 않는다. 소유 제품 코드의 추가 결함 수정은 필요하지 않았다.
- 통합 시 새 migration을 끝에 유지하고 hook route·registry·lifecycle·approvals 연결 및 기존 공통 계약을 보존해야 한다. 배정된 두 E2E는 위 입력에서 통과했으므로 변경되지 않은 입력의 중복 실행을 요구하지 않는다. 미지원 emitter/이벤트를 TODO 완료로 체크하지 않는다.

feature 24 실행 설정 정의, feature 23 disconnect/terminal, microphone/STT, dependency·lockfile·TODO는 수정하지 않았다. 실제 사용자 hook·서비스·외부 네트워크 효과는 실행하지 않았으며 시험은 임시 디렉터리·격리 DB·loopback fixture만 사용했다. 다른 세션 접촉·위임·main 편집·merge·push·배포·workspace 삭제도 하지 않았다.
