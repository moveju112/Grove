<!-- grove-handoff:v1
{"state":"ready","remaining":[],"blockers":[],"integration_checks":["수정 통합 candidate에서 e2e/settings-links.spec.ts 및 e2e/workspace.spec.ts:319, e2e/workspace.spec.ts:799, e2e/workspace.spec.ts:807 선택 인수"]}
-->

# 37 — 비동기 설정 직접 링크

## 통합 실패 후속 — 현재 인계

- 재개 기준은 `43cf9add981931f74c5665ed0a402e57f31b4a0a`다. 같은 worktree·branch에서 clean 시작했고 기준 변경·merge·rebase·다른 checkout 편집은 없다.
- worktree: `<세션 worktree 루트>/b02-37-settings-links`, branch: `parallel/b02-settings-links`.
- 상태: 기존 브랜치에서 자기 결함을 재현·수정하고 소유 선택 인수를 완료했다. blocker는 없다. 고정 candidate 자체는 수정하거나 재검증한 것으로 주장하지 않으며, 수정 통합 후 인수는 위 `integration_checks`에 남겼다.
- 별도 분할 생성 시 초안 수명 문제는 **work 49 소유**다. 이번 변경·잔여·blocker에 포함하지 않는다.

### 통합 실패와 원인 재현

고정 candidate `ee8173cf9a4e5dc52b1d4d534202adc3e0aac0a9`의 `/home/ubuntu/.cache/grove-validation/validation-52_pbv0g/output.log` 전체와 `/home/ubuntu/.cache/grove-validation/validation-52_pbv0g/checkout/web/test-results/settings-links-실행-설정의-지연된-행도-전용-영역-안에서-직접-링크로-드러난다-desktop/error-context.md` 전체를 읽었다.
원래 결과는 Rust 10개·Vitest 7개·typecheck·E2E 첫 4개 통과, exec viewport 실패 1개, 후속 E2E 10개 미실행, job exit 1이다. 이 실패를 이후 통과로 덮어쓰지 않는다.

수정 전 브랜치에서 `python3 scripts/build.py test --e2e settings-links.spec.ts:144` 단독 실행은 통과했다.
근거: `<실행 로그>/shell_848a56b0.stdout`, `<실행 로그>/shell_848a56b0.stderr`.
branch와 candidate의 reveal/useSettingsLink/ExecSettings/공통 app.css/전용 E2E는 bytes가 같았다. Settings의 차이는 PWA 버튼·업데이트·fallback 공존이며 ScopedSettings는 저장 버튼의 ServerActionButton 래퍼 차이였다. 그 차이만으로 원인을 단정하지 않았다.

같은 브랜치에서 실제 Definitions 응답도 별도로 보류하는 결정적 fixture로 바꾸고, 제품 수정 전 같은 명령을 실행하자 실패했다.
effective 응답을 해제하면 exec 행에 scrollIntoView가 한 번 실행되고 viewport 안에 있었지만, 그 앞쪽 Definitions 응답을 나중에 해제·렌더하자 동일한 `viewport ratio 0`이 발생했다.
진단 기록은 행 top `5721.78125`에서 scroll 직후 `440.78125`, 다음 frame `373.28125`, pane scrollTop `5281`, pane clientHeight `744`였고, 이후 Definitions 렌더 뒤 최종 viewport 검사가 실패했다.
근거: `<실행 로그>/shell_4806ee8f.stdout`, `<실행 로그>/shell_4806ee8f.stderr` (exit 1).
즉 기존 행 준비 신호는 **앞쪽 비동기 내용의 높이 준비**를 보장하지 않았다. 통합에서만 발생하는 경계가 아니라 브랜치에서도 재현한 결함이다. candidate 내부의 정확한 응답 순서까지 관측했다고 주장하지 않는다.

### 수정과 계약

| 소유 변경 경로 | 내용 |
| --- | --- |
| `web/app/components/Settings.tsx` | exec 링크에만 앞쪽 조회 준비를 연결하고, 그 전에는 최초 행 준비 신호 소비를 보류 |
| `web/app/components/settings-links/useExecLinkLayout.ts` | 기존 viewer와 같은 query key·fetcher 계약으로 앞쪽 내용의 준비를 구독 |
| `web/app/components/settings-links/useExecLinkLayout.test.ts` | 초기/진행/재조회 보류, 오류 종료, MCP 미지원, 프로젝트 cache 및 비활성 구독 검증 5개 |
| `web/e2e/settings-links.spec.ts` | effective·Definitions 응답을 독립 보류/해제, 최종 viewport와 이후 재조회 시 사용자 scrollTop 유지; context/exec 두 pane의 초안·고정 대상 검증 |
| `work/RESULT-37.md` | 이 후속 인계와 이전 기록 보존 |

`useExecLinkLayout(active, projectId, mcpSupported): boolean`은 `definitions:agent`, 프로젝트별 `source-settings`, `hooks:global`, `profiles`, 지원되는 MCP의 `mcp`/`secrets`가 완료될 때만 true다.
기존 `useQuery`의 같은-key 요청 공유를 재사용하며 새로운 API·서버·dependency·공통 state는 만들지 않았다. 원본 설정 조회는 기존 `getSourceSettings`, hook 경로는 기존 `hookPath`를 사용한다.
준비 상태를 부모가 함께 구독하므로 준비 완료 render에서 앞쪽 viewer 내용도 commit된 다음 자식 행의 layout effect가 한 번 이동한다.
다른 영역의 조회 오류는 그 영역의 기존 오류 화면이 렌더되는 종료 상태다. target effective 오류/행 누락은 보류하지 않고 기존 링크 오류 종료로 전달한다. 오류를 숨기거나 무한 재시도하지 않는다.
링크 완료·취소 시 추가 query 구독은 해제된다. 반복 observer/listener·타이머·재이동은 없다.
기존 root 검증·키 검증·일회성 소비·scope 변경/unmount 정리는 불변이다. 저장·revision·범위 선택·복원·권한 계약도 바꾸지 않았다.
Profiles·Definitions·업데이트/MCP mount·공통 CSS·서버·API client·TODO·공유 환경·runtime 설정은 수정하지 않았다.
진단용 브라우저 prototype 관측 코드는 제거했고, 최종 시험에는 응답 보류/해제와 실제 viewport 기대가 남는다. 임의 sleep·retry·scrollIntoViewIfNeeded는 없다.

### 검증 명령·유효 입력

아래는 모두 같은 worktree에서 `source <원본 저장소>/.envrc.dev` 후 실행했다. 모든 E2E 전체 명령은 `flock /home/ubuntu/.cache/grove-rust-check.lock`으로 직렬화했고 실행기가 현재 debug 서버와 웹을 빌드했다. 실제 사용자 설정 대신 disposable E2E 서버/DB만 사용했다.

```bash
python3 scripts/build.py test --typecheck --vitest app/components/settings-links/useExecLinkLayout.test.ts
flock /home/ubuntu/.cache/grove-rust-check.lock python3 scripts/build.py test --e2e settings-links.spec.ts workspace.spec.ts:319 workspace.spec.ts:799 workspace.spec.ts:807
flock /home/ubuntu/.cache/grove-rust-check.lock python3 scripts/build.py test --e2e settings-links.spec.ts:87
python3 scripts/build.py test --typecheck
```

| 실행 근거 | 실제 결과·실행기 wall / CPU |
| --- | --- |
| `<실행 로그>/shell_48f8ebe0.stdout`, `<실행 로그>/shell_48f8ebe0.stderr` | 신규 Vitest 5개 통과, 2.18s / 2.43s. 당시 typecheck 통과, 14.03s / 14.84s |
| `<실행 로그>/shell_3c5577f4.stdout`, `<실행 로그>/shell_3c5577f4.stderr` | 소유 E2E 13개 통과, 10.24s / 9.72s. 서버 빌드 2.45s / 0.36s, 웹 빌드 3.48s / 4.97s |
| `<실행 로그>/shell_4ae99ff8.stdout`, `<실행 로그>/shell_4ae99ff8.stderr` | 다중 pane 시나리오를 context/exec로 확장한 뒤 해당 2개 통과, 4.29s / 4.17s. 서버 빌드 2.95s / 0.3s, 웹 빌드 3.44s / 5.04s |
| `<실행 로그>/shell_5d7cb3c9.stdout`, `<실행 로그>/shell_5d7cb3c9.stderr` | 마지막 시험 변경 이후 최종 typecheck 통과, 8.41s / 12.24s |

두 브라우저 통과 실행 사이 제품 변경은 없고, 산출물은 모두 `app-DVSWb5ck.js`, SW `4c39891ff61424c5`였다.
13개 통과 실행 이후에는 다중 pane 시험만 context/exec 두 경우로 확장했다. 그 시험을 제외한 나머지 12개의 제품·helper·시험 본문은 그대로여서 재사용했고, 변경/추가한 다중 pane 2개만 다시 실행했다. 따라서 현재 고유 소유 시나리오는 **14개 통과**이며, 한 번에 14개를 실행했다고 표현하지 않는다.
현재 exec 지연 시험 위치는 `web/e2e/settings-links.spec.ts:147`, 다중 pane 두 경우는 `web/e2e/settings-links.spec.ts:87`이다.
통합에서 미실행됐던 소유 후속 10개도 위 13개 실행에 모두 포함되어 통과했다. 공통 Settings 링크 연결을 바꿨으므로 영향받는 앞선 소유 2개도 확인했다.
이후 변경은 RESULT뿐이다. `git diff --check`도 통과했다.

통합에서 이미 통과한 Rust agent_policy/settings_reset 10개, 기존 reveal/ExecSettings Vitest 7개, agent-policy E2E 2개의 근거는 보존했다. 이번 변경은 그 Rust·기존 단위 시험·agent-policy 동작을 바꾸지 않아 반복하지 않았다. 최초 인계의 store 단위 통과도 보존했다.
전체 workspace·전체 회귀·mobile·다른 플랫폼은 미선택이다. React Router future 및 큰 chunk 경고는 기존대로 남는다.
공유 잠금 대기 시간과 실제 실행기 wall/CPU 시간은 다르며 여기서 절감량을 추정하지 않았다.
SETTINGS-021의 실행 가능한 소유 잔여는 없다. 수정 통합 candidate에서 viewport 인수를 마친 뒤 최종 TODO 판단은 통합 담당이 한다.

## 이하 `43cf9ad` 시점 최초 인계 — 기존 근거 보존

- 상태: 소유 구현·연결·선택 브라우저 인수 완료. SETTINGS-021 통합 완료 후보이며 TODO는 수정하지 않았다.
- worktree: `<세션 worktree 루트>/b02-37-settings-links`
- branch: `parallel/b02-settings-links`
- 고정 기준: `292cf1aff5305b4c039613dfd4266f416cef5f03`. 시작 HEAD 일치·clean 확인. 기준 변경·merge·rebase 없음.
- 정본: `<원본 저장소>/work/ENTRY.md`, `<원본 저장소>/work/COMMON.md`, `<원본 저장소>/work/37.md`.

## 제공 동작과 소유 경계

| 경로 | 변경 |
| --- | --- |
| `web/app/components/Settings.tsx` | 직접 링크 준비·메뉴/고급 펼침 연결, 현재 인스턴스 root, 로컬 링크 활성화·사용자 조작 시 취소, 대기/오류 표시 |
| `web/app/components/ScopedSettings.tsx` | effective 조회 후 commit된 행의 준비 신호, 로컬 anchor 조회와 `data-setting-key` |
| `web/app/components/exec-settings/ExecSettings.tsx` | 기존 ScopedSettings에 링크 준비 props 전달만 추가 |
| `web/app/components/settings-links/reveal.ts` | 안전한 hash decode, 인스턴스·키 확인과 일회성 이동/취소 |
| `web/app/components/settings-links/useSettingsLink.ts` | 링크 요청의 준비·완료·오류·scope 변경·unmount 정리 |
| `web/app/components/settings-links/reveal.test.ts` | decode, 다른 pane/키, 일회성 소비, 취소, 누락/분리/숨김 검증 |
| `web/e2e/settings-links.spec.ts` | 지연 응답·다중 pane·초안/대상·exec·검색/닫기·실패·잘못된 링크의 전용 인수 |
| `work/RESULT-37.md` | 이 인계 |

기존 50ms 타이머와 전역 `document.querySelector` 분기는 제거했다.
registry로 메뉴와 고급 펼침을 준비한 다음, 해당 ScopedSettings의 effective 조회가 끝나고 실제 행이 commit된 시점에만 이동한다.
키를 CSS selector에 보간하지 않는다. 현재 Settings root가 포함하는 정확한 `data-setting-key` 행만 소비한다.
이동은 `block: "center", inline: "nearest", behavior: "instant"`로 한 번만 수행한다.
완료 뒤 준비 props를 해제하고, 새 조회·재렌더가 사용자 스크롤을 다시 이동시키지 않는다.
observer·타이머·전역 hashchange/scroll listener를 설치하지 않는다.
검색·메뉴·pointer/keyboard/wheel/touch 조작으로 대기 요청을 취소한다.

초기 hash는 Settings mount 시 읽는다. 렌더된 항목의 링크 클릭/Enter 활성화는 해당 Settings에서만 처리하고 주소 hash를 갱신한다.
다른 pane에 전역 hash 이벤트를 방송하지 않는다. 새 링크 요청은 이전 요청을 취소한다.
scope ID 변경과 unmount도 이전 준비 신호를 폐기한다.
잘못된 URL 인코딩은 무시하고, registry에 없는 키·조회 오류·응답에서 빠진 행은 종료하며 성공으로 처리하지 않는다.
오류는 일반 문구로 표시하고 응답의 민감한 원문을 노출하지 않는다.

public 연결:
- `SettingLinkReady = (key: string, element: HTMLElement | null) => void`; `null`은 해당 키의 조회 오류/행 누락이다.
- `ScopedSettings`와 `ExecSettings`의 optional `linkedKey`, `onLinkReady`는 기존 호출자에 영향이 없다.
- `useSettingsLink(registry, scope, prepare)`는 root·현재 key·대기/오류와 open/cancel/ready를 제공한다. `prepare`는 지원 메뉴를 열 수 있는지 반환한다.
- 읽기 API는 기존 `GET /settings/registry`, 대상 고정 `GET /settings/effective?session_id=…` 또는 `project_id=…`를 그대로 사용한다.
- 인증·권한·mutation·revision·범위 선택·기본값 복원 계약은 변경하지 않았다. 새 서버/API/store 연결은 필요 없다.

Profiles, Definitions, 업데이트/MCP mount, 공통 CSS, 서버, dependency/lockfile, TODO는 수정하지 않았다.
추가 애니메이션은 도입하지 않았고, 자동 이동도 smooth animation 없이 끝난다.
사용자의 최신 금지에 따라 runtime 설정은 변경하지 않았다. 문서의 `settings.features.fast=false` 변경 절차도 실행하지 않았다.
TTS·재생·마이크·STT 경로를 사용하거나 변경하지 않았다.

## 실제 검증

모든 명령은 이 worktree에서 `source <원본 저장소>/.envrc.dev` 후 실행했다.
E2E 명령 전체는 `flock /home/ubuntu/.cache/grove-rust-check.lock`으로 직렬화했다.
프로젝트 실행기가 빌드한 debug 서버·현재 웹 산출물, Chrome desktop, `GROVE_E2E_FAST=1`을 사용했다.
설정 저장은 매 실행이 생성한 disposable E2E 서버/DB에서만 수행했다.

### 원인 재현

1. `python3 scripts/build.py test --e2e workspace.spec.ts:799`: 변경 전 원래 시험 1개 통과. 이전 실패가 무조건 재현된다고 주장하지 않는다.
   근거: `<실행 로그>/shell_ecbcd92c.stdout`, `<실행 로그>/shell_ecbcd92c.stderr`.
2. 제품 코드 변경 전 `python3 scripts/build.py test --e2e settings-links.spec.ts:50`: 실제 upstream effective 응답을 보류하고, 가상 시계로 1초 진행 후 응답을 해제했다. 행은 생겼지만 `toBeInViewport`가 `viewport ratio 0`으로 실패했다.
   근거: `<실행 로그>/shell_49cff7cf.stdout`, `<실행 로그>/shell_49cff7cf.stderr`.
   이것으로 실제 행이 없을 때 50ms 처리와 링크 상태 폐기가 먼저 끝나는 경계를 확정했다. 실시간 sleep·반복 retry·시험의 scrollIntoView 우회는 사용하지 않았다.

### 유효한 통과 근거

```bash
source <원본 저장소>/.envrc.dev
python3 scripts/build.py test --vitest app/components/settings-links/reveal.test.ts app/components/exec-settings/ExecSettings.test.ts app/state/store.test.ts --typecheck
```

3파일 12개 Vitest 통과. typecheck 통과.
근거: `<실행 로그>/shell_138ca80c.stdout`, `<실행 로그>/shell_138ca80c.stderr`.
실행기 기록: typecheck wall 13.24s / CPU 12.15s, Vitest wall 1.46s / CPU 2.87s.
이후 제품·단위 시험·store·ExecSettings 입력은 변경하지 않았다.

```bash
source <원본 저장소>/.envrc.dev
flock /home/ubuntu/.cache/grove-rust-check.lock python3 scripts/build.py test --e2e settings-links.spec.ts workspace.spec.ts:319 workspace.spec.ts:799 workspace.spec.ts:807
```

첫 번째 전용 시나리오(지연 렌더 후 viewport 진입·저장 이벤트에 따른 재조회 후 사용자 scrollTop 유지)는 통과했다.
이 실행 전체는 아래 fixture 오류로 실패했으므로 전체 통과 근거로 사용하지 않는다.
근거: `<실행 로그>/shell_5840f612.stdout`, `<실행 로그>/shell_5840f612.stderr`.
해당 첫 시나리오 본문·공유 helper·제품 입력은 이후 그대로다. 변경은 다른 시나리오와 미사용 import 제거뿐이다.

```bash
source <원본 저장소>/.envrc.dev
flock /home/ubuntu/.cache/grove-rust-check.lock python3 scripts/build.py test --typecheck --e2e settings-links.spec.ts:86 settings-links.spec.ts:144 settings-links.spec.ts:158 settings-links.spec.ts:175 settings-links.spec.ts:197 settings-links.spec.ts:217 workspace.spec.ts:319 workspace.spec.ts:799 workspace.spec.ts:807
```

나머지 12개 브라우저 시나리오, typecheck, debug 서버·웹 빌드 모두 통과했다.
근거: `<실행 로그>/shell_6182ac2d.stdout`, `<실행 로그>/shell_6182ac2d.stderr`.
실행기 기록: typecheck wall 20.63s / CPU 11.7s, 서버 빌드 wall 6.66s / CPU 0.33s, 웹 빌드 wall 3.53s / CPU 5.06s, E2E wall 10.22s / CPU 9.42s.
두 브라우저 통과 근거의 제품 bundle은 동일한 `app-D-wv8Rxa.js`, SW version은 `ff12594f34001fff`였다.
이후 변경은 이 인계 파일뿐이다.

따라서 소유 인수 13개는 첫 시나리오의 유효한 통과 1개와 마지막 실행의 12개 통과를 합친 것이다. 한 번의 13개 전체 통과로 표현하지 않는다.
기존 workspace 세 시나리오의 viewport·검색/정의 수정·복원·서버 적용값/고급 기본 접힘 기대는 삭제하거나 완화하지 않았다.
`git diff --check`도 통과했다.
Rust 코드는 변경하지 않았고 E2E 진입점에서 실제 Rust 서버를 컴파일했다. 별도 Rust 기능 시험, 전체 workspace/전체 회귀, mobile·다른 플랫폼은 미선택이다.
기존 React Router future 경고와 큰 JS chunk 경고는 남아 있다.

## 실패·복구와 범위 밖 제한

| 기록 | 실제 결과와 처리 |
| --- | --- |
| `<실행 로그>/shell_df5d228f.stdout`, `<실행 로그>/shell_df5d228f.stderr` | 최초 원래 시험 실행은 build.py의 worktree `.dev` 강제로 로컬 툴체인/크레이트 다운로드가 시작되어 중단했다(exit 137). 이 실행이 만든 `.dev`를 제거하고 main `.dev` symlink로 복구했다. lockfile 변경이나 dependency 추가/업그레이드는 없다. |
| `<실행 로그>/shell_ae0d2628.stdout`, `<실행 로그>/shell_ae0d2628.stderr` | `--e2e settings-links.spec.ts:48`은 선택 위치 오류로 `No tests found.` 실패. 실제 test 위치 `:50`으로 수정해 원인 재현을 수행했다. |
| `<실행 로그>/shell_5840f612.stdout` | 다중 pane fixture의 `getByRole("status")`가 다른 기존 status까지 잡아 strict locator 실패. 정확한 링크 대기 문구로 한정했다. 이때 첫 지연/재조회 시나리오는 통과했다. |
| `<실행 로그>/shell_b46dd8b2.stdout`, `<실행 로그>/shell_b46dd8b2.stderr` | 분할 전에 만든 초안이 분할 생성 뒤 `2007`에서 `2000`으로 사라지는 실패를 관측했다. 수정하지 않은 `web/app/components/SplitView.tsx::NodeView`는 leaf에서 split으로 바뀔 때 Settings 하위 트리를 remount한다. 최종 링크 fixture는 먼저 두 pane을 만든 후 초안을 작성해 링크 처리의 보존을 검증한다. |
| `<실행 로그>/shell_37d5a5ea.stdout`, `<실행 로그>/shell_37d5a5ea.stderr` | 고급 context 행이 session 범위를 지원한다는 잘못된 시험 기대가 실패했다. `src/settings.rs::registry`의 실제 `server/project` 계약에 맞춰 프로젝트 대상/범위를 검증하고, 별도로 `output.language`의 고정 대화 대상도 검증했다. 제품의 유효한 범위 로직은 바꾸지 않았다. |

분할 생성 자체의 remount를 넘어서는 초안 보존은 이번 링크 소유 범위의 완료 주장에 포함하지 않는다. 해당 상위 탐색 구조를 수정하려면 별도 소유권/작업이 필요하다.
안정된 두 pane에서 늦게 연 링크, 같은 pane의 링크 재활성화 동안 양쪽 초안·프로젝트/대화 대상은 보존됨을 실제 브라우저로 확인했다.
실행 중 session 목록 도구는 runtime의 `cross-session control is unavailable`로 조회할 수 없었다. 다른 세션/checkout 조작은 하지 않았다.
공유 환경은 main `.dev`와 `web/node_modules` symlink를 사용한다. 실제 사용자 설정·외부 서비스·runtime 설정은 변경하지 않았다.

## 통합 판단

SETTINGS-021의 기본 접힘/검색 접근, 지연된 실제 행 이동, 현재 pane 한정, 이동 후 스크롤 비탈취, 잘못된 항목/오류 종료, 기존 저장/대상 경계의 선택 인수를 마쳤다.
실행 가능한 소유 잔여와 외부 blocker는 없다. 위 분할 remount 제한은 별도 범위이며 미해결 사실을 보존했다.
통합 시에는 이 변경과 공통 candidate의 충돌/영향을 판단하고, 공통 입력이 바뀌면 `web/e2e/settings-links.spec.ts` 및 `web/e2e/workspace.spec.ts:319`, `web/e2e/workspace.spec.ts:799`, `web/e2e/workspace.spec.ts:807`을 같은 잠금/진입점으로 선택하면 된다.
기능 workspace에서는 TODO 체크·merge·push·배포·workspace 정리를 수행하지 않는다.
