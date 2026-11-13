<!-- grove-handoff:v1
{"state":"ready","remaining":[],"blockers":[],"integration_checks":["통합 candidate에서 e2e/git-context.spec.ts, e2e/git-recovery.spec.ts, e2e/git-stash.spec.ts의 Git 공통 경계를 필요 시 재확인"]}
-->

# 42 — FILEUI-009 Git 위치·exact-HEAD PR/CI·실제 실행 권한

- 배치: b02 / 42. 상태: 소유 구현·실제 연결·선택 검증 완료, 통합 대기. blocker 없음.
- Worktree: `/home/ubuntu/.local/share/paseodog/paseo/worktrees/0q796rug/b02-42-git-context`
- Branch: `parallel/b02-git-context`
- 고정 기준: `6fc2fbb5b36e883d13417fc9c41cf679aed3eb0c`
- 포함된 승인 제품 입력: `f53aa85061cc35198461bb54e1d133218dbb7cad` (`merge-base --is-ancestor` 성공).
- 정본: `/data/project/paseodog_opus/work/ENTRY.md`, `/data/project/paseodog_opus/work/COMMON.md`, `/data/project/paseodog_opus/work/42.md`. README의 경로·branch 일치, 시작 시 HEAD·clean 확인.

## 제공 동작과 연결

| 소유 파일 | 제공 내용 |
| --- | --- |
| `src/git_context.rs` | 프로젝트 read guard와 기존 Git helper를 쓰는 읽기 전용 위치·권한·GitHub 조회 |
| `tests/git_context.rs` | 로컬 Git·고정 gh 실행 파일 fixture를 통한 HTTP 통합 시험 5개 |
| `src/lib.rs` | `pub mod git_context`, `GET /projects/{id}/git/context` 등록 두 지점만 변경 |
| `web/app/api/gitContext.ts` | `GitContext`, `GitContextState`, `readGitContext(projectId, head?)` |
| `web/app/components/git-context/GitContextOverview.tsx` | 실제 Git 화면 개요, 요청 세대·프로젝트·연결 경계, 제한 이유 |
| `web/app/components/git-context/model.ts` | 상태 문구와 프로젝트·HEAD 일치 검사 |
| `web/app/components/git-context/model.test.ts` | 대상 격리와 오류 구분 단위 시험 2개 |
| `web/app/components/GitPanel.tsx` | import·개요 mount·기존 status의 HEAD/갱신 신호만 전달 |
| `web/e2e/git-context.spec.ts` | 실제 Git 위치·권한·입력/미확정 요청 보존, GitHub 표시, 늦은 응답·프로젝트 전환·재접속 시험 3개 |
| `work/RESULT-42.md` | 이 인계 |

공통 연결은 모두 완료했다. `src/git.rs`, `src/repos.rs`, `src/worktrees.rs`는 수정하지 않았다.
기존 `git::root_of/is_repo/git/parse_status`, `repos::normalize`, `settings::all_layers`, `auth::revalidate`, `project_resources.ui_read`, `Config::gh_command`를 재사용한다.
공용 client/state/CSS·settings·runner·store·dependency·TODO는 변경하지 않았다.

### API·화면 계약

- `GET /api/v1/projects/{id}/git/context?head=<optional expected oid>`는 기존 `Principal` 인증·프로젝트 read lease·active root를 사용한다. 없는/접근 불가능한 프로젝트와 무인증/폐기 기기를 기존 오류 경계로 거부한다. 조회 완료 직전 인증을 재검증한다.
- `project_id`, `status=ok|stale|not_repo`, `observed_at`, `location`, `github`, `authority`를 반환한다. optional expected HEAD 불일치는 외부 조회 없이 stale이다.
- 위치는 branch/detached/unborn·정확한 HEAD·프로젝트의 worktree 내 상대 위치·main/linked·Git 등록 여부·worktree 수다. 서버 절대 경로는 반환하지 않는다. Git 등록을 Grove 관리 등록으로 오인시키지 않는다.
- GitHub 대상은 **origin**의 검증된 GitHub.com identity다. HTTPS/SSH/SCP 주소에서 owner/name만 사용한다. 다른 host·임의 URL·잘못된 identity는 unsupported이며 HTTP 대상이 되지 않는다.
- gh는 `Config::gh_command`로 고정 argv `api --hostname github.com --method GET`만 호출한다. endpoint는 검증한 repo와 Git이 반환한 HEAD로 만든 commit pulls/check-runs/status다. 셸 문자열·로그인·토큰 수집·설치·fetch는 없다.
- PR은 commit 연관 조회 결과 중 **head.sha가 정확히 현재 HEAD**이고 base repository가 일치하는 항목의 번호·상태·draft만 표시한다. branch 이름이나 commit 포함 여부만으로 이전 PR을 현재 PR로 붙이지 않는다.
- CI는 check run의 head_sha와 commit status의 sha를 검증해 합산한다. 상태는 success/failure/pending/neutral/none이며, 실패·취소·조치 필요를 성공으로 바꾸지 않는다. 100개 한도·불완전 목록·알 수 없는 응답은 unknown이다.
- missing/unauthenticated/denied/timeout/unknown/unsupported/none/stale/unborn/no_remote를 구분한다. gh 조회별 8초 제한, drop 시 자식 종료. 원격 오류 원문·PR 제목·작성자·URL·자격증명은 반환/기록하지 않는다.
- 조회 전후 로컬 status·HEAD/branch·origin·Git 디렉터리·worktree 목록·프로젝트 root가 바뀌면 PR/CI를 stale로 지우고 작업 사전조건도 비운다.
- `GitContextOverview` props는 `{projectId, head?, refreshSignal?}`다. status의 HEAD는 무효화 신호이며 재접속 조회에는 서버의 최신 HEAD를 사용한다. 프로젝트·갱신·연결 세대가 달라진 늦은 응답은 폐기하고 재검증 중 이전 결과를 숨긴다. GitHub HEAD가 위치 HEAD와 다르면 PR/CI 성공이나 항목을 표시하지 않는다.
- PWA offline/호환성 차단과 SSE 재연결 때 이전 개요를 현재 정보로 표시하지 않는다. 복구하면 읽기만 다시 하며 mutation을 재전송하지 않는다. 빈번한 상태 확인 화면이라 새 애니메이션은 추가하지 않았다.

### 실제 권한과 보존 경계

- 기존 직접 Git API는 owner 전용이 아니라 유효한 인증 기기에 열려 있으며 프로젝트별 기기 ACL을 두지 않는다. 존재하지 않는 ACL이나 승인 정책을 만들지 않았다. 다른 프로젝트의 늦은 UI 응답은 격리하고, 무인증/폐기 기기의 다른 프로젝트 접근은 거부한다.
- `tools.mode=read_only`는 모델 도구 정책이다. server/project 어느 층이든 read_only이면 그 사실을 표시하되 직접 Git API의 변경 금지로 거짓 표시하지 않는다. 대화별 모델 정책은 이 프로젝트 개요와 별도임을 명시한다.
- stage/unstage/commit/stash/fetch/pull/push와 기존 확인 작업의 현재 사전조건·제한 이유를 표시한다. 원격 쓰기 권한은 **미확인**이며 GitHub 조회 성공을 Git push 권한으로 추정하지 않는다.
- detached에서 커밋은 가능하고 기본 pull/push는 현재 branch가 필요하다. unborn unstage는 기존 index 제거 경로를 지원하며 unborn pull은 일괄 금지하지 않고 Git 판정에 맡긴다. dirty 상태도 모든 작업의 일괄 금지가 아니다.
- 개요는 승인·실행 기능이 아니다. 기존 서버 변경 API가 인증·fingerprint·revision·확인 대상·충돌·Git hook·원격 권한을 최종 판정한다. 기존 버튼의 의미·fingerprint/revision/unknown-result dialog·hunk/stash/remote 작업은 변경하지 않았다.
- 조회 전후 index·HEAD·config 파일, refs, Git worktree 등록 목록이 동일함을 격리 fixture로 확인했다. 실제 외부 GitHub 계정이나 저장소에 접근하지 않았다.

## 검증 근거

모든 명령은 먼저 `source /data/project/paseodog_opus/.envrc.dev`를 적용했다.
준비된 `.dev -> /data/project/paseodog_opus/.dev`는 보존했고, 승인된 경로대로 없던 `web/node_modules`만 메인 공유 경로의 symlink로 연결했다. 설치·의존성 변경은 없다.
Rust/E2E는 아래 **전체 명령**에 같은 `grove-rust-check.lock`을 적용했다. 기존 검사·환경·포트는 취소하거나 바꾸지 않았다.

### 최초 선택 Rust 및 기존 Git 회귀

```bash
flock /home/ubuntu/.cache/grove-rust-check.lock python3 scripts/build.py test --rust git_context git git_stash git_receipts
```

23개 통과: git_context 4, git 6, git_stash 9, git_receipts 4.
실행기 기록: wall 155.68s / CPU 228.53s / peak 2209.3MB / exit 0.
이후 변경은 새 개요의 unborn pull 사전조건 문구·판정, 사용하지 않는 import 제거, git_context 시험 추가뿐이다. 기존 변경 API/회귀 시험의 관련 입력은 그대로여서 기존 19개 통과 근거를 재사용한다.
최초의 unused import 경고는 최종 코드에서 제거했고 아래 재컴파일에는 없다.

### 웹 단위·타입

```bash
python3 scripts/build.py test --vitest app/components/git-context/model.test.ts --typecheck
```

최종 웹 입력에서 타입 검사·단위 2개 통과.
typecheck: wall 8.33s / CPU 12.92s / peak 663.0MB / exit 0.
Vitest: wall 1.79s / CPU 2.06s / peak 124.4MB / exit 0.
이후 웹 코드·타입·시험은 변경하지 않았다.

### 실제 브라우저 및 기존 Git 흐름 회귀

```bash
flock /home/ubuntu/.cache/grove-rust-check.lock python3 scripts/build.py test --e2e e2e/git-context.spec.ts e2e/git-recovery.spec.ts e2e/git-stash.spec.ts
```

11개 통과: 전용 개요 3, 기존 recovery 3, 기존 stash 5.
debug build: wall 73.94s / CPU 83.72s / peak 2238.0MB / exit 0.
web build: wall 4.85s / CPU 4.98s / peak 578.2MB / exit 0.
E2E: wall 13.52s / CPU 12.01s / peak 304.2MB / exit 0.
GitHub 표시 사례만 브라우저 응답 fixture로 대체하고 위치·권한·기존 mutation은 실제 서버/로컬 Git을 사용한다. 실제 gh 실행·argv·HEAD 대응·오류 분류는 Rust fixture가 검증한다. 외부 계정 접근을 E2E 통과로 주장하지 않는다.

### 최종 서버 입력 재검증

```bash
flock /home/ubuntu/.cache/grove-rust-check.lock python3 scripts/build.py test --rust git_context --e2e e2e/git-context.spec.ts
```

git_context 5개 및 전용 E2E 3개 통과. 최종 유효 근거는 Rust 24개(새 5 + 보존된 기존 19), 웹 단위 2개·타입, E2E 11개(전용 3 재실행 + 관련 입력 불변인 기존 8)다. 반복 실행 수를 더한 수치가 아니다.

| 최종 단계 | wall | CPU | peak | 결과 |
| --- | --- | --- | --- | --- |
| Rust git_context | 68.54s | 15.55s | 1474.4MB | 5 통과, exit 0 |
| debug build | 35.03s | 9.41s | 1456.5MB | exit 0 |
| web build | 3.95s | 5.07s | 562.7MB | exit 0 |
| 전용 E2E | 6.1s | 5.31s | 272.7MB | 3 통과, exit 0 |

최종 추가 시험은 조회 중 기기 폐기 뒤 프로젝트 결과를 받지 못하는 경우와 unborn pull의 실제 API 사전조건이다.
실행 실패·timeout·취소된 검사는 없다. fixture가 의도적으로 발생시킨 gh timeout은 오류 분류의 통과 사례다.
웹 빌드의 500 kB chunk 및 React Router future flag 경고는 남아 있으며 빌드는 통과했다. 범위 밖 번들 설정은 수정하지 않았다.
`git diff --check` 통과. 위 최종 검사 뒤 제품/시험 변경은 없고 이 인계 파일만 추가했다.

## FILEUI-009 완료 근거·남은 조건

- 실제 프로젝트 Git 화면에서 branch/detached/unborn·worktree 관계·정확한 HEAD·PR/CI·작업별 제한 이유를 조회한다.
- HEAD 경합·같은 branch의 새 HEAD·늦은 응답·프로젝트 전환·offline/재접속·기기 권한 폐기를 격리 fixture와 선택 브라우저 흐름으로 확인했다.
- 기존 입력·미확정 요청의 원래 key/fingerprint 재확인, hunk, stash 저장/pop/discard/충돌, remote·이력 API의 관련 회귀를 보존했다.
- 실행 가능한 소유 잔여와 blocker는 없다. Windows/macOS·모바일 화면·실제 외부 GitHub 계정/SSH 자격/원격 쓰기 권한은 미검증이며 이번 read-only 범위에서 이를 획득·시험하지 않는다.
- 사용자 지시에 따라 runtime 설정 변경·위임·다른 checkout 편집·merge/rebase·push·배포·workspace 관리·TODO 갱신은 하지 않았다. 번호 문서의 fast 설정 변경은 사용자의 명시적 runtime 설정 변경 금지에 따라 수행하지 않았다.
- 통합 담당은 위 연결과 선택 인수 근거를 재사용하고 통합 candidate의 공통 경계만 필요 시 재확인하면 된다.
