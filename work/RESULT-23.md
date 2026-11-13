# b02 / 23 — PC-005 탭·창·브라우저 종료와 서버 작업 수명

## 식별·판정

- worktree: `/home/ubuntu/.local/share/paseodog/paseo/worktrees/0q796rug/b02-23-tab-close`
- branch: `parallel/b02-tab-close`
- 기준 SHA: `7b3949d24e420d09e6e4cde29405414b2d99253a`
- 시작 HEAD가 기준 SHA와 같았고 Git 상태가 깨끗했다. 원본 `work/ENTRY.md`, `work/README.md`의 23번 경로·브랜치 행, `work/COMMON.md`, `work/23.md`와 대조했다.
- **소유 작업 종료·선택 검증 통과·브라우저 E2E 통합 대기**다. `PC-005` 전체 인수 완료로 처리하면 안 된다.
- 확인한 서버 disconnect 경로에는 취소 결함이 없었다. 계약대로 제품 코드를 불필요하게 바꾸지 않고 실제 transport 회귀 시험을 추가했다.
- 다른 checkout·세션·공유 서비스는 조작하지 않았다. TODO·dependency·lockfile·공통 등록·runtime 설정은 변경하지 않았다. 마이크 녹음·음성 입력·STT는 구현하지 않았고 기존 마이크 차단·TTS도 변경하지 않았다.

## 연결 종료·취소 경로 전수 조사

`src`의 SSE·WebSocket·stream body 생성, closed/disconnect/close 처리, cancel registry 호출·cancel_turn·stop_all·프로세스 kill/drop 경로와 `web/app`, `web/public`의 unload/pagehide/sendBeacon·abort/close·취소 API 호출을 확인했다.
아래는 같은 원인을 공유하는 경로를 묶은 목록이다. 브라우저 연결과 서버가 외부 provider/MCP에 연결하는 transport는 구분했다.

| 경로·함수 | 종료·실패 시 영향 | PC-005 판정·근거 |
|---|---|---|
| `src/events.rs::stream`의 초기 hello/partial·영속 replay 송신 실패, `tx.closed()` | 해당 SSE 생산자·구독만 종료 | `runner`/도구/task 취소 신호를 보내지 않는다. 새 시험의 partial 복원·offline 완료·cursor replay 통과 |
| `src/events.rs::Partials::{set,clear}` | snapshot을 먼저 저장·제거하고 broadcast 송신 실패는 무시 | 관찰자가 없어도 모델 결과 경로를 실패시키지 않는다. observer 없는 모델 완료 통과 |
| `src/events.rs::stream`의 인증 만료·보존 범위 초과·shutdown | 관찰 연결 종료, 필요하면 기존 `resync`/`shutdown` 이벤트 | 인증·cursor 정책 유지. 제품 변경 없음. 새 시험은 유효 cursor replay를 검증하며 만료 cursor 분기를 새로 검증하지는 않았다 |
| `web/app/api/events.ts::EventStream`의 stop/setSessions/reader.cancel, `web/app/components/Workspace.tsx`의 effect cleanup | fetch·재접속 루프·구독만 종료 | 취소 API 호출 없음. 기존 최초 hello 재조회·cursor replay·resync 유지. 관련 Vitest 통과 |
| `src/terminals.rs::{ws,session}`의 hello/snapshot/출력 송신 실패·WS Close/EOF/오류·인증 만료 | WS 구독과 연결용 `Arc`만 해제 | registry·reader·waiter가 PTY를 소유한다. Close frame·갑작스러운 socket drop 후 동일 shell PID·offline 출력·재입력 검증 통과 |
| `src/terminals.rs::create`의 reader·종료 감시, `subscribe` | PTY 출력은 독립 thread에서 ring에 기록한 뒤 broadcast; 구독이 없어도 계속 읽음 | 복원 시 lock 안에서 snapshot+구독 획득. 기존 flood/lagged reset 시험과 새 무구독 PTY 시험 통과 |
| `web/app/components/TerminalView.tsx`의 effect cleanup·onclose·showSaved | browser WS만 닫고 재연결하거나 저장 화면 조회 | cleanup은 `/kill`을 호출하지 않는다. `/kill`은 명시적 종료 버튼에서만 호출 |
| `src/runner.rs::{create,kick_queued,spawn_drive,drive}` | 접수한 턴은 `tokio::spawn` 실행과 서버 cancel registry 소유 | SSE 연결과 분리. 모델 완료·partial 복원·foreground/background 도구 완료가 새 Rust 시험에서 통과 |
| `src/approvals.rs::spawn_execute`, `src/tools/shell.rs::{command,execute}` | 도구는 별도 실행 task 소유. 프로세스 kill/drop은 도구 완료·timeout·명시적 cancel 수명에 종속 | observer 종료와 무관. offline foreground 완료·재연결 후 턴 취소에 의한 실제 프로세스 종료 통과 |
| `src/tasks.rs::{start,launch,run_with_hold}`·`src/task_logs.rs` | task registry·독립 waiter·로그 pump 소유. hold 만료는 background 전환이며 종료 아님 | 모델 소유 background 작업의 무구독 완료·stdout/stderr·단일 결과 기록, 사용자 task의 reconnect 후 명시적 취소 통과 |
| `src/tasks.rs::{wait,output,list,show}`, `src/agents.rs::wait_run` | 조회·장기 대기는 실행 주체가 아님. wait 종료는 해당 관찰만 종료 | cancel registry 호출과 분리. task wait timeout·명시적 취소 구분은 기존 `tasks` 시험 통과 |
| `src/runner.rs::{cancel,cancel_turn,cancel_running_calls}`, `src/approvals.rs::cancel`, `src/tasks.rs::cancel`, `src/terminals.rs::kill`, `src/agents.rs::{cancel_run,cascade_cancel}`, `src/followups.rs`의 interrupt | 사용자 취소·종료·부모 취소·끼어들기는 기존 신호와 cascade 유지 | 새 시험에서 streaming 턴 `user_stop`, foreground 도구 중단, 사용자 task 취소, PTY `사용자가 종료함`·재접속 거부 확인. 기존 owned-work 취소 회귀 통과 |
| `src/provider/mod.rs::stream`, `src/provider/cli.rs`의 GroupGuard/kill_on_drop, `src/procs.rs::Owned`/Windows Job | 서버→provider 연결 실패나 서버 소유 실행 future 종료는 모델/프로세스 실패·정리 경계 | browser SSE와 별개. 취소·timeout 때의 프로세스 트리 정리를 제거하지 않았다. 실제 외부 provider·Windows 동작은 이번 실행으로 검증하지 않음 |
| `src/mcp/client.rs`의 Process/Http Drop·close, `src/mcp.rs`의 연결 확인, `src/mcp/execute.rs`의 도구 실행 | 서버→MCP 연결의 소유 리소스 정리. 연결 확인은 요청 내부 진단이며 모델 도구는 `spawn_execute` 소유 | browser WS/SSE 종료에서 호출하는 경로 없음. 외부 MCP transport 단절은 계속 기존 오류로 처리. MCP runtime 시험은 미선택 |
| `src/remote_watches.rs`·`src/schedules.rs`의 서버 background loop | 명시적 cancel/설정·서버 shutdown에 따라 종료 | 페이지의 수명과 분리. 별도 감시·예약 기능 변경이나 완료 주장은 없음 |
| `src/server.rs::Server::stop_within`·저장 복구 경로, `src/terminals.rs::stop_all/recover_on_start`, `src/tasks.rs::stop_all`, `src/runner.rs::cancel_all_for_shutdown` | 서버 자체 종료·저장 실패는 작업을 중지하고 복구 상태 기록 | browser 종료와 다른 필수 계약. 제거하지 않았다. 기존 task shutdown·crash 및 terminal restart 회귀 통과. 서버 재시작 뒤 실행 지속은 보장하지 않음 |
| `src/exec.rs::drive` | 비대화 CLI의 승인 필요·OS 종료 신호는 명시적으로 cancel API 호출 | browser 종료 hook이 아니다. CLI 종료 계약을 변경하지 않음 |
| `src/files.rs::stream_file`, `web/app/components/FilesView.tsx`의 beforeunload 및 기타 UI AbortController | 파일 전달 종료·미저장 편집 경고·조회 취소 | 서버 턴/task/PTY 취소와 연결되지 않음. unload/pagehide/sendBeacon에서 작업 취소를 보내는 제품 경로는 발견되지 않음 |

조사는 이미 서버가 접수·소유한 작업에 대한 것이다. 아직 접수되지 않은 입력 전송이나 응답 유실의 모든 타이밍을 이번 시험으로 보장하지 않는다.
기존 idempotency receipt와 재동기화를 교체하지 않았다.

## 소유 변경·계약

| 파일 | 제공 내용 |
|---|---|
| `tests/tab_close.rs` | 실제 HTTP SSE·WebSocket·bash·PTY·로컬 모델 fixture를 사용하는 Unix integration 시험 7개 |
| `web/e2e/tab-close.spec.ts` | 실제 탭·BrowserContext·시험 소유 browser 종료 각각에서 partial·명시적 취소, foreground/background 셸·PTY의 offline 완료와 복원을 다루는 E2E 9개 |
| `work/RESULT-23.md` | 조사 목록·검증·남은 인수 경계 |

새 public export/props·API·오류 형식·권한 변경·공통 파일 연결은 없다. Cargo의 integration target 자동 검색과 기존 Playwright 설정을 그대로 사용한다.
SSE는 인증된 `/api/v1/events?sessions=...`와 기존 `Last-Event-ID`를, PTY는 인증된 POST `/terminals/{id}/ticket`의 일회용 WS URL을 사용한다.
turn/task 생성·도구 승인에는 기존 idempotency와 revision 계약을 사용한다. `/turns/{id}/cancel`, `/tasks/{id}/cancel`, `/terminals/{id}/kill`의 인증·오류·명시적 종료 동작을 보존한다.

Rust 시험은 관찰 연결을 실제로 폐기한 뒤 gate를 해제해 모델·프로세스가 무관찰 상태에서 완료하게 한다.
재연결은 snapshot·영속 결과·순서 있는 replay를 읽고 실행 횟수 파일·모델 요청 수·shell PID로 재실행 부재를 확인한다.
시간 경과만으로 성공을 추정하지 않고 실제 partial·파일·작업 상태·출력을 기다린다.
foreground 도구 실행 중 턴 상태는 기존 계약대로 `awaiting_approval`, background 결과 대기 중에는 `running`이다.

E2E는 runner browser가 아닌 시험 소유 Chrome을 닫는다.
context/browser 재생성 시 실제 기기 저장소 역할의 `storageState`만 넘기며 서버 상태를 주입하지 않는다.
작업을 gate로 유지한 채 닫고 서버 상태를 조회한 뒤, 페이지가 없는 동안 완료시켜 재열기·PTY 재입력·명시적 종료와 중복 실행 부재를 검사하도록 작성했다.
설치된 standalone PWA의 native window lifecycle이나 browser crash/OS 강제 종료를 실행했다고 주장하지 않는다.

## 실행 검증

검사 전에 매번 `set -a; source /home/ubuntu/.config/environment.d/60-build-storage.conf; set +a`와 `source /data/project/paseodog_opus/.envrc.dev`를 적용했다.
기존 cache·병렬도는 유지했다.
worktree에 도구 설치·복사를 하지 않고 ignored `.dev`를 `/data/project/paseodog_opus/.dev`에, `web/node_modules`를 `/data/project/paseodog_opus/web/node_modules`에 symlink했다.
전자는 `scripts/build.py`가 설정하는 worktree 기준 CARGO_HOME/RUSTUP_HOME도 같은 메인 툴체인을 가리키게 한다. 공유 서비스나 메인 tracked 파일 변경이 아니다.

| 실제 명령 | 결과·입력 범위 |
|---|---|
| `python3 scripts/build.py test --rust tab_close --dry-run` | 선택 target이 `cargo test --test tab_close`로 해석됨. 실행 시험 아님 |
| `flock /home/ubuntu/.cache/grove-rust-check.lock python3 scripts/build.py test --rust tab_close network terminals tasks turn_completion` | exit 0, 컴파일 포함 **27개 통과**. 신규 7, 기존 network 1·terminals 5·tasks 8·turn_completion 6 |
| `python3 scripts/build.py test --vitest app/api/events.test.ts app/state/events.test.ts app/components/terminal/input.test.ts --typecheck` | exit 0, typecheck 통과. Vitest **34개 통과**: SSE 클라이언트 4·cursor/parser 3·터미널 입력 27. E2E TypeScript도 typecheck 대상 |
| `npx playwright test --list e2e/tab-close.spec.ts` (`web` cwd) | exit 0, desktop 9개 수집. browser 실행·사용자 흐름 통과 근거가 아님 |
| `python3 scripts/build.py test --typecheck` | exit 0. E2E의 background 완료 대기 순서 보정 후 통과했고, 출력 assertion을 명령 요약이 아닌 실제 출력으로 좁힌 최종 파일에서도 재검증 통과 |

실행한 위 검사에는 실패·timeout·취소가 없었다. 변경되지 않은 Rust·Vitest 근거는 재사용했다.

## PC-005 충족 근거·미완료

| 요구 | 확인된 범위 | 남은 범위 |
|---|---|---|
| 탭·창·browser 종료가 턴을 취소하지 않음 | Rust의 SSE 폐기 후 streaming partial 유지·복원·모델의 무구독 완료 통과 | 실제 page/context/browser 종료 E2E 실행 대기 |
| 장시간 도구·background 실행 지속 | 실제 foreground/background 셸의 gate를 disconnect 후 해제해 완료·출력·단일 결과·재실행 부재 확인 | UI를 포함한 6개 close-mode/작업 조합 E2E 실행 대기 |
| PTY 지속·화면 복원 | graceful WS Close와 갑작스러운 drop 후 동일 PID, offline 출력, 재입력, 명시적 kill·저장 화면 통과 | 실제 browser/PWA window 흐름·Windows ConPTY 미실행 |
| 사용자 취소·터미널 종료 유지 | 새 Rust의 턴·foreground 프로세스·사용자 task 취소와 PTY kill, 관련 기존 회귀 통과 | UI 취소·종료는 작성된 E2E로 통합 확인 필요 |
| 기존 resynchronization 보존 | 제품 변경 없음. 유효 `Last-Event-ID` replay·partial snapshot과 기존 클라이언트 cursor 시험 통과 | 새 E2E 실행, 만료 cursor 전용 runtime 회귀는 이번 미선택 |

## 통합 대기·다음 행동

`work/COMMON.md`의 독립 단계 E2E·전체 회귀·release·패키징 금지에 따라 E2E는 **미실행**이다.
공유 고정 포트 서버를 시작하거나 다른 세션에 실행 조율을 요구하지 않았다.
따라서 서버 수명 계약은 로컬에서 검증됐지만, `23.md`의 Rust+브라우저 인수 완료 조건은 아직 충족하지 않았다.

통합 담당은 다른 E2E와 겹치지 않는 시점에 같은 공통 환경을 적용하고 프로젝트 진입점 `python3 scripts/build.py test --e2e e2e/tab-close.spec.ts`를 실행해야 한다.
실패하면 실제 제품 결함과 locator/fixture 계약 차이를 구분해 수정한다.
설치형 PWA native window와 실제 플랫폼 확인이 남으면 그 한계를 유지하고 `PC-005`를 검증 없이 완료 처리하지 않는다.
메인 checkout 통합·TODO 갱신·workspace 정리는 이 작업에 포함하지 않았다.
