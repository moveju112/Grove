# b02 / 22 — UI-005 생성 진입점 통합

## 작업 식별·상태

- Worktree: `/home/ubuntu/.local/share/paseodog/paseo/worktrees/0q796rug/b02-22-create-entry`
- Branch: `parallel/b02-create-entry`
- 공통 기준 SHA: `7b3949d24e420d09e6e4cde29405414b2d99253a`
- 상태: 구현 종료, 통합 E2E 검증 대기. 타입 검사·선택 웹 단위 63개·Rust 계약 26개 통과. 브라우저 인수 조건은 아직 충족했다고 보고하지 않는다.
- `/data/project/paseodog_opus/work/ENTRY.md`, `/data/project/paseodog_opus/work/COMMON.md`, `/data/project/paseodog_opus/work/22.md` 기준으로 작업했다.
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
| `create/CreationDialog.tsx`: `CreationDialog` | `label`, `onClose`, `children`, `busy?`. native modal dialog로 배경 조작·Tab 이탈 방지, Escape·취소와 기존 초점 복원 처리 |
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

## 실제 검증

모든 명령은 이 worktree에서 실행했다. 공통 환경은 `source /data/project/paseodog_opus/.envrc.dev`를 적용했다.
`web/node_modules`는 승인된 `/data/project/paseodog_opus/web/node_modules`의 ignored symlink로 연결했다.

| 명령·입력 | 실제 결과 |
|---|---|
| `python3 scripts/build.py test --vitest app/components/create/creation.test.ts app/components/create/projectComposer.test.ts app/components/sidebar/sidebar.test.ts app/state/layout.test.ts --typecheck` | 최종 타입 검사 성공, 4파일 63개 통과: 생성 16·전송 어댑터 3·sidebar 23·layout 21 |
| 위 명령 최초 실행 | 신규 시험의 `effort`가 `string`으로 추론되어 `TS2345` 실패. 이때 Vitest는 미실행. `"high" as const`로 fixture 타입을 고친 뒤 재실행 성공. 최종 63개 결과는 이후 동등 본문 필드 순서 회귀도 포함 |
| `python3 scripts/build.py test --typecheck` | 프로젝트 맥락 고정·최신 완료 callback 연결 후 별도 성공. 이후 최종 묶음에서도 다시 성공 |
| `flock /home/ubuntu/.cache/grove-rust-check.lock python3 scripts/build.py test --rust projects api` | 최초 시도 취소, exit 137. 빌드 실행기가 source한 환경을 worktree `.dev`로 덮어써 없던 툴체인을 자동 설치하고 crates를 내려받는 것을 확인해 중단. 검사 통과로 계산하지 않음 |
| `CARGO_NET_OFFLINE=true RUSTUP_AUTO_INSTALL=0 flock /home/ubuntu/.cache/grove-rust-check.lock python3 scripts/build.py test --rust projects api` | 환경 연결 수정 후 성공. 컴파일 포함 `api` 20개·`projects` 6개, 총 26개 통과. 인증·idempotency 재현/충돌·프로젝트 검증·세션/메시지·폴더 생성·경로 복구 계약 포함 |
| `git diff --check` | 성공 |
| E2E·웹 production build·전체 회귀·release·실기기 | 미실행. COMMON의 독립 작업 단계 정책에 따라 통합 단계로 이월. E2E 소스는 최종 typecheck 대상에 포함됐지만 브라우저 실행을 대신하지 않음 |

Rust 환경 복구에서 처음 자동 생성된 이 작업 소유의 로컬 `.dev`·`target`만 제거했다.
이후 ignored `.dev` symlink를 `/data/project/paseodog_opus/.dev`로 연결해 기존 툴체인·cache를 재사용했다.
성공한 재시도는 네트워크와 툴체인 자동 설치를 금지한 환경으로 실행했다. 의존성 버전·lockfile·빌드 실행기 소스는 바꾸지 않았다.
Rust 시험 서버는 `tests/common/mod.rs`의 `tempfile::TempDir`, loopback 임의 포트·해당 임시 data/project 경로를 사용한다.

## UI-005 요구별 근거·미충족

| 요구 | 구현·확인 근거 | 남은 확인 |
|---|---|---|
| 생성 진입점 통합·중복 UI 제거 | 기존 머리글 단독 프로젝트 버튼을 `만들기`로 교체, 세션 생성 입력창 단일화, 폴더/clone mutation 처리 통합 | 실제 브라우저에서 전체 경로 확인 |
| 현재 프로젝트 맥락·없으면 선택 | focused 활성 탭만 조회, 생성 창 시작 시 맥락 고정, 누락/오류 시 자동 전환 금지. 단위 검증 | 폭 변경을 포함한 E2E |
| 중복 클릭·응답 유실 시 중복 자원 없음 | 공유 생성 잠금·원래 요청 키 재확인·기존 Composer 전송 잠금, 단위 19개 생성/전송 계약 및 Rust idempotency 회귀 | 브라우저 실제 중복 클릭·응답 유실 후 자원 수 확인 |
| 접근성·좁은 화면 | native modal·명시적 이름·상태/오류 안내·기존 toolbar·폭별 배치에 대한 초점 대상 제한 | 실제 키보드·스크린리더 및 좁은 화면 브라우저 확인 |
| 기존 API·권한·초안·TTS/마이크 차단 보존 | 서버/API/store/Composer 불변, 전송 payload·키·첨부 단위 검증, 기존 서버 계약 회귀 성공 | TTS 실기기 등은 이번 범위에서 미검증 |

신규 `web/e2e/create-entry.spec.ts`는 1440px·390px 각각 다음 세 시나리오, 총 6개를 작성했다.

1. 머리글의 프로젝트 선택·맥락 유지·폭 변경·modal Tab/Escape/초점 복원, 사이드바·프로젝트 입력창의 초안 재사용, 전송 전 생성 없음, 중복 클릭 후 프로젝트별 세션 수 확인.
2. 세션 생성의 실제 서버 처리 뒤 응답을 transport abort하고 원래 키로 재확인해 세션·메시지가 하나인지 확인.
3. 폴더 등록의 실제 서버 처리 뒤 응답을 transport abort하고 clone·닫기 차단 및 원래 키 재확인, 프로젝트 하나·빈 세션 없음 확인.

## 통합 단계·잔여 위험

핵심 구현 blocker는 없지만 **E2E 미실행으로 UI-005 최종 인수는 남아 있다**. TODO는 수정하지 않았다.
통합 checkout에서 E2E를 직렬로 실행하고 결과를 확인한 뒤 완료 여부를 판단해야 한다.

```bash
source /data/project/paseodog_opus/.envrc.dev
flock /home/ubuntu/.cache/grove-rust-check.lock python3 scripts/build.py test --e2e e2e/create-entry.spec.ts e2e/project-add.spec.ts e2e/project-clone.spec.ts e2e/sidebar-status.spec.ts e2e/project-recovery.spec.ts e2e/responsive-panes.spec.ts
```

native dialog의 실제 초점·화면 폭 변경·브라우저 transport abort 시나리오는 소스/타입·단위 검증만으로 통과했다고 간주하지 않는다.
폴더 등록/clone 미확정 요청은 열린 창의 메모리에 유지한다. 명시적 결과 확인 전 닫기를 막지만 브라우저 reload/종료 뒤 요청 키의 영속 복구는 제공하지 않는다. 기존 clone에도 없던 새로고침 복구 기능을 이번 범위에서 추가하지 않았다.
