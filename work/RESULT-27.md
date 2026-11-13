# b02 / 27 — PWA 호환·오프라인·다중 탭 복구

<!-- grove-handoff:v1
{"state":"ready","remaining":[],"blockers":[],"integration_checks":["22 담당: web/e2e/create-entry.spec.ts의 알려진 focus trap 실패 수정 후 생성 전체 인수","실기기 Safari/iOS/Android 확보 후 실제 eviction·장기 저장 정책·백그라운드 탭 수명 인수"]}
-->

## 현재 인계 — 승인된 후속 완료

- 위치·브랜치: `/home/ubuntu/.local/share/paseodog/paseo/worktrees/0q796rug/b02-27-pwa-recovery`, `parallel/b02-pwa-recovery`.
- 원래 기준은 `551f551d48d1f47cd3ad67015f1737c62d576228`로 유지한다. `8c09b9d`의 구현·검증을 보존했고, 통합 담당이 22의 `e28dbdf`를 동기화한 `8da340d`의 clean checkout에서 재개했다. 자체 merge는 하지 않았다.
- 현재 정본 `/data/project/paseodog_opus/work/COMMON.md`, `/data/project/paseodog_opus/work/27.md`를 재확인했다. 런타임 설정은 변경하지 않았다.
- **소유 구현·연결·선택 단위·최종 typecheck·배정된 브라우저 흐름 완료. 실행 가능한 소유 잔여·blocker 없음.** TODO 완료 표시는 하지 않았다.
- 아래 접힌 최초 인계의 “생성·WebSocket 미연결”, “브라우저 미실행”은 과거 상태다. 이번 후속에서 해소했으며 현재 계약은 이 절을 따른다.

### 완성된 연결·권한 계약

- `TerminalView`의 키보드 `onData/send`, paste, 보조키, ResizeObserver resize, onopen 초기 resize와 입력 활성화가 모두 기존 `requireServerAction()`을 통과한다. 이벤트나 React 갱신보다 먼저 `navigator.onLine`이 바뀌어도 전송하지 않는다. 별도의 호환 정책·입력 큐는 만들지 않았다.
- PWA 차단은 이유를 표시하고 xterm stdin·서버 입력 보조키만 잠근다. Ctrl/Alt 상태를 비우며 로컬 보조키 해제·출력 표시·선택/복사를 서버 작업으로 바꾸지 않는다. PTY 종료·socket 종료·실행 실패·턴 취소로 취급하지 않는다. 복구 시 입력/resize를 재전송하는 effect가 없다.
- ticket 발급·WS 연결/재연결·snapshot·저장 화면·명시적 종료는 기존 경로를 유지한다. 실제 PTY가 계속 running인 상태에서 차단·복구를 확인했다. 기존 모바일 보조키·한글 조합·bracketed paste·reload 재연결 시험도 통과했다.
- Workspace가 `CreationEntry`와 `AddProjectDialog`에 이유/guard를 주입한다. “만들기”, 프로젝트 선택·입력창 열기는 로컬 탐색으로 유지한다. AddProject는 등록/clone/원래 요청 확인 버튼만 차단하고 경로 입력·복사·정상 취소는 유지한다. 미확정 생성의 기존 닫기 잠금은 풀지 않는다.
- ProjectView가 `ProjectComposer`에 이유/guard를 주입한다. PWA 이유를 textarea의 parent disabled로 전달하지 않는다. 대화 생성과 후속 메시지/턴 전송 직전에 검사한다. 생성 응답을 받은 뒤 두 번째 단계가 차단되면 전체 의도의 원래 `${key}:session`, `${key}:send`를 보존하도록 결과 확인 상태를 유지한다. 복구 후 자동 전송하지 않고 사용자가 같은 요청을 확인한다. 브라우저에서 대화 1개·메시지 1개와 키 재사용을 확인했다.
- 새 터미널·worktree 생성 및 worktree 변경 처리 선택 버튼에도 기존 `ServerActionButton`을 연결했다. 실제 worktree 화면에서 offline/protocol 이유, 로컬 이름 편집, 복구 후 무자동생성을 확인했다.
- 자원 생성 알고리즘·모달·focus trap·전송 사본 구현 자체는 재설계하지 않았다. 인증 세대·idempotency·알 수 없는 결과 계약과 기존 공통 HTTP guard는 유지했다. auth/API·초안 저장소·worker 구현에는 후속 변경이 없다.
- 새 영구 자격 저장, 인증 우회, microphone 녹음/음성 입력/STT, TTS 변경, 의존성/lockfile 변경, TODO 변경, main 편집, 위임/세션 연락, push/배포/정리는 하지 않았다.

### 추가 public props / export

| 지점 | 계약 |
|---|---|
| `web/app/components/pwa/terminalAction.ts::terminalAction(action, blocked)` | 동기 작업 직전에 기존 lifecycle guard 확인. 거부 시 이유 callback과 `false`, 허용 시 작업 실행과 `true`. 실제 socket 오류는 삼키지 않음. 저장·재시도·PTY 제어 없음 |
| `CreationEntry.blockedReason` | 선택적 `string \| null`, 안내만 표시. 로컬 선택은 유지 |
| `AddProjectDialog.blockedReason / beforeMutation` | 이유와 선택적 `() => void` guard. 생성 요청 사본을 할당하기 전에 검사 |
| `ProjectComposer.blockedReason / beforeMutation` | 안내와 선택적 `() => void` guard. 생성 전 차단은 미전송, 이미 생성된 후의 단계 차단은 원래 의도 확인 상태 유지 |
| `TerminalKeys.blockedReason` | 서버 입력 버튼만 disabled/title 연결. 로컬 보조키 해제는 유지 |

root mount·서버 API 등록·추가 공통 연결은 필요 없다.

### 이번 후속 소유 변경

- `web/app/components/TerminalView.tsx`, `web/app/components/terminal/TerminalKeys.tsx`
- `web/app/components/Workspace.tsx`, `web/app/components/ProjectView.tsx`, `web/app/components/WorktreesPanel.tsx`
- `web/app/components/AddProject.tsx`, `web/app/components/create/CreationEntry.tsx`, `web/app/components/create/ProjectComposer.tsx`
- `web/app/components/pwa/terminalAction.ts`, `web/app/components/pwa/terminalAction.test.ts`, `web/app/components/pwa/creationConnections.test.ts`
- `web/e2e/pwa-transport.spec.ts`, `web/e2e/pwa-recovery.spec.ts`, `web/e2e/pwa-lifecycle.spec.ts`
- `work/RESULT-27.md`

### 유효한 검증과 재사용

`8c09b9d`의 기존 197개 근거는 아래 최초 인계와 해당 commit에 보존했다. `8c09b9d..8da340d`의 변경 경로를 확인했으며 해당 18개 단위 시험의 구현·fixture 입력은 변경되지 않아 재실행하지 않았다. 후속에서 변경한 생성 컴포넌트와 terminal 연결은 별도 선택 검사로 검증했다.

모든 명령은 먼저 `source /data/project/paseodog_opus/.envrc.dev`를 적용했다. 최종 production 코드는 첫 선택 단위 검사 이후 동일하며, 이후 수정은 E2E locator·플랫폼/배치 동기화·추가 수명/저장소 시험이다. 마지막 typecheck에는 이 시험 소스도 포함됐다.

단위 명령:
`python3 scripts/build.py test --vitest app/components/pwa/terminalAction.test.ts app/components/pwa/creationConnections.test.ts app/components/create/creation.test.ts app/components/create/projectComposer.test.ts app/components/terminal/input.test.ts --typecheck`

- 5개 파일 55개 통과: terminalAction 4, 생성 연결 5, 기존 생성 16, ProjectComposer 3, 기존 terminal input 27.
- typecheck: wall 8.14s / CPU 11.31s, exit 0. Vitest: wall 1.44s / CPU 3.29s, exit 0.
- 이전 197개와 별도의 55개다. 전체 suite를 다시 실행하거나 이 합계를 전체 제품 완료율로 사용하지 않았다.

아래 E1은 `flock /home/ubuntu/.cache/grove-rust-check.lock python3 scripts/build.py test ...`, E2 이후는 같은 명령 앞에 `RUSTUP_AUTO_INSTALL=0 CARGO_NET_OFFLINE=true`를 적용했다. 서버 빌드부터 브라우저 종료까지 전체 명령을 같은 잠금으로 직렬화했다. 포트·공통 E2E 설정·다른 실행은 건드리지 않았다.

| 실행 | `test` 이후 정확한 입력 | 결과 / E2E wall·CPU |
|---|---|---|
| E1 | `--typecheck --e2e e2e/pwa-recovery.spec.ts e2e/pwa-lifecycle.spec.ts e2e/pwa-transport.spec.ts e2e/pwa-update.spec.ts e2e/terminal-input.spec.ts` | 8 통과, 1 locator 실패, 6 미실행. 17.61s / 9.89s, exit 1 |
| E2 | `--e2e e2e/pwa-recovery.spec.ts:63 e2e/pwa-recovery.spec.ts:102 e2e/pwa-recovery.spec.ts:150 e2e/pwa-transport.spec.ts e2e/pwa-update.spec.ts e2e/terminal-input.spec.ts` | 수정한 단계 사이 복구·cold start·protocol 3 통과, terminal timeout 1, 3 미실행. 24.26s / 5.47s, exit 1 |
| E3 | `--e2e e2e/pwa-transport.spec.ts e2e/pwa-update.spec.ts e2e/terminal-input.spec.ts` | terminal timeout 1, 3 미실행. 22.13s / 3.5s, exit 1 |
| E4 | `--e2e e2e/pwa-transport.spec.ts e2e/pwa-update.spec.ts e2e/terminal-input.spec.ts e2e/pwa-recovery.spec.ts:169` | 실제 worktree 차단 1 통과, terminal timeout 1, 3 미실행. 23.11s / 4.08s, exit 1 |
| E5 | `--e2e e2e/pwa-transport.spec.ts e2e/pwa-update.spec.ts e2e/terminal-input.spec.ts e2e/deployment-base.spec.ts` | 6 통과. 18.29s / 7.48s, exit 0 |
| E6 | `--typecheck --e2e e2e/deployment-base.spec.ts` (`GROVE_WEB_BASE=/grove/`) | 하위 경로 2 통과. 6.03s / 3.31s, exit 0 |
| E7 | `--typecheck --e2e e2e/pwa-lifecycle.spec.ts:158` | 실제 Chrome quota/저장 정책 1 통과. 2.79s / 2.9s, exit 0 |

line selector는 그 실행 시점 소스 기준이다. 뒤의 import·신규 시험 추가로 현재 line이 달라진 경우 이름으로 대응한다. 통과한 입력은 재사용하고 실패·미실행·추가 시험만 실행했다. 현재 서로 다른 인수 시나리오는 **21개 통과**이며 단일 전체 E2E 실행 결과는 아니다:

- `web/e2e/pwa-lifecycle.spec.ts`: 7개. 열린 탭 offline, multi-tab exact lazy asset/단일 구 탭/회수, protocol, mock quota, 실제 quota/정책, 저장/cache 삭제, 사용자 동의 갱신.
- `web/e2e/pwa-recovery.spec.ts`: 6개. 1400/390px 생성 진입, 단계 사이 차단과 원래 키, 인증 없는 offline cold start/초안 보존, protocol 인증 차단, 실제 worktree 생성 차단.
- `web/e2e/pwa-transport.spec.ts`: 2개. 실제 열린 PTY의 입력/paste/보조키/observer resize 차단과 무재전송, ticket 후 protocol 전환의 초기 resize/입력 차단.
- `web/e2e/pwa-update.spec.ts`, `web/e2e/terminal-input.spec.ts`: 각각 1개 기존 흐름 통과.
- `web/e2e/deployment-base.spec.ts`: `/` 2개와 `/grove/` 2개 통과.

마지막 E7 typecheck wall 7.11s / CPU 11.31s, exit 0. 최종 root build의 worker version은 `d351f72336fe8db9`이며 E1~E5와 같은 production 입력이다. `/grove/` 빌드는 `03ce1e70e528684f`로 별도 생성·실행했다. Rust 소스 수정은 없어 Rust 단위/통합 시험은 추가 선택하지 않았지만 E2E의 debug 서버 빌드는 통과했다. release·전체 회귀는 실행하지 않았다.

실행 원문(stdout/stderr 쌍):

- E1: `/home/ubuntu/.local/share/paseodog/mixdog/data/shell-output/shell_9d099c1a.stdout`, `/home/ubuntu/.local/share/paseodog/mixdog/data/shell-output/shell_9d099c1a.stderr`
- E2: `/home/ubuntu/.local/share/paseodog/mixdog/data/shell-output/shell_3e29d2ab.stdout`, `/home/ubuntu/.local/share/paseodog/mixdog/data/shell-output/shell_3e29d2ab.stderr`
- E3: `/home/ubuntu/.local/share/paseodog/mixdog/data/shell-output/shell_5ec5c631.stdout`, `/home/ubuntu/.local/share/paseodog/mixdog/data/shell-output/shell_5ec5c631.stderr`
- E4: `/home/ubuntu/.local/share/paseodog/mixdog/data/shell-output/shell_6f081ef0.stdout`, `/home/ubuntu/.local/share/paseodog/mixdog/data/shell-output/shell_6f081ef0.stderr`
- E5: `/home/ubuntu/.local/share/paseodog/mixdog/data/shell-output/shell_6845d318.stdout`, `/home/ubuntu/.local/share/paseodog/mixdog/data/shell-output/shell_6845d318.stderr`
- E6: `/home/ubuntu/.local/share/paseodog/mixdog/data/shell-output/shell_6112c750.stdout`, `/home/ubuntu/.local/share/paseodog/mixdog/data/shell-output/shell_6112c750.stderr`
- E7: `/home/ubuntu/.local/share/paseodog/mixdog/data/shell-output/shell_b6724a04.stdout`, `/home/ubuntu/.local/share/paseodog/mixdog/data/shell-output/shell_b6724a04.stderr`

### 실패 원인·환경 사고와 복구

- E1 실패는 시험 locator가 실제 “같은 요청 확인”을 옛 이름 “원래 요청 결과 확인”으로 찾은 것이다. 실제 미전송·pending 보존 요구는 낮추지 않고 locator만 수정했다.
- terminal timeout들은 새 harness가 데스크톱에서 숨겨지는 보조키를 찾고, 좁은 화면 초기 배치 준비를 기다리지 않으며, observer 자극 중 760px 경계를 넘어 다른 저장 배치로 이동한 데서 발생했다. snapshot·실제 `Workspace` 배치 코드와 `.term-keys` pointer 조건을 확인하고, 터치 조건·배치 준비 관측·같은 배치 안 resize로 수정했다. timeout을 늘리거나 입력/resize 시나리오를 삭제하지 않았다. finally의 닫힌 page 접근도 제거해 원래 실패를 가리지 않도록 했다.
- E1에서는 공통 env를 source했어도 `scripts/build.py::env()`가 worktree `.dev`를 지정하여 rustup이 **1.93.0을 자동 설치하고 Cargo cache를 다운로드했다**. 설치 금지 계약에 어긋난 이 실행 사실을 남긴다. 시작 전 없던 이번 실행 소유 `.dev`, `target`임을 확인하고 제거한 뒤 `.dev`를 `/data/project/paseodog_opus/.dev`로 symlink 복구했다. main 툴체인·사용자 파일은 삭제/복사하지 않았다. 이후 auto-install을 막고 offline Cargo로 공유 환경만 사용했으며 추가 설치·다운로드나 manifest/lockfile 변경은 없다.
- 빌드의 기존 chunk-size 경고·React Router future 경고는 passing 코드를 바꿀 사유로 삼지 않았다. 실행기 원문에 남겼다.
- E1의 typecheck wall/CPU 7.04s/11.26s, debug build 141.8s/211.43s, web build 5.49s/4.94s. 복구 뒤 E2 debug/web 1.02s/0.27s·3.18s/4.87s, E3 1.0s/0.26s·3.22s/4.77s, E4 0.26s/0.26s·3.63s/4.68s, E5 0.87s/0.25s·3.25s/4.89s, E6 7.23s/0.33s·3.36s/4.97s, E7 2.34s/0.26s·3.27s/4.83s. E6 typecheck 8.63s/11.21s. 이는 개별 단계 값이며 잠금 대기나 작업 시간 절감량을 추정한 값이 아니다.

### TODO별 현재 판정·외부 인수

| ID | 소유 범위 완료 근거 | 남는 한계 / 해제 조건 |
|---|---|---|
| WEB-007 | 인증·HTTP·WS 호환 경계, 실제 multi-tab document/asset/cache 전환, `/`·`/grove/`의 동의 후 갱신 통과 | 실제 다른 엔진·장기 중지된 설치형 탭은 해당 실기기를 확보해 수동 인수 |
| WEB-009 | offline 버튼/단축키/WS 차단, 인증 없는 cold start 비노출·사본 보존·온라인 복구, 생성의 로컬 탐색/편집/취소, 단계별 원래 키와 무자동재전송 브라우저 통과 | 오프라인 인증 우회나 다른 계정 초안 목록 열기는 의도적으로 제공하지 않음 |
| WEB-016 | Chrome의 실제 origin quota 예외·실제 persisted 정책 안내·기존 사본/메모리 입력 보존·미전송, 관측한 storage/cache 삭제, 다중 탭 안전 회수 통과 | OS/브라우저의 실제 자동 eviction은 결정적으로 유발할 승인된 실기기 환경이 없음. 실기기 저장 압박·장기 백그라운드 수동 인수 필요. 삭제 데이터 복구·첫 방문과 전체 삭제의 구분·영구 보존은 보장 불가 |

22의 알려진 focus trap 실패는 이 작업의 blocker나 통과로 바꾸지 않았다. 22 담당이 수정한 뒤 `web/e2e/create-entry.spec.ts`의 전체 생성 접근성 흐름을 인수해야 한다. 기존 근거: `/home/ubuntu/.local/share/paseodog/mixdog/data/shell-output/shell_56f2bbd0.stdout`, `/home/ubuntu/.local/share/paseodog/mixdog/data/shell-output/shell_56f2bbd0.stderr` (46개 중 첫 focus 실패, 나머지 45개 미실행). PWA 시험은 이 실패 기대를 제거하거나 해당 파일을 수정하지 않았다.

구 UI·버전 불명 탭이 남으면 cache 회수를 보류하므로 고정 cache 상한은 보장하지 않는다. 원격 logout이 전송되지 못한 경우 서버 쿠키 폐기 성공도 보장하지 않는다. 기존 안내·명시적 복구 계약을 유지하며 새 자격 저장/자동 폐기 큐는 없다.

<details>
<summary>8c09b9d 최초 인계와 197개 검증 근거 — 과거 상태 보존</summary>

아래 “미완료·미실행·다음 통합 단계”는 최초 commit 시점의 기록이다. 현재 상태와 해소 범위는 위 후속 인계를 따른다.

## 기준과 상태

- worktree: `/home/ubuntu/.local/share/paseodog/paseo/worktrees/0q796rug/b02-27-pwa-recovery`
- branch: `parallel/b02-pwa-recovery`
- 공통 기준: `551f551d48d1f47cd3ad67015f1737c62d576228`. 시작 HEAD와 일치했고 작업 트리는 깨끗했다.
- 원본 `/data/project/paseodog_opus/work/ENTRY.md`, `/data/project/paseodog_opus/work/COMMON.md`, `/data/project/paseodog_opus/work/27.md`와 README의 실제 경로·브랜치 배정을 확인했다. `af0ad28`이 현재 기준의 조상임도 확인했다.
- 상태: **소유 HTTP 복구 흐름 구현·타입 검사·선택 단위 시험 완료 / 브라우저 통합 인수 대기 / 남은 경계 있음**. 세 TODO 전체 완료로 판정하지 않는다.
- main·TODO·의존성·lockfile·서버·공통 검사 설정을 수정하지 않았다. 위임·세션 조회/연락·merge·push·배포·workspace 삭제는 하지 않았다.

## 제공 동작과 실제 연결

- `web/app/api/client.ts`의 로그인·페어링·refresh·logout 전송 직전에 기존 `serverActionGuard`를 사용한다. lifecycle의 offline·호환 확인 중·연결 실패·protocol 불일치 정책을 복제하지 않았다. 별도 인증 응답에도 기존 `checkProtocol()`을 적용한다.
- 로그인은 기존 `boundedRequest()`를 재사용해 전송 전 차단은 `result_unknown: false`, 실제 응답 유실은 `result_unknown: true`로 구분한다. 로그인·일회용 페어링은 자동 refresh/재시도를 하지 않는다.
- refresh singleflight와 소유 세대 검사를 유지했다. guard가 첫 await 전에 동기적으로 거부해도 완료된 Promise가 영구히 남지 않도록 정리를 Promise의 `finally`로 옮겼다. 차단·네트워크 실패는 열린 탭의 인증을 만료시키지 않는다. 실제 HTTP 인증 거부 시 만료 처리·초안 정리 정책은 기존대로다.
- 진행 중 로그인·페어링의 응답은 인증 세대가 바뀌면 적용하지 않는다. 인증이 아직 없던 cold start의 logout도 세대를 바꾼다. logout은 기존 로컬 종료와 진행 중 refresh 뒤 쿠키 폐기 순서를 유지하며, 차단된 원격 폐기를 복구 후 자동 재전송하지 않는다.
- 페어링 제출 callback은 HTTP status 0만으로 미전송을 결과 불명으로 오인하지 않고 `details.result_unknown`을 사용한다.
- `web/app/routes/app.tsx`의 기존 앱 인증 진입에서 health 호환 확인 뒤 최초 refresh를 시도한다. offline·호환 실패의 cold start에는 `AuthRecovery`를 표시한다. 연결 복구 이벤트는 health만 조회하며, 보류한 인증 복구는 사용자가 직접 선택한다. 실패하면 기존 로그인 화면으로 이어진다. 페어링 링크는 자동 사용하지 않는다.
- `AuthRecovery`는 로컬 초안 목록·키·본문·대화 목록을 조회하지 않는다. 인증 없이 Workspace를 mount하지 않는다. 기존 사본을 삭제하거나 새 자격을 저장하지 않고, 원래 계정으로 온라인 인증 후 대화를 열도록 안내한다. 서버 작업·결과 불명 요청의 재전송은 하지 않는다.
- 기존 root의 `LifecycleBanner` mount를 유지했다. 보존 한계 안내에 구 UI 탭·버전 불명 탭 때문에 cache 회수가 보류될 수 있다는 설명을 더했다. 안내에 애니메이션은 추가하지 않았다.
- `ServerActionButton`으로 아래 기존 서버 작업 버튼의 disabled·title·접근성 설명을 연결했다. 원래 disabled·callback·권한·idempotency key·불명 결과 사본은 유지했다. 로컬 편집·취소·복사·조회 버튼은 별개다. 승인 카드는 `af0ad28`의 기존 `blockedReason` 연결을 그대로 사용한다.
- 외부 편집기의 순수 `ExternalEditorControls`는 전역 PWA 상태를 읽지 않는다. FilesView가 `blockedReason` action prop을 전달하고 실제 API는 기존 공통 guard로 차단한다.
- worker가 자기 cache의 HTML을 반환할 때만 `grove-shell-version` meta로 document 버전을 표시한다. cache 유실 시 network HTML의 버전을 추측하지 않는다. lifecycle은 시작 시 읽은 document 버전을 계속 보고하므로 다른 탭의 controller 전환을 자기 document 갱신으로 오인하지 않는다.
- cache 회수는 scope 안의 **모든 살아 있는 document가 현재 버전을 보고한 경우**, 또는 살아 있는 document가 없는 activation에서만 허용한다. 단일 구 탭·버전 불명 탭·worker 재시작 후 미확인 탭은 cache를 보존한다. 탭 수만으로 삭제하던 분기를 제거했다.
- 회수 대상은 정확한 scope prefix의 현재 cache보다 먼저 만들어진 cache다. 현재 shell 유실·설치 중·대기 worker가 있으면 회수를 보류한다. 뒤에 생긴 새 cache·대기 cache·다른 scope·scope 없는 legacy cache는 삭제하지 않는다. 구 탭의 정확한 hashed asset URL fallback과 API cache 제외는 유지했다.
- 대기 worker를 관측하지 못한 탭도 다른 탭의 controller 전환 뒤 업데이트 선택을 받는다. 첫 claim·다른 탭의 동의만으로 reload하지 않는다.

## public 계약

| export / 연결 | 계약 |
|---|---|
| `AuthRecovery({ recover })` | `recover: () => Promise<void>`. 온라인 버튼으로 health 확인 후 callback 호출. 인증·초안 데이터는 props로도 받지 않음 |
| `ServerActionButton(props)` | `ButtonHTMLAttributes<HTMLButtonElement>`. 기존 disabled와 공통 차단을 합치고 이유를 title·aria-description에 표시. 전송 검사는 API guard 소유 |
| `ExternalEditorControlsProps.blockedReason`, `ExternalEditor.blockedReason` | 선택적 `string \| null`. 호출부 FilesView가 주입. 기존 독립 사용의 기본 활성 조건 유지 |
| worker `shell-status` 요청 | `{ type: "shell-status", version: string \| null }`. 문서의 버전이며 controller 버전이 아님. 출처 client ID·scope를 확인하고 미확인 버전은 삭제 동의로 해석하지 않음 |
| worker `shell-status` 응답 | 기존 `{ type: "shell-status", cached: boolean }` 유지 |
| 인증·서버 오류 | 기존 `ApiError`, protocol 알림, `result_unknown`, 요청 세대와 원래 idempotency key 사용. 새 서버 endpoint·권한 완화·영구 자격 저장 없음 |

추가 root mount·API 등록은 필요 없다. 22·24·25·26의 새 화면에는 통합 시 같은 action props/기존 guard를 연결해야 하며 해당 기능 구현은 수정하지 않았다.

## 소유 변경 파일

복구·worker·시험:

- `web/app/api/client.ts`
- `web/app/routes/app.tsx`
- `web/app/components/pwa.tsx`
- `web/app/components/pwa/AuthRecovery.tsx`
- `web/app/components/pwa/ServerActionButton.tsx`
- `web/app/components/pwa/LifecycleBanner.tsx`
- `web/app/components/pwa/lifecycle.ts`
- `web/app/components/pwa/lifecycle.test.ts`
- `web/app/components/pwa/auth.test.ts`
- `web/app/components/pwa/presentation.test.ts`
- `web/app/components/pwa/update.test.ts`
- `web/app/components/pwa/pwa.css`
- `web/public/sw.js`
- `web/app/deployment/sw.test.ts`
- `web/e2e/pwa-lifecycle.spec.ts`
- `web/e2e/pwa-recovery.spec.ts`
- `work/RESULT-27.md`

나머지는 기존 서버 action props·버튼 연결만 변경했다. 페어링은 제출 callback의 미전송/결과 불명 안내 조건도 바로잡았다.

- `web/app/components/SessionView.tsx`
- `web/app/components/AgentRunsPanel.tsx`
- `web/app/components/ArchivedProjects.tsx`
- `web/app/components/BotsPanel.tsx`
- `web/app/components/ChangesPanel.tsx`
- `web/app/components/ContextMeter.tsx`
- `web/app/components/FilesView.tsx`
- `web/app/components/GitPanel.tsx`
- `web/app/components/GoalsPanel.tsx`
- `web/app/components/Login.tsx`
- `web/app/components/McpServers.tsx`
- `web/app/components/NotificationsPanel.tsx`
- `web/app/components/Pairing.tsx`
- `web/app/components/ProfileCapabilities.tsx`
- `web/app/components/ProfileCatalog.tsx`
- `web/app/components/ProfileContextPolicy.tsx`
- `web/app/components/ProjectLabels.tsx`
- `web/app/components/ProjectScripts.tsx`
- `web/app/components/ProjectView.tsx`
- `web/app/components/RecentPanel.tsx`
- `web/app/components/RemoteWatchesPanel.tsx`
- `web/app/components/SchedulesPanel.tsx`
- `web/app/components/ScopedSettings.tsx`
- `web/app/components/Settings.tsx`
- `web/app/components/SettingsReset.tsx`
- `web/app/components/TasksPanel.tsx`
- `web/app/components/TerminalView.tsx`
- `web/app/components/TrashPanel.tsx`
- `web/app/components/UsagePanel.tsx`
- `web/app/components/Workspace.tsx` (배치 다시 저장 버튼만, 생성 진입은 미변경)
- `web/app/components/WorktreesPanel.tsx`
- `web/app/components/files/ExternalEditor.tsx`
- `web/app/components/git/GitConfirmation.tsx`
- `web/app/components/hooks/HooksSettings.tsx`

## 실제 검증

검사마다 `source /data/project/paseodog_opus/.envrc.dev`를 적용했다. COMMON의 경로로 `web/node_modules` symlink만 만들었고 설치·복사는 하지 않았다.

1. 결함 재현:
   `python3 scripts/build.py test --vitest app/components/pwa/auth.test.ts`
   - 최초 8개 모두 실패, exit 1. 인증 전송이 guard를 우회하고 응답 protocol도 반영하지 않는 것을 확인했다. 이 실패를 통과로 계산하지 않는다.
2. 첫 구현 검사:
   `python3 scripts/build.py test --vitest app/components/pwa/auth.test.ts app/components/pwa/lifecycle.test.ts app/components/pwa/update.test.ts app/components/pwa/presentation.test.tsx app/deployment/sw.test.ts app/deployment/base.test.ts app/api/client.test.ts app/state/drafts.test.ts app/state/cleanup.test.ts app/state/fileState.test.ts app/state/projectScripts.test.ts app/components/approvals/ApprovalCard.test.ts app/components/approvals/decision.test.ts app/components/git/GitConfirmation.test.ts --typecheck`
   - typecheck 통과. 실행된 13개 파일 158개 시험 통과.
   - `presentation.test.tsx`는 기존 `app/**/*.test.ts` include에서 제외됐음을 출력과 설정으로 확인했다. 통과한 시험으로 취급하지 않고 JSX 없는 파일을 `presentation.test.ts`로 옮겼다.
3. action 연결 검사:
   `python3 scripts/build.py test --vitest app/components/pwa/presentation.test.ts app/components/hooks/HooksSettings.test.ts app/components/files/ExternalEditor.test.ts app/components/AgentRunsPanel.test.ts app/state/layoutPersistence.test.ts --typecheck`
   - typecheck 통과. 28개 중 27개 통과·외부 편집기 활성 조건 1개 실패, exit 1.
   - 순수 Controls가 PWA 전역 상태를 직접 읽던 연결을 FilesView의 명시적 `blockedReason` props로 수정했다. 기존 시험의 요구를 낮추거나 수정하지 않았다.
   - 뒤에 `&&`로 연결한 `node --check`는 이 호출에서는 미실행이었다.
4. 실패·변경된 시험 재검사:
   `python3 scripts/build.py test --vitest app/components/pwa/presentation.test.ts app/components/files/ExternalEditor.test.ts app/components/pwa/lifecycle.test.ts app/deployment/sw.test.ts --typecheck`
   - typecheck 통과. 4개 파일 72개 시험 통과: 표시/개인정보 6, 외부 편집기 4, lifecycle 14, worker 48.
   - 이어 실행한 `node --check web/public/sw.js`도 통과했다.
5. 인증 오류 안내와 실제 응답 유실 보강 뒤:
   `python3 scripts/build.py test --vitest app/components/pwa/auth.test.ts --typecheck`
   - typecheck 통과. 인증 시험 13개 통과.
6. `git diff --check`: 통과.

변경되지 않은 입력의 통과를 재사용하면 현재 선택 검증 범위는 18개 파일 197개 시험이다. 이는 단일 전체-suite 실행 결과나 브라우저 인수 결과가 아니다. 실제 worker source를 VM에서 실행한 단위 시험이며 브라우저 CacheStorage·service worker 실증으로 바꾸어 표현하지 않는다.

Rust 변경은 없어 선택 Rust 시험은 해당 없음이다. COMMON의 독립 단계 계약에 따라 E2E·전체 회귀·release·원격 서비스·실기기는 실행하지 않았다. 새 E2E는 타입 검사까지만 통과했다.

## TODO별 충족과 남은 조건

| ID | 이번에 연결·검증한 요구 | 미완료·외부 검증 |
|---|---|---|
| WEB-007 | auth 전송도 기존 호환 guard 사용, 응답 protocol 확인, 다른 탭 전환 안내, 문서 버전별 cache 보존·안전 회수 단위 시험 | 실제 다중 탭 전환·HTML meta hydration·구 lazy asset 응답·브라우저 재시작 인수는 새 E2E 실행 필요 |
| WEB-009 | 소유 서버 action 버튼의 이유·비활성 연결, 미전송/결과 불명 구분, 인증 전 초안을 읽지 않는 cold-start 안내와 명시적 복구, 인증 세대·singleflight·원래 요청 키 회귀 | offline cold start→같은 계정 인증→기존 초안 복원은 브라우저 미검증. 22 소유 생성 진입 등 다른 기능 버튼의 최종 연결·일부 기존 전송 경계는 아래에 명시 |
| WEB-016 | 단일 구 탭·버전 불명·다중 탭·탭 종료·모두 전환·대기 cache·현재 shell 유실을 구분한 회수 단위 시험, 보존 한계 안내 유지 | 실제 quota 한계·eviction·저장 정책·디스크 오류·브라우저 lifecycle은 미검증. 모든 저장 데이터 삭제와 첫 방문은 구분 불가 |

## 한계·blocker·다음 통합 단계

- **브라우저 인수 대기:** COMMON이 독립 단계 E2E를 통합으로 남긴다. 새 `web/e2e/pwa-recovery.spec.ts`는 cookie 없는 offline 재시작 시 초안 비노출·사본 보존·연결 후 무재전송·명시적 인증 복구·protocol 차단을 작성했다. `web/e2e/pwa-lifecycle.spec.ts`는 기존 action 차단 확인과 두 탭→새 탭 전환→구 탭만 남음→오프라인 exact asset 응답→모든 문서 전환 후 회수를 작성했다. 실행하지 않았으므로 실제 다중 탭·offline cold start 완료를 주장하지 않는다.
- 통합에서는 고정 포트를 독점한 뒤 `python3 scripts/build.py test --e2e e2e/pwa-recovery.spec.ts e2e/pwa-lifecycle.spec.ts e2e/pwa-update.spec.ts e2e/connection.spec.ts e2e/request-recovery.spec.ts`와 해당 승인 offline 흐름을 실행해야 한다. 루트·하위 경로 배포 브라우저 인수도 필요하다.
- **다른 기능 소유:** 22의 프로젝트/세션 생성 진입, 24·25의 새 실행/서버 업데이트 설정, 26의 브라우저 capability·권한 UI는 수정하지 않았다. 기존 공통 mutation guard는 이들 API의 fetch도 막지만, 다른 기능 생성 버튼 전체의 비활성 이유까지 이 작업이 연결했다고 주장하지 않는다. 기존 새 터미널·worktree 생성 버튼도 별도 UI 연결이 남는다.
- **기존 비-HTTP 경계:** TerminalView에서는 종료·명시적 재연결 버튼만 연결했다. 이미 열린 WebSocket의 키보드 입력·resize 전송 경로는 action props/버튼 범위를 넘어 수정하지 않았다. 알려진 protocol 불일치 중 기존 socket 입력까지 차단하는 보장은 아직 없으며, “모든 서버 변경”을 WebSocket까지 포함하는 인수에는 이 경계 연결이 추가로 필요하다. 실행·재연결 로직을 임의로 재설계하지 않았다.
- cache는 인증·대화·초안을 담지 않는다. 버전 불명 탭·정지된 탭·메시지를 보내지 않는 구 UI가 남으면 안전을 우선해 회수를 보류한다. 따라서 무제한 갱신 중 cache 공간의 고정 상한을 보장하지 않는다. 사용자가 입력을 보관한 뒤 탭을 갱신/종료하고 현재 탭의 다음 상태 확인에서 회수를 진행한다. 사이트 데이터 전체 자동 삭제는 하지 않는다.
- cold-start 안내는 인증 없이 기존 초안을 열어 주는 기능이 아니다. 삭제된 데이터 복구, 초안의 영구 보관, 인증되지 않은 로컬 초안 목록 제공, 전체 사이트 데이터 삭제 후 유실 감지는 제공하지 않는다.
- 원격 logout을 전송하지 못하면 서버 refresh 쿠키 폐기 성공을 보장하지 않는다. 같은 실행 문맥의 `lastAuthEnd === "logout"` 억제는 유지하며 새 영구 자격/저장 방식이나 자동 폐기 큐를 만들지 않았다. 브라우저 재시작을 포함한 원격 기기 폐기 인수는 별도다.
- microphone 녹음·음성 입력·STT는 추가하지 않았다. 기존 TTS와 microphone 차단 코드는 변경하지 않았다. 해당 실기기 동작을 새로 검증했다고 주장하지 않는다.

이 인계와 관련 변경만 한국어 로컬 커밋으로 남기고 편집을 종료한다. 이 문서에 자기 커밋 SHA를 넣기 위한 순환 수정은 하지 않는다.

</details>
