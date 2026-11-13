# b02 / 31 — SETTINGS-011 기본 실행 cwd 연결

## 상태·기준

배정 범위 구현 종료. Linux 선택 회귀 통과, 브라우저 인수·타 플랫폼 실측은 통합 대기다.
구현 blocker는 없다. SETTINGS-011 전체 완료나 Windows/macOS 동작 검증을 주장하지 않는다.

- Worktree: `/home/ubuntu/.local/share/paseodog/paseo/worktrees/0q796rug/b02-31-exec-cwd`
- Branch: `parallel/b02-exec-cwd`
- 공통 기준 SHA: `9942629c17891c5cad8cc5a7a62fee99e0379650`
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
| `web/e2e/exec-cwd.spec.ts` | 설정 화면·모델 foreground/background의 계획 고정 및 실제 transport abort 뒤 작업 재확인·cwd 표시 시나리오 2개를 작성한다. 실행은 통합 대기다. |
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

## 검증 근거

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
| 웹 안내·실제 cwd 표시 | ExecSettings 단위 시험과 전체 typecheck 통과. 실제 브라우저 저장·표시 및 네트워크 연결 reset 시나리오는 작성했지만 미실행이다. |

## 환경 제약·다음 통합 단계

- COMMON에 따라 E2E·전체 회귀·release·패키징은 실행하지 않았다. 고정 포트 공유 검사도 시작하지 않았다.
- Windows/macOS 빌드·셸 실행·경계·복구 실측은 미검증이다. 새 실제 실행 통합 시험은 Unix 대상이며 이번 실행 호스트는 Linux다.
- `web/e2e/exec-cwd.spec.ts`, `web/e2e/exec-settings.spec.ts`, `web/e2e/task-start.spec.ts`, `web/e2e/project-scripts.spec.ts`를 포트 독점 통합 환경에서 선택 실행해야 한다. 특히 실제 transport abort 뒤 같은 키 확인과 TasksPanel 표시 인수는 남아 있다.
- SETTINGS-011 전체 완료 여부와 TODO 반영은 브라우저·플랫폼별 필요한 인수를 확인한 통합 담당이 판정한다. 이 worktree에서는 TODO를 변경하지 않았다.
- 로컬 task-only commit에 코드·시험·이 RESULT를 함께 포함한다. RESULT 자체를 포함한 commit SHA는 이 문서에 쓰지 않는다.
