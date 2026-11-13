# b02 / 22 — UI-005 생성 진입점 통합

<!-- grove-handoff:v1
{"state":"ready","remaining":[],"blockers":[],"integration_checks":["통합 checkout에서 27의 CreationEntry/PWA props·guards와 결합 후 e2e/create-entry.spec.ts 인수","영향받은 공통 경계 e2e/sidebar-status.spec.ts, e2e/project-recovery.spec.ts, e2e/responsive-panes.spec.ts 인수"]}
-->

## 승인된 후속: 실제 dialog focus 결함 수정 완료

기준·초기 구현 `e28dbdf`를 보존한 결함 후속이다. provider-system retry가 아니다.
후속 변경은 `web/app/components/create/CreationDialog.tsx`, 신규 `web/app/components/create/CreationDialog.test.ts`, `web/e2e/create-entry.spec.ts`, 이 RESULT뿐이다.
27 담당의 `CreationEntry.tsx`·PWA props/guards·`Workspace.tsx`·`TerminalView.tsx`와 다른 checkout은 수정하지 않았다. 런타임 설정도 변경하지 않았다.

### 원인과 실제 산출물 재현

통합 실패 근거는 `<실행 로그>/shell_56f2bbd0.stdout`·`.stderr`다. 첫 desktop 시험 실패, 45개 미실행이었다.
자기 worktree에서 기존 구현을 새 debug 서버·새 정적 웹으로 빌드해 같은 취소 버튼 → Tab 시나리오를 실행했다.
`open=true`, `:modal=true`인데 `activeTag=BODY`로 빠지는 동일 결함을 재현했다. 통합의 Workspace 연결 때문이라고 판단하지 않았다.
네이티브 modal의 배경 inert 처리만으로 마지막 Tab이 문서 내부에서 순환한다고 가정했던 것이 원인이다.

- `CreationDialog`에 실제 표시·활성·tab 순서를 기준으로 정방향/역방향 경계 이동을 추가했다. 비활성 fieldset 자식·hidden/inert·닫힌 details·음수 tabindex·visibility:hidden은 건너뛴다.
- 비동기 변경으로 활성 요소가 제거되거나 비활성화되어 body로 이동해도 다음 Tab을 dialog 내부로 회수한다. 요소가 하나도 없으면 dialog 자체에 초점을 둔다.
- native `:modal`인 동안만 document keydown을 처리하고, 다른 활성 dialog·이미 처리된 키·브라우저 modifier 단축키는 가로채지 않는다. unmount 시 listener를 해제하고 기존 opener 초점을 복원한다.
- 기존 Escape/cancel·등록 진행/미확정 상태의 닫기 guard는 그대로 유지했다. 초점 경계 수정 외 서버·초안·mutation·idempotency 구현은 바꾸지 않았다.
- `containCreationTab(dialog, event)`를 같은 모듈에서 export해 경계 동작을 전용 단위 시험으로 검증한다. 기존 `CreationDialog` props는 호환된다.

### 후속 검사 명령·실패·최종 결과

모든 명령은 이 worktree에서 실행했고 먼저 `source <원본 저장소>/.envrc.dev`를 적용했다.
기존 ignored `.dev`·`web/node_modules` 공유 symlink를 재사용했다. 설치·설정·포트 변경이나 다른 검사 중단은 없었다.
아래 전체 호출은 서버·웹 빌드부터 브라우저 종료까지 동일 `flock` 안에서 실행했다.

```bash
CARGO_NET_OFFLINE=true RUSTUP_AUTO_INSTALL=0 flock /home/ubuntu/.cache/grove-rust-check.lock python3 scripts/build.py test --e2e e2e/create-entry.spec.ts e2e/project-add.spec.ts e2e/project-clone.spec.ts
CARGO_NET_OFFLINE=true RUSTUP_AUTO_INSTALL=0 flock /home/ubuntu/.cache/grove-rust-check.lock python3 scripts/build.py test --vitest app/components/create/CreationDialog.test.ts app/components/create/creation.test.ts app/components/create/projectComposer.test.ts --typecheck --e2e e2e/create-entry.spec.ts e2e/project-add.spec.ts e2e/project-clone.spec.ts
```

첫 명령으로 기존 결함을 재현하고, 둘째 명령으로 제품 수정·단위·타입·브라우저를 확인했다. 마지막 locator 수정 후 첫 명령의 정확한 세 spec을 다시 실행했다.

| 시도·코드 | 실제 결과 | 실행기 wall / CPU (초) |
|---|---|---|
| `e28dbdf` 제품 + 실패 초점 진단만 추가 | 동일 focus 결함, 1개 실패·7개 미실행 | debug build 64.7 / 80.63, web build 12.0 / 5.16, E2E 3.5 / 2.94 |
| dialog 수정 + 신규 전용 시험 | 타입·단위 35개 성공. 첫 desktop의 순환·복원·생성 흐름 통과. 다음 응답 유실 시험에서 잘못된 재확인 버튼 locator로 20초 timeout, 1개 통과·1개 실패·6개 미실행 | typecheck 6.95 / 11.15, Vitest 1.13 / 2.6, debug build 0.25 / 0.25, web build 3.13 / 4.69, E2E 23.58 / 4.43 |
| 실제 기존 Composer 재확인 버튼 locator 수정 후 최종 세 spec | debug·web build 성공, E2E 8개 모두 통과 | debug build 0.75 / 0.26, web build 3.06 / 4.66, E2E 9.9 / 8.56 |

응답 유실 시험의 입력·옵션은 그대로였으므로 `Composer`는 `recovering` 상태의 `같은 요청 확인`을 표시한다.
기존 시험은 입력이 바뀐 별도 상태의 `원래 요청 결과 확인`을 기다렸다. 실제 페이지 snapshot과 `Composer.tsx`의 분기로 확인한 뒤 locator만 바로잡았다.
transport abort·동일 요청 키·세션/메시지/프로젝트 개수와 원래 접근성 기대는 유지했다. 지연·무조건 재시도·기대 완화는 추가하지 않았다.

정확한 로그:

- 재현: `<실행 로그>/shell_5e58d178.stdout`·`.stderr`
- 제품 수정 후 단위/타입 통과 및 locator timeout: `<실행 로그>/shell_01af2d63.stdout`·`.stderr`
- 최종 8개 통과: `<실행 로그>/shell_42671354.stdout`·`.stderr`

최종 E2E locator 변경 후 `python3 scripts/build.py test --typecheck`도 다시 통과했다(wall 10.18초 / CPU 12.29초).
이 단계의 로그는 `<실행 로그>/shell_f2c44d73.stdout`·`.stderr`다.
같은 shell의 후속 인계 확인 스크립트는 처음에 UTF-8을 임의의 8192바이트에서 잘라 decode해 실패했다. RESULT 손상이 아니라 검사 스크립트의 경계 처리 문제였다.
typecheck는 재실행하지 않고 JSON 완료 계약의 바이트 구간을 먼저 추출하도록 검사만 고쳤으며, `ready`·빈 remaining/blockers·integration_checks와 계약 끝 위치 373바이트를 확인했다.

단위 35개는 dialog 16·기존 생성 16·전송 어댑터 3개다. 이후 제품·단위 소스 변경은 없고 E2E의 버튼 이름 literal과 RESULT만 바뀌었다.
초기 `e28dbdf`의 변경 없는 sidebar 23·layout 21개와 Rust `api` 20·`projects` 6개 성공 근거는 재사용했다. Rust·공통 상태·API를 다시 수정하지 않았으므로 Rust는 재실행하지 않았다.
빌드의 기존 chunk 크기·React Router future flag 경고는 남아 있다. 기능 실패로 숨기거나 관련 없는 코드를 수정하지 않았다.

### 후속 완료·통합 경계

실제 Chrome desktop project에서 1440px·390px 각각 원래 생성 진입 3개 시나리오를 통과했다.
첫 시나리오에 정/역방향 focus containment, Escape·취소 후 머리글 복원, 프로젝트 추가 modal 전환·입력 autofocus·취소 복원을 더했고 기존 초안·프로젝트 맥락·폭 변경·중복 클릭 검증을 보존했다.
응답 유실은 실제 서버 처리 후 transport abort로 재현해 원래 키 재확인 및 단일 자원 결과를 검증했다. `project-add`·`project-clone`의 기존 실제 폴더/clone 흐름도 통과했다.
소유 범위의 실행 가능한 잔여·blocker는 없다. 27의 동시 변경과 결합한 통합 인수 및 공통 sidebar·경로 복구·responsive 회귀는 완료 계약의 `integration_checks`에 남겼다.
아래 초기 인계는 진입점 조사와 과거 실패 이력 보존용이며, 최신 브라우저 결과는 이 후속 절이 우선한다.

## 작업 식별·상태

- Worktree: `<세션 worktree 루트>/b02-22-create-entry`
- Branch: `parallel/b02-create-entry`
- 공통 기준 SHA: `7b3949d24e420d09e6e4cde29405414b2d99253a`
- 상태: 초기 구현·승인된 focus 결함 후속 종료. 배정된 세 spec의 실제 브라우저 8개 통과. 다른 기능 결합·공통 경계의 통합 인수는 위 완료 계약에 남김.
- `<원본 저장소>/work/ENTRY.md`, `<원본 저장소>/work/COMMON.md`, `<원본 저장소>/work/22.md` 기준으로 작업했다.
- 서버·API·store·의존성/lockfile·TODO·메인 checkout 소스는 수정하지 않았다. merge/push/배포·세션 연락·위임·workspace 제거도 하지 않았다.

## 진입점 조사와 최종 경로

| 위치·조건 | 기존 결과 | 처리·이유 | 최종 결과 |
|---|---|---|---|
| `web/app/components/Workspace.tsx` 머리글 `+ 프로젝트` | `AddProjectDialog`를 바로 표시 | 기존 독립 버튼 제거, 단일 `만들기`로 교체. 세션과 프로젝트의 출발점을 한곳에 모음 | 현재 프로젝트가 있으면 해당 프로젝트의 새 대화 안내, 없으면 프로젝트 선택. 같은 창에서 `프로젝트 추가` 선택 가능 |
| 머리글에서 프로젝트 맥락이 있는 경우 | 세션 생성용 머리글 진입 없음 | 프로젝트를 다시 고르거나 임의의 다른 프로젝트로 전환하지 않음 | `이 프로젝트에서 새 대화`가 기존 프로젝트 탭·입력창을 재사용. 창을 연 뒤 화면 폭이 바뀌어도 최초 프로젝트 맥락 유지 |
| 사이드바 프로젝트 이름 | 프로젝트 화면·입력창 열기 | 탐색·기록·경로 복구에 필요하므로 유지 | 기존 탐색 동작 유지. 프로젝트 경로가 없어도 복구 화면에 접근 가능 |
| 사이드바 프로젝트별 도구 | 세션 생성 전용 버튼 없음 | 프로젝트 맥락을 명확히 하는 `새 대화` 한 버튼 추가. 별도 생성 폼이나 POST를 만들지 않음 | 머리글과 같은 `startProject`로 기존 프로젝트 탭·입력창에 초점 이동. 좁은 화면에서는 사이드바 닫힘 |
| 사이드바 프로젝트의 오른쪽·아래 열기 | 프로젝트 화면을 명시적으로 분할 | 배치 조작이므로 유지. 자원 생성 버튼으로 취급하지 않음 | 기존 독립 입력 사본·분할 동작 유지, 좁은 화면에서는 계속 숨김 |
| `web/app/components/ProjectView.tsx` 입력창 | 첫 전송에서 세션 생성 후 메시지 저장 또는 턴 실행 | 유일한 세션 생성 UI로 유지, `create/ProjectComposer.tsx`로 기존 어댑터 이동. 빈 세션 생성 폼은 추가하지 않음 | 모든 새 대화 진입이 이 입력창으로 연결. 진입·재진입·취소만으로 프로젝트/세션을 생성하지 않음 |
| `web/app/components/AddProject.tsx` 폴더 등록·새 마지막 폴더 만들기 | `POST /projects` | 기존 폴더 탐색·제안·등록 UI 유지 | 공유 생성 잠금·원래 키 재확인 적용 후 프로젝트 입력창 열기. 세션 자동 생성 없음 |
| 같은 창의 `저장소에서 clone` | 별도 busy/pending 처리로 `POST /projects/clone` | 저장소에서 가져오는 별도 입력 방식은 유지하되 중복된 생성·오류·재확인 처리 제거 | 폴더 등록과 같은 잠금·미확정 요청을 공유. 두 방식의 동시 생성 차단 |
| 프로젝트 추가 성공 | 새 프로젝트 화면 열기 | 유지. 추가 성공과 대화 생성을 구분 | 현재 표시 중인 폭별 배치에 프로젝트 화면 열기. 탭 한도에 걸려도 등록 창은 닫고 기존 notice로 열기 실패 알림 |

머리글 프로젝트 선택은 라벨 필터와 무관한 전체 활성 프로젝트 목록을 사용한다.
현재 프로젝트가 목록에서 사라졌거나 조회 오류가 있으면 다른 프로젝트를 자동 선택하지 않는다.
경로가 없는 프로젝트의 생성 선택은 비활성화하고, 기존 탐색·경로 재연결은 보존했다.

## 제공 계약·연결

| Export·연결 | 입출력·동작 |
|---|---|
| `create/creation.ts`: `currentProjectId(layout?)` | 현재 focused pane의 활성 탭 `project_id`만 반환. 전역 화면·빈 배치는 `undefined` |
| `create/creation.ts`: `projectTarget(project)` | 기존 `Opener`와 `layout.openResource`가 받는 프로젝트 target 반환 |
| `create/creation.ts`: `ProjectCreation.run(path, body)` | `/projects` 또는 `/projects/clone`만 사용. `Promise<Project \| undefined>`, 실행 중 중복 호출은 `undefined`로 억제. `busy`·`pending`은 UI 잠금·재확인에 사용 |
| `create/CreationEntry.tsx`: `CreationEntry` | `projects`, `currentId?`, `loading`, `error`, `onReload`, `onSelect`, `onAddProject`, `onClose`를 주입받는 선택 UI. 직접 mutation 없음 |
| 같은 파일의 `CreationFocus` | `{ tabId, narrow, version } \| null` context. 정확한 기존 탭과 표시 배치에만 입력 초점 요청 |
| `create/CreationDialog.tsx`: `CreationDialog` | `label`, `onClose`, `children`, `busy?`. native modal의 배경 차단에 명시적 Tab/Shift+Tab 순환을 더하고, Escape·취소와 기존 초점 복원 처리 |
| `create/ProjectComposer.tsx`: `ProjectComposer` | `projectId`, `tabId`, `open`, `disabled`. 원래 `Composer`와 `resourceKey=project:<id>`, `copyId=tabId`를 그대로 사용. `display: contents`로 기존 sticky 입력창의 배치 기준 보존 |
| `sidebar/index.tsx`: `SidebarProject.onCreate` | 신규 필수 callback, `Workspace`에서 실제 연결 완료. 기존 toolbar 방향키 동작·좁은 화면 규칙 유지 |
| `AddProjectDialog` | 기존 `onDone(Project)`·`onClose()` 외부 계약 유지. 비동기 성공은 최신 `onDone`을 사용해 화면 폭 변경 후 숨겨진 배치로 열리지 않도록 처리 |

추가 공통 파일 연결은 필요 없다. 서버 API·권한·idempotency는 기존 계약을 사용한다.

- 세션 생성은 원래 전송 키의 `${key}:session`, 메시지/턴은 `${key}:send`를 유지한다. 저장 방식·모델·agent·tools·effort·첨부 전달을 바꾸지 않았다.
- `Composer`의 동기 전송 잠금·기기 초안·미확정 요청 보관·명시적 재확인을 그대로 재사용한다. 프로젝트 탭 재사용은 기존 `layout.openResource` 계약을 따른다.
- 폴더 등록/clone은 한 `ProjectCreation` 객체를 공유한다. 실행 중 양쪽 폼과 닫기를 막는다. 네트워크 오류·5xx·408·`result_unknown`이면 원래 본문·키를 유지하고 전용 재확인만 허용한다. 본문 필드 순서는 같은 요청의 충돌로 취급하지 않는다.
- 명확한 4xx 오류는 자동 재전송하지 않고 잠금을 풀어 수정할 수 있게 한다. API 오류 문구는 `role=alert`, 진행·미확정 안내는 status로 표시한다.
- 기존 `Composer`를 사용하므로 TTS와 마이크 차단은 변경하지 않았다. 녹음·음성 입력·STT는 추가하지 않았다.
- 새 애니메이션은 넣지 않았다. 초점 이동·오류·재확인에 불필요한 지연을 더하지 않았다.

## 변경 소유 파일

- `web/app/components/Workspace.tsx` 생성 버튼·선택 상태·공통 생성 경로 연결
- `web/app/components/AddProject.tsx` 생성 잠금·공통 modal·폴더/clone 처리 통합
- `web/app/components/ProjectView.tsx` 세션 생성 어댑터 추출·기존 입력창 연결
- `web/app/components/sidebar/index.tsx` 프로젝트별 새 대화 callback
- `web/app/components/create/creation.ts`
- `web/app/components/create/CreationEntry.tsx`
- `web/app/components/create/CreationDialog.tsx`
- `web/app/components/create/ProjectComposer.tsx`
- `web/app/components/create/create.css`
- `web/app/components/create/creation.test.ts`
- `web/app/components/create/projectComposer.test.ts`
- `web/e2e/create-entry.spec.ts`
- `web/e2e/project-add.spec.ts`, `web/e2e/project-clone.spec.ts`: 변경된 생성 진입·오류 표시 위치 locator만 수정, 기존 시나리오 기대 유지
- `work/RESULT-22.md`

## 초기 e28dbdf 단계 검증 이력

모든 명령은 이 worktree에서 실행했다. 공통 환경은 `source <원본 저장소>/.envrc.dev`를 적용했다.
`web/node_modules`는 승인된 `<원본 저장소>/web/node_modules`의 ignored symlink로 연결했다.

| 명령·입력 | 실제 결과 |
|---|---|
| `python3 scripts/build.py test --vitest app/components/create/creation.test.ts app/components/create/projectComposer.test.ts app/components/sidebar/sidebar.test.ts app/state/layout.test.ts --typecheck` | 최종 타입 검사 성공, 4파일 63개 통과: 생성 16·전송 어댑터 3·sidebar 23·layout 21 |
| 위 명령 최초 실행 | 신규 시험의 `effort`가 `string`으로 추론되어 `TS2345` 실패. 이때 Vitest는 미실행. `"high" as const`로 fixture 타입을 고친 뒤 재실행 성공. 최종 63개 결과는 이후 동등 본문 필드 순서 회귀도 포함 |
| `python3 scripts/build.py test --typecheck` | 프로젝트 맥락 고정·최신 완료 callback 연결 후 별도 성공. 이후 최종 묶음에서도 다시 성공 |
| `flock /home/ubuntu/.cache/grove-rust-check.lock python3 scripts/build.py test --rust projects api` | 최초 시도 취소, exit 137. 빌드 실행기가 source한 환경을 worktree `.dev`로 덮어써 없던 툴체인을 자동 설치하고 crates를 내려받는 것을 확인해 중단. 검사 통과로 계산하지 않음 |
| `CARGO_NET_OFFLINE=true RUSTUP_AUTO_INSTALL=0 flock /home/ubuntu/.cache/grove-rust-check.lock python3 scripts/build.py test --rust projects api` | 환경 연결 수정 후 성공. 컴파일 포함 `api` 20개·`projects` 6개, 총 26개 통과. 인증·idempotency 재현/충돌·프로젝트 검증·세션/메시지·폴더 생성·경로 복구 계약 포함 |
| `git diff --check` | 성공 |
| 초기 E2E·웹 production build·전체 회귀·release·실기기 | 초기 단계에서는 미실행. 승인된 후속에서 실제 debug·web build 및 배정 E2E 8개를 실행·통과했다. 전체 회귀·release·실기기는 여전히 미실행 |

Rust 환경 복구에서 처음 자동 생성된 이 작업 소유의 로컬 `.dev`·`target`만 제거했다.
이후 ignored `.dev` symlink를 `<원본 저장소>/.dev`로 연결해 기존 툴체인·cache를 재사용했다.
성공한 재시도는 네트워크와 툴체인 자동 설치를 금지한 환경으로 실행했다. 의존성 버전·lockfile·빌드 실행기 소스는 바꾸지 않았다.
Rust 시험 서버는 `tests/common/mod.rs`의 `tempfile::TempDir`, loopback 임의 포트·해당 임시 data/project 경로를 사용한다.

## UI-005 요구별 근거·미충족

| 요구 | 구현·확인 근거 | 남은 확인 |
|---|---|---|
| 생성 진입점 통합·중복 UI 제거 | 기존 머리글 단독 프로젝트 버튼을 `만들기`로 교체, 세션 생성 입력창 단일화, 폴더/clone mutation 처리 통합. 후속의 실제 브라우저 진입점 검증 통과 | 다른 기능 결합 후 통합 인수 |
| 현재 프로젝트 맥락·없으면 선택 | focused 활성 탭만 조회, 생성 창 시작 시 맥락 고정, 누락/오류 시 자동 전환 금지. 단위·폭 변경 E2E 통과 | 공통 responsive 회귀 |
| 중복 클릭·응답 유실 시 중복 자원 없음 | 공유 생성 잠금·원래 요청 키 재확인·기존 Composer 전송 잠금, 단위 생성/전송 계약·Rust idempotency 및 실제 브라우저 transport abort 후 단일 자원 확인 통과 | 다른 기능 결합 후 통합 인수 |
| 접근성·좁은 화면 | 명시적 Tab 순환·초점 복원·명시적 이름·상태/오류 안내·기존 toolbar·표시 배치별 초점 대상 제한. 1440px·390px 실제 Chrome 키보드 검증 통과 | 공통 sidebar 회귀·실제 스크린리더/실기기 수동 확인 |
| 기존 API·권한·초안·TTS/마이크 차단 보존 | 서버/API/store/Composer 불변, 전송 payload·키·첨부 단위 검증, 기존 서버 계약 회귀 성공 | TTS 실기기 등은 이번 범위에서 미검증 |

`web/e2e/create-entry.spec.ts`는 1440px·390px 각각 다음 세 시나리오, 총 6개를 후속에서 실제 실행·통과했다.

1. 머리글의 프로젝트 선택·맥락 유지·폭 변경·modal Tab/Escape/초점 복원, 사이드바·프로젝트 입력창의 초안 재사용, 전송 전 생성 없음, 중복 클릭 후 프로젝트별 세션 수 확인.
2. 세션 생성의 실제 서버 처리 뒤 응답을 transport abort하고 원래 키로 재확인해 세션·메시지가 하나인지 확인.
3. 폴더 등록의 실제 서버 처리 뒤 응답을 transport abort하고 clone·닫기 차단 및 원래 키 재확인, 프로젝트 하나·빈 세션 없음 확인.

## 통합 단계·잔여 위험

소유 범위의 blocker는 없고 배정된 E2E도 실행·통과했다. **다른 기능과 결합한 UI-005 최종 통합 인수는 별도다**. TODO는 수정하지 않았다.
통합 checkout에서는 위 완료 계약의 공통 경계와 27 결합 후 생성 진입을 직렬 인수해야 한다.

```bash
source <원본 저장소>/.envrc.dev
flock /home/ubuntu/.cache/grove-rust-check.lock python3 scripts/build.py test --e2e e2e/create-entry.spec.ts e2e/sidebar-status.spec.ts e2e/project-recovery.spec.ts e2e/responsive-panes.spec.ts
```

native dialog의 실제 초점·화면 폭 변경·브라우저 transport abort 시나리오는 후속의 실제 debug 서버·Chrome 결과를 근거로 한다. 별도 통합 인수·실제 스크린리더/실기기 검증까지 완료했다고 확대하지 않는다.
폴더 등록/clone 미확정 요청은 열린 창의 메모리에 유지한다. 명시적 결과 확인 전 닫기를 막지만 브라우저 reload/종료 뒤 요청 키의 영속 복구는 제공하지 않는다. 기존 clone에도 없던 새로고침 복구 기능을 이번 범위에서 추가하지 않았다.
