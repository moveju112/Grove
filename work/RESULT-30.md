# 30 — UI-003 현재 위치와 부모 탐색

## 배정·상태

- 배치/번호: b02 / 30, TODO ID: `UI-003`.
- Worktree: `<세션 worktree 루트>/b02-30-navigation-context`.
- Branch: `parallel/b02-navigation-context`.
- 공통 기준 SHA: `551f551d48d1f47cd3ad67015f1737c62d576228`.
- 상태: 구현 종료, 선택 단위·타입·Rust 검증 통과, 브라우저 인수는 통합 대기. E2E 미실행 상태를 전체 요구의 검증 완료로 간주하지 않는다.
- 구현 blocker는 없다. 공통 계약에 따라 E2E·전체 회귀·release·패키징은 실행하지 않았다.

## 제공 동작·소유 변경

| 경로 | 변경 |
| --- | --- |
| `web/app/components/navigation/context.ts` | 현재 layout의 활성 pane/tab에서 프로젝트·세션 ID와 부모 열기 대상을 계산하는 순수 함수, 호스트 주소 정제 |
| `web/app/components/navigation/NavigationContext.tsx` | 호스트·프로젝트·세션·파일·터미널·설정 맥락, 현재 페이지와 영역 번호, 기존 부모 탐색 버튼 |
| `web/app/components/navigation/navigation.css` | 한 줄 높이, 긴 이름 말줄임, 좁은 화면, 키보드 focus 표시 |
| `web/app/components/navigation/context.test.ts` | 위치·ID·늦은 응답·부모 열기·폭별 배치·호스트 비밀 경계 단위 시험 13개 |
| `web/app/components/navigation/NavigationContext.test.ts` | 접근성·오류·이름 escape·비밀 비노출·빈 영역 표시 단위 시험 5개 |
| `web/app/components/Workspace.tsx` | import와 header 밖 `.body` 바로 앞 mount만 추가 |
| `web/e2e/navigation-context.spec.ts` | 부모 탐색/초안/승인 대기 보존, 뒤늦은 응답, 좁은 화면/긴 제목/폭별 초안의 브라우저 시나리오 3개 |
| `work/RESULT-30.md` | 이 인계 |

`TODO.md`, 생성 버튼/모달, sidebar 상태·핀 구현, layout 저장 schema, `SessionView`, API/server, dependency/lockfile은 변경하지 않았다.
현재 pane 선택은 기존 `mobileView()`를 재사용했으며 `web/app/state/layout.ts` 수정은 없다.
자주 바뀌는 위치 표시는 애니메이션 없이 즉시 갱신한다.

## 공개 계약·연결

- `NavigationContext` 및 `NavigationContextProps`는 `web/app/components/navigation/NavigationContext.tsx`에서 export한다.
- Props: `layout?: Layout`, `projects: Project[]`, `host: string`, `open: Opener`, `onBrowseProjects: () => void`, `sidebarOpen: boolean`.
- Workspace는 현재 폭의 `layout`, 필터 적용 전 프로젝트 목록, `window.location.origin`, 현재 배치의 기존 `open`, 기존 sidebar 열기 callback과 상태를 전달한다. 추가 공통 연결은 필요 없다.
- 순수 함수 export: `navigationContext`, `hostAddress`, `resourceLabel`, `projectTarget`, `sessionTarget`.
- 활성 자원은 현재 layout의 `focused_leaf`와 `active_tab`에서만 결정한다. 제목으로 identity를 추정하지 않는다. 이름이 같은 프로젝트/세션도 ID로 구분한다.
- 세션 이름은 기존 `session:${id}` cache와 인증된 `GET /sessions/{id}`를 공유한다. 응답의 세션 ID와 프로젝트 ID가 현재 layout과 모두 일치할 때만 사용한다. 세션 설정의 `session:{id}` 부모도 기존 layout 형식을 읽는다.
- 전역 설정과 빈 영역/배치 복원 중에는 이전 프로젝트·세션을 남기지 않는다. 파일은 기존 `fileTarget()`의 실제 경로를 사용한다.
- 프로젝트 목록/세션 정보가 없으면 현재 layout의 ID를 표시한다. 세션 조회 실패는 일반적인 `조회 실패`로 알리고 서버 오류 원문이나 이전 세션 제목을 표시하지 않는다.
- 호스트는 HTTP(S) URL의 `host`만 텍스트로 표시한다. userinfo·password·path·query·fragment를 tooltip이나 접근성 이름에도 넣지 않는다. 호스트 전환 행동/새 연결 기능은 추가하지 않는다.
- 부모 프로젝트/세션은 기존 `open` callback만 호출한다. 새 세션 생성·탭 닫기·작업 취소 요청을 하지 않으며, 기존 중복 자원 재사용과 pane focus 계약을 따른다.
- 프로젝트 탐색 버튼은 기존 sidebar를 연다. sidebar 저장/핀/필터 상태를 재정의하거나 자원을 닫지 않는다.
- native 버튼과 `nav`/`ol`, `aria-current="page"`, ID를 포함한 접근성 이름·tooltip, 영역 레이블을 제공한다. CSS는 긴 이름의 전체 접근성 텍스트를 유지하며 시각적으로만 말줄임한다.
- 새 권한·mutation API·저장 형식은 없다. 기존 API 인증·오류·cache 무효화 계약을 그대로 따른다.

## 실행한 검사·결과

명령은 위 worktree에서 실행했다. 웹 의존성은 `web/node_modules` symlink로 `<원본 저장소>/web/node_modules`를 재사용했다.

```bash
source <원본 저장소>/.envrc.dev
python3 scripts/build.py test --vitest app/components/navigation/context.test.ts app/components/navigation/NavigationContext.test.ts app/state/layout.test.ts app/state/layoutPersistence.test.ts app/state/drafts.test.ts --typecheck
```

- 최종 결과: 타입 검사 통과, Vitest 5파일 60개 통과. 신규 기능 18개와 기존 layout 21개·layoutPersistence 12개·drafts 9개를 포함한다.
- 최초 실행은 `context.ts`에서 `TS18048: 'session' is possibly 'undefined'.`로 실패했고 Vitest는 미실행이었다. 세션 존재 조건을 명시해 수정한 뒤 위 명령 전체가 통과했다.
- E2E의 긴 제목을 서버 `clean_title()` 계약(200자 이하·trim)에 맞춘 뒤 `source <원본 저장소>/.envrc.dev && python3 scripts/build.py test --typecheck`를 다시 실행해 통과했다.

```bash
source <원본 저장소>/.envrc.dev
CARGO_TARGET_DIR=<원본 저장소>/target flock /home/ubuntu/.cache/grove-rust-check.lock python3 scripts/build.py test --rust workspace --filter two_projects_recent_and_split_survive_restart
```

- 결과: Rust 컴파일 및 `two_projects_recent_and_split_survive_restart` 1개 통과, 같은 target의 나머지 7개는 미선택.
- 최초 Rust 시도는 target override 없이 같은 선택 명령을 실행했다. 실행기의 `env()`가 공유 환경을 worktree `.dev`로 덮어써 rustup 다운로드를 시작했으므로 직접 중단했다(exit 137). 시험은 실행되지 않았고 이 시도는 성공이 아니다.
- 해당 시도가 새로 만든 `.dev/rustup`을 제거하고 `.dev`를 `<원본 저장소>/.dev`에 symlink한 후 위 명령으로 공유 툴체인·target cache를 재사용했다. dependency/툴체인 설치나 복사로 복구하지 않았다. `.dev`와 `web/node_modules` symlink는 Git ignore 대상이다.

```bash
# 위 worktree의 web 디렉터리에서 실행
npx playwright test e2e/navigation-context.spec.ts --list
```

- 결과: desktop 프로젝트의 3개 시나리오 수집 성공. 브라우저 실행 성공을 뜻하지 않는다.
- `git diff --check` 통과.
- E2E 실제 실행, 전체 회귀, release/웹 production 빌드, 실기기·스크린리더 수동 검증은 미실행이다.

## UI-003 요구 근거·남은 검증

| 요구 | 구현·선택 검증 근거 | 남은 범위 |
| --- | --- | --- |
| 현재 호스트와 비밀 비노출 | same-origin 전달, host-only 표시, 정제/markup 단위 시험 | 실제 브라우저 표시 인수 |
| 탭·분할·프로젝트 간 정확한 현재 위치 | 기존 활성 pane selector, 실제 ID 비교, 동일 이름/설정 전환/늦은 응답 단위 시험 | 신규 E2E의 키보드 focus·응답 지연 시나리오 실행 |
| 일관된 부모 탐색과 기존 작업 보존 | 기존 `open` 재사용, 순수 layout 보존 시험, 기존 layout/draft 회귀 및 Rust split/restart 시험 통과 | 신규 E2E의 초안·다른 pane DOM·승인 대기·세션 생성 없음 검증 실행 |
| 좁은 화면·긴 이름·접근성 | 폭별 layout 입력, 한 줄 CSS, 전체 접근성 이름과 현재 페이지 markup 시험 | 신규 E2E의 폭/높이 전환과 overflow·입력 영역 확인, 수동 보조기술 확인 |

통합 단계에서 공유 E2E 실행 자원을 확보한 뒤 아래 선택 흐름을 확인하면 된다.

```bash
source <원본 저장소>/.envrc.dev
python3 scripts/build.py test --e2e e2e/navigation-context.spec.ts e2e/pane-focus.spec.ts e2e/responsive-panes.spec.ts
```

브라우저 인수가 남아 있으므로 `UI-003`의 검증 완료/TODO 체크는 통합 담당이 판단해야 한다.
