# b02 / 31 — SETTINGS-011 기본 실행 cwd 연결

<!-- grove-handoff:v1
{"state":"ready","remaining":[],"blockers":[],"integration_checks":["통합 브랜치에서 일반 shell 계획과 29의 hook 전용 계획·재검사·실행 경계 보존 인수","Windows/macOS 실행·경계·복구 실측은 해당 OS 호스트에서 별도 인수"]}
-->

## 상태·기준

배정 범위 구현·연결·Linux 브라우저 인수 종료. 소유 범위의 실행 가능한 잔여와 blocker는 없다.
Rust 42개·Vitest 3개의 기존 근거를 보존했고, 후속 배정된 정확한 E2E 4개 spec의 14개 시험과 변경 후 typecheck도 통과했다.
SETTINGS-011 전체 플랫폼 완료나 Windows/macOS 실측을 주장하지 않는다.

- Worktree: `/home/ubuntu/.local/share/paseodog/paseo/worktrees/0q796rug/b02-31-exec-cwd`
- Branch: `parallel/b02-exec-cwd`
- 공통 기준 SHA: `9942629c17891c5cad8cc5a7a62fee99e0379650`
- 초기 구현 commit `642d5bb15530fbab79ef80f40b43542a22cd5c71`에서 후속 작업을 시작했다. `/data/project/paseodog_opus/work/31.md`의 `442e020` 후속 배정과 live 원본 COMMON을 실제 읽었다. 브랜치 동기화·기준 변경 없이 진행했다.
- `/data/project/paseodog_opus/work/ENTRY.md`, `COMMON.md`, `31.md`, README 배정 행과 실제 top-level·branch·시작 HEAD가 일치했다. 시작 상태는 clean이었다.
- main·TODO·의존성·terminal·hook·외부 CLI 정책·승인 상태 전이를 수정하지 않았다. 29 소유 hook 분기는 변경하지 않았다.
- 다른 세션 접촉·위임·merge·push·배포·workspace 정리는 하지 않았다. TTS/playback·microphone 차단 및 STT 관련 코드는 변경하지 않았다.

## 제공 동작·소유 변경

| 파일 | 변경 |
|---|---|
| `src/approvals.rs` | `create_call`의 일반 shell 계획에서 cwd가 생략된 경우만 기존 resolver를 호출하고 canonical 경로를 실행 root 기준 상대 경로로 target에 고정한다. 원래 args는 보존한다. |
| `src/tasks.rs` | `start`가 최초 계획 때 실제 session 실행 root에서 명시 cwd 또는 상속 기본값을 해석한다. 이후 lease 획득 뒤 경계·디렉터리 재검사와 spawn에는 고정된 상대 경로를 사용한다. |
| `src/project_scripts.rs` | `run`이 전달하는 `StartBody.cwd`를 `Some(".")`로 고정하여 확인 화면·fingerprint가 확인한 root 실행을 보존한다. |
| `src/settings.rs` | `exec.default_cwd`의 미연결 설명을 실제 적용 대상·우선순위·제외 대상으로 바꾼다. resolver API와 검증 규칙은 그대로 재사용한다. |
| `web/app/components/exec-settings/ExecSettings.tsx` | 기본 cwd 적용, 명시 cwd 우선, worktree 실행 root 및 script·terminal·hook·외부 CLI 예외를 안내한다. |
| `web/app/components/TasksPanel.tsx` | 입력 안내를 기본 cwd 상속으로 수정하고 각 작업에 서버가 기록한 실제 상대 cwd를 표시한다. 같은 요청 재확인 동작은 변경하지 않는다. |
| `web/app/components/exec-settings/ExecSettings.test.ts` | 기존 미연결 기대값을 실제 적용 계약으로 교체한다. |
| `web/e2e/exec-settings.spec.ts` | 기존 미연결 문구 기대값만 수정한다. |
| `tests/exec_cwd.rs` | 실제 Linux 셸을 쓰는 통합 시험 8개를 추가한다. |
| `web/e2e/exec-cwd.spec.ts` | 설정 화면·모델 foreground/background의 계획 고정 및 실제 transport abort 뒤 작업 재확인·cwd 표시 시나리오 2개. 후속 인수에서 background의 첫 final 보류를 관측한 뒤 작업 해제·완료 응답을 공급하도록 fixture 경합을 제거했고 브라우저 통과했다. |
| `work/RESULT-31.md` | 이 인계다. |

`tests/exec_settings.rs`는 수정하지 않고 기존 resolver·범위 상속·shell/limits 회귀를 실행했다.

## Public 계약·기존 경계

새 export·props·라우트·스키마·dependency는 없다.
기존 `settings::execution_cwd(c, root, project, session, explicit) -> ApiResult<PathBuf>`를 production 계획 경로에서 사용한다.

- 명시 cwd(`.` 포함)는 기존 경계·디렉터리 검사를 유지하며 상속 기본값보다 우선한다. 생략된 cwd만 대화·프로젝트·서버·제품 기본값 순으로 해석한다.
- 기준 root는 기존 호출자가 `sessions::exec_root`로 확정한 프로젝트 또는 활성 worktree다. 다른 root로 조용히 fallback하지 않는다.
- 모델 shell은 최초 target에 cwd를 고정한다. 승인 대기 중 설정을 바꿔도 기존 호출은 바뀌지 않고 다음 계획에만 적용된다.
- 직접 작업은 초기 receipt 조회를 cwd 해석보다 먼저 수행한다. 원래 요청 본문의 idempotency hash를 유지하며 고정한 Spawn·작업 기록으로 실행한다. 같은 키의 저장된 성공·result_unknown 응답은 설정을 다시 적용하거나 새 프로세스를 실행하지 않는다.
- cwd 계획 실패는 shell의 기존 failed 기록 경로와 직접 작업의 기존 400 응답을 사용한다. 실행 직전 resolve·디렉터리 검사, 프로젝트 root 변경 거부, 인증 재검사, 프로젝트 lease, deny/read_only 재검사, receipt와 unknown 복구 경로는 교체하지 않았다.
- 프로젝트 script 실행은 명시 `.`로 기존 확인 대상 root를 유지한다. fingerprint·revision·owner 검증은 그대로다.
- terminal·hook·독립 `grove exec` CLI에는 기본 cwd를 적용하지 않는다.

공통 파일의 추가 등록·mount는 필요 없다. 일반 shell 계획 연결만 통합하며 29의 hook 전용 계획·재검사·실행 코드는 보존해야 한다.

## 초기 구현 검증 근거 (`642d5bb`)

명령은 위 worktree에서 실행했다.
기존 메인 환경을 가리키는 Git ignore symlink `.dev`, `web/node_modules`를 만들었고 툴체인·node_modules를 설치하거나 복사하지 않았다.
모든 실행 검사에서 유료 모델·실제 사용자 데이터 대신 격리 임시 프로젝트·DB와 로컬 fixture provider를 사용했다.

| 실제 명령 | 결과 |
|---|---|
| `source /data/project/paseodog_opus/.envrc.dev && flock /home/ubuntu/.cache/grove-rust-check.lock python3 scripts/build.py test --rust exec_cwd --filter inherited_and_explicit_cwd_reaches_shell_and_direct_tasks` | 구현 전 red 확인. 1개 실패: 실제 cwd `.`와 기대한 session 기본값 불일치. 컴파일 성공. |
| `source /data/project/paseodog_opus/.envrc.dev && flock /home/ubuntu/.cache/grove-rust-check.lock python3 scripts/build.py test --rust exec_cwd exec_settings tasks project_scripts worktrees settings` | 구현 후 새 시험 6개 통과, 2개 실패. 새 시험이 오류를 `result.code`로 읽은 잘못된 기대값 때문이었다. 기존 계약은 `result.error.code`다. 뒤 integration target들은 실행되지 않았다. |
| `source /data/project/paseodog_opus/.envrc.dev && flock /home/ubuntu/.cache/grove-rust-check.lock python3 scripts/build.py test --rust exec_cwd --filter invalid_defaults_and_post_plan_symlink_escape_never_execute_outside_root` | 기대값 수정 뒤 1개 통과. |
| `source /data/project/paseodog_opus/.envrc.dev && flock /home/ubuntu/.cache/grove-rust-check.lock python3 scripts/build.py test --rust exec_cwd --filter cwd_defaults_do_not_bypass_deny_or_read_only_rechecks` | 기대값 수정 뒤 1개 통과. 위 두 명령은 같은 shell의 순차 실행이었다. |
| `source /data/project/paseodog_opus/.envrc.dev && flock /home/ubuntu/.cache/grove-rust-check.lock python3 scripts/build.py test --rust exec_settings tasks project_scripts worktrees settings shared_resources` | 위 두 focused 검사 뒤 순차 시도했으나 공용 Rust 잠금 대기에서 shell 전체의 600초 제한으로 timeout(exit 124). 이 묶음은 그 시도에서 미실행이었다. 앞 두 focused 통과는 유지했다. |
| `source /data/project/paseodog_opus/.envrc.dev && flock -w 120 /home/ubuntu/.cache/grove-rust-check.lock python3 scripts/build.py test --rust exec_settings tasks project_scripts worktrees settings shared_resources` | 잠금 보유를 확인한 뒤 대기 한도를 둔 단 한 번의 재시도. 컴파일 및 34개 통과: exec_settings 4, tasks 8, project_scripts 6, worktrees 5, settings 5, shared_resources 6. |
| `source /data/project/paseodog_opus/.envrc.dev && python3 scripts/build.py test --vitest app/components/exec-settings/ExecSettings.test.ts --typecheck` | Vitest 3개와 typecheck 통과. 새 E2E 파일도 타입 검사 입력에 포함됐다. |
| `git diff --check` | 통과. |

최종 유효 근거는 서로 다른 Rust 시험 42개(새 시험 6개 최초 통과 + 수정한 2개 focused 통과 + 기존 34개), Vitest 3개 및 typecheck다.
새 시험 8개 전체를 한 번에 모두 green으로 재실행했다고 주장하지 않는다.
실패한 assertion 외 나머지 6개 시험 및 production 입력은 바뀌지 않아 통과 근거를 재사용했다.

초기 실행기가 제공한 시간은 아래와 같다. 잠금 대기를 포함한 전체 소요나 절감량으로 환산하지 않는다.

| 검사 단계 | wall / CPU (초) |
|---|---|
| 구현 전 red | 127.7 / 206.29 |
| 구현 후 새 시험 6통과·2실패 | 71.35 / 61.27 |
| 경계 focused 통과 | 16.57 / 3.51 |
| 정책 focused 통과 | 18.49 / 0.61 |
| 기존 Rust 34개 통과 | 26.6 / 19.74 |
| 초기 typecheck | 17.24 / 12.17 |
| 초기 Vitest 3개 통과 | 1.92 / 2.35 |

## 후속 브라우저 인수

후속 변경은 `web/e2e/exec-cwd.spec.ts`와 이 RESULT뿐이다.
production Rust·웹 컴포넌트·Rust 시험·Vitest 입력은 초기 commit 이후 그대로여서 유효한 Rust 42개·Vitest 3개를 재실행하지 않았다.
기존 typecheck 근거를 보존하되 수정한 E2E 입력을 포함한 typecheck는 다시 실행했다.
추가 소유된 `web/e2e/task-start.spec.ts`, `web/e2e/project-scripts.spec.ts`와 기존 `web/e2e/exec-settings.spec.ts`는 후속 인수에서 수정 없이 통과했다.

정확한 E2E 명령은 두 시도 모두 다음과 같다. 공용 잠금이 서버·웹 빌드부터 브라우저 종료까지 전체 명령을 감쌌다.

```bash
source /data/project/paseodog_opus/.envrc.dev && flock /home/ubuntu/.cache/grove-rust-check.lock python3 scripts/build.py test --e2e e2e/exec-cwd.spec.ts e2e/exec-settings.spec.ts e2e/task-start.spec.ts e2e/project-scripts.spec.ts
```

| 시도·단계 | 결과 | wall / CPU (초) |
|---|---|---|
| 첫 시도 server debug build | 통과 | 75.91 / 79.58 |
| 첫 시도 web build | 통과 | 6.91 / 4.88 |
| 첫 시도 E2E | 첫 exec-cwd 시험에서 turn.status가 `completed` 대신 `failed`여서 1실패·13미실행, exit 1 | 6.91 / 4.02 |
| fixture 수정 후 server debug build | 통과 | 3.73 / 0.32 |
| fixture 수정 후 web build | 통과 | 3.27 / 4.87 |
| fixture 수정 후 E2E | 14개 전부 통과, exit 0 | 17.08 / 17.06 |
| `source /data/project/paseodog_opus/.envrc.dev && python3 scripts/build.py test --typecheck` | 수정한 E2E 포함 통과, exit 0 | 8.77 / 11.28 |

첫 fixture는 background 작업 결과 반영에 따른 final 보류·추가 모델 응답 경계를 다루지 않고 완료 status만 기다렸다.
수정 후에는 fixture 작업을 해제 표식으로 유지하고 API에서 첫 final이 보류된 상태를 확인한 뒤 완료 응답과 표식을 공급한다.
임의 지연·재시도 횟수 증가·제품의 완료 조건 완화로 우회하지 않았다. 이후 assertion은 status뿐 아니라 턴 본문도 실패 진단에 남긴다.
첫 실패는 보존하며 provider 오류 payload 자체를 기록했다고 주장하지 않는다.

| spec | 최종 통과·확인 동작 |
|---|---|
| `web/e2e/exec-cwd.spec.ts` | 2개. 프로젝트 기본 cwd를 상속한 실제 foreground/background 출력, 승인 후 설정 변경에도 target·cwd 불변, 명시 `.` root 실행. 서버 접수 후 실제 `connectionreset`을 발생시키고 설정을 바꿔도 같은 키·단일 작업·한 번의 파일 쓰기·기록된 cwd 표시 유지. |
| `web/e2e/exec-settings.spec.ts` | 3개. 화면 저장·경계 거부·범위 상속·복원, 미지원 선택지 안내, 승인 전후 shell/limits 고정과 다음 계획 적용. |
| `web/e2e/task-start.spec.ts` | 3개. 서버 도착 전·처리 후 응답 유실, 최종 receipt 실패의 result_unknown, 같은 키 확인·중복 방지·다음 명령 선택. |
| `web/e2e/project-scripts.spec.ts` | 6개. script 확인·취소·작업·로그, setup 실패·재시도, session/task 응답 유실 뒤 새로고침 복구, stale 정의 거부, 편집 충돌 보존. |

실제 격리 debug 서버와 빌드된 웹, 설치된 Chrome 및 로컬 provider fixture를 사용했다.
최종 로그의 `sqlite: fixture final receipt failure`는 task-start가 의도적으로 주입한 최종 receipt 실패이며 해당 복구 시험은 통과했다.
웹 빌드의 500 kB chunk 경고와 React Router future-flag 안내는 기존 경고로 남겼고 관련 없는 코드를 변경하지 않았다.
새 설치·다른 검사 중단·포트 변경·공유 target 변경·타 worktree 동기화는 하지 않았다.

## SETTINGS-011 요구별 근거·남은 범위

| 요구 | 근거·상태 |
|---|---|
| 기본 cwd의 실제 foreground/background·직접 작업 실행 | 실제 `pwd -P`를 독립적으로 계산한 canonical fixture 경로와 비교했다. 모델 foreground·hold·background, 직접 작업에 적용된다. |
| 명시 cwd 우선·범위 상속 | `.`·다른 명시 상대 경로, session→project→server→제품 기본값 복원 후 실제 셸과 작업 출력을 확인했다. |
| 승인 뒤 설정 변경 | 모델의 세 실행 모드에서 최초 target·원래 args 보존과 실제 cwd 불변, 다음 계획의 새 cwd 적용을 확인했다. |
| worktree·경계 | 실제 관리 worktree에서 상대 cwd를 실행했고 원본 프로젝트에 marker가 생기지 않음을 확인했다. worktree에 없는 상속 경로, 없는 디렉터리·일반 파일·탈출 경로와 설정 저장 뒤 symlink 교체를 거부했다. 승인 후 바깥 symlink 교체도 실행 직전 거부했다. |
| 권한·공유 자원 | deny/read_only 계획·승인 재검사 시험 통과. 기존 shared_resources 6개에서 프로젝트 간 lease·대기 취소·대기 중 권한 폐기 재검사 회귀 통과. |
| 응답 유실·멱등성·unknown | 직접 작업의 접수 응답 본문을 소비하지 않은 뒤 기본 cwd를 변경·무효화해도 같은 키가 기존 cwd·하나의 작업·한 번의 marker 쓰기를 유지했다. 최종 receipt UPDATE 실패 주입 후 result_unknown replay와 재시작의 고정 cwd·unknown 상태를 확인했다. 새 시험의 crash 복구 입력은 완료한 격리 fixture 기록을 running으로 돌려 구성했으며 실제 서버 강제 crash로 보고하지 않는다. 기존 tasks의 잔여 프로세스 정리·재시작 시험도 통과했다. |
| 프로젝트 script root 보존 | session 기본값을 root 하위 디렉터리로 둬도 확인한 script는 `.`에서 실행하고 설정 변경 뒤 같은 키 replay도 기존 작업을 반환했다. 기존 script 확인·오류·인증·setup 회귀 6개도 통과했다. |
| 웹 안내·실제 cwd 표시 | ExecSettings 단위 시험과 변경 후 typecheck 통과. 실제 브라우저 설정 저장·경계 거부·모델 실행·TasksPanel cwd 표시와 연결 reset 뒤 같은 키 복구까지 배정된 14개 E2E로 통과했다. |

## 환경 제약·다음 통합 단계

- 후속 배정한 정확한 선택 E2E는 모두 끝났다. 실행 가능한 소유 잔여는 없다. 전체 회귀·release·패키징은 배정 범위가 아니어서 실행하지 않았다.
- 실제 외부 미검증: Windows/macOS 빌드·셸 실행·경계·복구 실측. 현재 검증 호스트·Chrome·셸 실행은 Linux이며 해당 OS의 실제 런타임 근거가 없다. 해제 조건은 Windows/macOS 호스트에서 같은 계약의 실제 실행·경계·복구 인수 근거를 확보하는 것이다. Linux 소유 흐름의 blocker로 분류하지 않는다.
- 공통 통합 인수는 통합 브랜치에서 29의 hook 전용 분기를 보존하면서 일반 shell 계획과 함께 동작하는 경계 확인이다. 별도 구현을 통합 담당에게 넘기지 않는다.
- SETTINGS-011 전체 플랫폼 완료 여부와 TODO 반영은 통합 담당이 판정한다. 이 worktree에서는 TODO를 변경하지 않았다.
- 로컬 task-only commit에 코드·시험·이 RESULT를 함께 포함한다. RESULT 자체를 포함한 commit SHA는 이 문서에 쓰지 않는다.
