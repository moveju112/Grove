# 46 — 실행 중 unknown 결과와 재실행 없는 조회

<!-- grove-handoff:v1
{"state":"ready","remaining":[],"blockers":[],"integration_checks":[]}
-->

## 범위와 상태

- 배치/번호: b02 / 46, ONCE-008의 남은 실제 단발 CLI unknown 도구 결과 경로.
- worktree: `<세션 worktree 루트>/b02-46-exec-unknown`
- branch: `parallel/b02-exec-unknown`
- 고정 기준 및 시작 HEAD: `7d5a6e57776f5770162b577dc4e372a2d67ae3e3`
- ENTRY/COMMON/46 정본과 README의 경로·branch 일치, 시작 시 clean 확인.
- 상태: 소유 범위 구현·실제 CLI 연결·선택 검증 완료. blocker 및 실행 가능한 잔여 없음.
- 변경: `tests/exec_unknown.rs`, `work/RESULT-46.md`만 추가.
- `src/exec.rs`의 기존 unknown 분류·출력·show가 실제 응답 유실에서도 계약대로 동작해 제품 수정은 필요하지 않았다. `tests/exec.rs`와 공통 fixture는 변경 없이 회귀 입력으로 재사용했다.
- TODO·runner·approvals·provider·shell·budget·CLI parsing·UI·schema·dependency 변경 없음. merge/push/배포/다른 checkout 편집 없음.

## 실제 사용자 경로와 요구 충족

`lost_in_flight_tool_response_is_unknown_and_retained_results_never_reexecute`는 Cargo가 자동 등록한 integration target에서 실제 `CARGO_BIN_EXE_grove exec` 프로세스를 실행한다. 새 모듈 등록이나 제품 연결 변경은 없다.

1. 소유 임시 project/run과 loopback 모델·MCP 서버만 사용한다. 첫 모델 응답을 gate로 보류하고 CLI 프로세스가 소유한 Linux `/proc/<pid>/fd`의 socket inode에 해당하는 loopback listener만 식별한다. 자기 run의 `owner-token`으로 해당 서버의 공개 MCP 등록·check API를 사용하며 DB seed나 승인 우회는 하지 않는다.
2. 모델이 `mcp_tools`로 목록을 조회하고, 명시적 `--allow-tool mcp_call` 정책에 따라 `exec-fixture/mark`를 호출한다. 연결 check가 도구를 호출하지 않은 것도 확인한다.
3. MCP fixture가 임시 프로젝트의 `effects.txt`에 `invoked\n`을 append·sync하고 호출 수를 올린다. 시험이 표식 1회, 실제 도구 `running`, 정책 승인 기록, 아직 receipt가 없음을 확인한 뒤 gate를 해제한다.
4. HTTP 오류/일반 도구 실패를 반환하지 않는다. HTTP 200의 미완성 JSON 응답 본문을 보내고 `ConnectionReset` body stream 오류로 실제 응답을 끊는다. 도구 확정 응답은 전달하지 않는다.
5. 모델 후속 응답이 정상 완료해 turn 자체는 `completed`여도 CLI는 도구 `unknown`을 우선해 `schema=grove.exec.v1`, `status=unknown`, `exit_code=7`, 실제 프로세스 종료 코드 `7`로 끝난다. `mcp_call`의 `approval_scope=policy`와 보존된 오류 `result_unknown`도 확인한다.
6. stdout은 단일 JSON이며 저장 `result.json`과 동일하다. 비어 있지 않은 run identity, 실제 `turn_id`, 보존 `run_dir`, 작업 DB를 확인한다. synthetic private canary를 prompt/API key/유실 응답에 넣고 stdout·stderr에서 원문과 도구/프로젝트 경로가 노출되지 않음을 확인한다. 개인 데이터 디렉터리는 생성하지 않는다.
7. `exec show`를 별도 프로세스로 3회 실행해 같은 receipt·run identity·코드 `7`을 확인한다. run 내부 모든 파일의 경로와 SHA-256 snapshot이 동일해 수정·삭제가 없음을 확인한다.
8. 같은 nonempty run 디렉터리에 원래 실행을 재제출하면 기존 코드 `2`로 거부되며 파일 snapshot도 유지된다.
9. 소유 run DB만 실제 서버 코어로 재시작해 공개 조회 API로 `unknown`, `result_unknown`, 정책 승인, 한 번의 종료 revision 전이, 원래 turn과 도구 2개를 확인한다. 도구 결과 3회 조회는 같은 기록을 반환한다. 서버를 정상 종료한 뒤 `exec show` 3회를 다시 실행해 불변 receipt와 파일 snapshot을 확인한다.
10. 최종 표식은 정확히 `invoked\n`, MCP 부작용 호출은 정확히 1회, 모델 호출은 원래 흐름의 3회뿐이다. 조회·재제출 거부·재시작은 도구/모델 재실행이나 자동 승인을 발생시키지 않는다.

ONCE-008의 미검증 실제 in-flight unknown 경로를 충족한다. ONCE-007/009/011의 identity·보존·가림·재조회 계약은 위 흐름에서 함께 회귀 확인했다. 숫자 코드 0..7과 `grove.exec.v1` 정의는 변경하지 않았다. ONCE-005 비용 상한이나 ONCE-010의 다른 플랫폼 확대는 범위 밖이다.

## 검증 근거

검사 명령:

```bash
source <원본 저장소>/.envrc.dev && export CARGO_TARGET_DIR=<원본 저장소>/target CARGO_BUILD_JOBS=2 && flock /home/ubuntu/.cache/grove-rust-check.lock python3 scripts/build.py test --rust exec_unknown exec
```

전체 명령은 COMMON의 공용 Rust 잠금 안에서 실행했다. 대기 중 잠금은 다른 실행이 보유하고 있음을 읽기 전용으로 확인했으며 우회·공유 프로세스 중단은 하지 않았다.

| 입력 | 결과 |
| --- | --- |
| `tests/exec_unknown.rs` | 신규 실제 CLI 시험 1개 통과 |
| `tests/exec.rs` | 기존 회귀 5개 통과, 1개 ignored |
| 컴파일 및 선택 검사 | exit 0, 경고 없음 |
| `git diff --check` | 통과 |

기존 회귀는 성공과 지침 제외, 입력/설정 오류, 승인 필요/허용 실행, SIGTERM 취소/닫힌 stdout의 receipt 보존, 강제 종료 후 unknown 재조회를 포함한다.

`time_budget_ends_with_timeout_code`는 원래 `#[ignore]`인 1분 시험이라 이번에도 실행하지 않았다. 이를 통과 수에 포함하지 않는다. 제품 시간 예산/timeout 분류는 변경하지 않았다. UI 없는 Rust/CLI 전용 변경이므로 Vitest·typecheck·브라우저 E2E·전체 회귀는 미선택이다. 신규 시험은 Linux `/proc` 전용으로 다른 OS의 검증 근거가 아니다.

실행기가 보고한 Rust 단계 수치: **144.1s wall / 211.7s CPU / 2221.5MB peak RSS / exit 0**. 공용 잠금 대기는 이 단계 수치와 별개이며 절감 시간은 추정하지 않는다.

실제 산출물:

- `/home/ubuntu/.cache/cargo-build/cf/9682fa7ce5ecfb/debug/deps/exec-2a0409804d680239`
- `/home/ubuntu/.cache/cargo-build/cf/9682fa7ce5ecfb/debug/deps/exec_unknown-b75cfb74b192b5d3`

원본 검사 로그:

- `<실행 로그>/shell_e8eb03a7.stdout`
- `<실행 로그>/shell_e8eb03a7.stderr`

검사 입력 SHA-256:

| 파일 | SHA-256 |
| --- | --- |
| `tests/exec_unknown.rs` | `2da2e232a5d2e19c4598534007cdad4b302ad1273fb048f00f631c64c51b8050` |
| `src/exec.rs` | `29ff56ac1594e69e101a8083579e19d0e1cb951b23ca5ce3a8ceeb5710a45696` |
| `tests/exec.rs` | `8fc3ec588a8beb782ece02404cff586f41f6a9387cf49aa5d383b108edb3d48d` |

통과 뒤 제품/시험 코드는 변경하지 않고 이 RESULT만 추가했다. 새로운 public export/props나 공통 파일의 연결·권한 변경 요청은 없다.

## 통합 인계

blocker 없음. 테스트의 실제 응답 유실·표식·호출 수 근거가 완료 판단 기준이다. 관련 입력이 유지되면 위 선택 검사 근거를 재사용할 수 있다. 통합 담당은 통합 후 ONCE-008의 TODO 반영 여부를 판단하면 된다. 기능 workspace에서는 TODO를 수정하지 않았다.
