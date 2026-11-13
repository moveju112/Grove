# b02 / 20 — 외부 편집기 목록·열기

## 위치·상태
- Worktree: `<세션 worktree 루트>/b02-20-external-editor`
- Branch: `parallel/b02-external-editor`
- 분기 기준: `c2eebe6a08c4375d604a76e807066e76f9e4fbcd` (README 20 행의 별도 기준). 작업 시작 HEAD와 일치하고 ancestry 확인 완료.
- 상태: 구현 종료, 통합 및 E2E·실환경 검증 대기. 구현 blocker 없음.
- 작업 시작 Git clean. 세션 조회는 런타임에서 `cross-session control is unavailable in this runtime`으로 지원하지 않아 다른 세션 상태는 확인하지 못했다.
- `TODO.md`는 소유 범위 밖이므로 변경하지 않았다. push·merge·배포·서비스 조작 없음.

## 제공 동작·소유 파일
- `src/external_editor.rs`: 고정 후보 VS Code·Cursor·Zed·IntelliJ IDEA·WebStorm·PyCharm·CLion·RustRover의 실행 파일 탐지, PC/GUI 판정, 파일 검증, 분리 실행, 멱등 접수·결과 기록.
- `tests/external_editor.rs`: Rust/TypeScript 계약 비교와 격리된 임시 PATH의 HTTP 통합 시험. 실제 편집기는 실행하지 않는다.
- `src/lib.rs`: 모듈·2개 라우트·`external_editor_v1` 등록만 추가.
- `web/app/api/externalEditor.ts`, `web/app/api/generated.externalEditor.ts`: typed API 및 Rust 선언과 drift 검사하는 전용 타입.
- `web/app/components/files/ExternalEditor.tsx`, `web/app/components/files/ExternalEditor.test.ts`: 목록·선택·열기·비활성 이유·오류·실행 접수 안내. 응답 유실/결과 불명/5xx는 같은 요청 키를 보존한다.
- `web/app/components/FilesView.tsx`: 기존 파일 선택 시 컴포넌트 mount 1곳. 새 파일·잠긴 파일 작업에서는 실행하지 않는다.
- `web/e2e/external-editor.spec.ts`: capability 있음/없음, GUI 없음, 저장 전 내용 보존, 응답 유실 뒤 동일 키 확인 시나리오 4개 작성.

## 공개 계약·연결
- Rust exports: `external_editor::{Editor, Listing, OpenBody, list, open}`.
- `GET /api/v1/external-editors`: 기존 `Principal` 인증 필수. `{ available, reason: string | null, editors: [{ id, name }] }`. 실행 파일 경로는 직렬화하지 않는다.
- `POST /api/v1/projects/{id}/external-editor`: `{ editor_id, path }`만 허용하며 알 수 없는 필드를 거부한다. `Idempotency-Key` 필수. `202 { launched: true }`는 spawn 접수이며 편집기 준비·파일 저장 성공을 뜻하지 않는다.
- `CAPABILITIES`의 `external_editor_v1`은 API 지원 여부다. 실제 PC capability는 조회 응답 `available`로 구분하며, UI는 두 조건을 모두 충족할 때만 열기 버튼을 표시한다.
- PC 조건: loopback listen/peer/Host, TLS 종료 프록시 아님, 전달 헤더 없음, 모바일 UA 아님. 공개 listen·원격·모바일·프록시는 빈 목록과 이유를 반환하고 POST도 거부한다.
- GUI 조건: Linux `DISPLAY` 또는 `WAYLAND_DISPLAY`, Windows nonzero session 및 접근 가능한 input desktop, macOS GUI session dictionary. SSH 환경과 지원하지 않는 OS는 비활성이다.
- 탐지는 절대 PATH의 고정 명령만 사용한다. Windows는 고정된 VS Code/Cursor/Zed 설치 경로도 확인하고 `.cmd` shell wrapper를 실행하지 않는다. macOS는 고정 `/Applications` bundle 경로도 확인한다. 미탐지 시 CLI의 PATH 등록 안내를 표시한다.
- POST는 기존 `Principal`·`project_resources.ui_write`·인증 재검증과 `settings::all_layers`를 재사용한다. 서버/프로젝트 어느 범위든 `tools.mode=read_only`면 `403`. 프로젝트 화면에는 session ID가 없으므로 특정 session 범위 설정은 적용하지 않는다.
- `projects::active_root`, `files::resolve_api`, `ProjectFs::open_file`을 재사용한다. 상대 경로의 일반 파일만 허용하며 절대 경로·상위 이동·외부 symlink·디렉터리·없는 파일을 거절한다. 내부 symlink는 실제 내부 파일로 정규화한다.
- 프로세스는 shell 없이 절대 실행 파일과 검증한 파일 경로 1개를 인자로 받고 프로젝트 root를 cwd로 쓴다. 표준 입출력은 null, Unix `setsid`, Windows detach/process-group flags를 사용한다. 종료는 HTTP 요청과 별도 thread에서 회수한다.
- 외부 부작용 전에 기존 `idem` receipt를 커밋하고 완료 후 결과를 확정한다. 접수 실패는 실행하지 않으며, 완료 DB 실패는 `409 result_unknown`을 보존하여 같은 키로 재실행하지 않는다. spawn 실패는 `409 editor_launch_failed`. 입력/경계/인증 오류는 기존 API 오류 형식을 따른다.
- 웹 exports: `ExternalEditor({ projectId, path, disabled? })`, `ExternalEditorControls` 및 `ExternalEditorControlsProps`, `listExternalEditors(signal?)`, `openExternalEditor(projectId, editorId, path, key)`, `ExternalEditorListing`.
- 파일 화면의 저장 전 텍스트는 전달하지 않고 서버에 저장된 파일만 연다. 별도 dependency·migration·store·runner 연결은 필요 없다.
- 공통 연결은 지정된 범위에서 완료했다. 통합 시 `src/lib.rs`의 다른 기능 추가와 병합하고, 통합 기준에서 아래 E2E를 실행하면 된다. 전용 TypeScript 계약은 `tests/external_editor.rs`가 검사하며 기존 공통 생성기를 수정하지 않았다.

## 검증 근거
모든 명령은 자기 worktree에서 실행했다. 메인 `.envrc.dev`를 source했고 도구를 설치·복사하지 않았다. `.dev`와 `web/node_modules`는 메인 환경을 가리키는 Git ignore symlink다.

| 실제 명령 | 최종 결과·입력 |
|---|---|
| `source <원본 저장소>/.envrc.dev && flock /home/ubuntu/.cache/grove-rust-check.lock python3 scripts/build.py test --rust external_editor` | 성공. 상위 test 2개 통과, fixture 1개는 기본 실행에서 의도적으로 ignored. driver가 desktop·Wayland·headless·missing·SSH·public listen·TLS proxy 7개 환경에서 fixture를 각각 명시 실행하여 모두 성공했다. |
| `source <원본 저장소>/.envrc.dev && python3 scripts/build.py test --vitest app/components/files/ExternalEditor.test.ts --typecheck` | 최종 성공. typecheck 및 Vitest 4개 통과. |
| `git diff --check` | 성공. |

- Rust는 설치 후보/실행 권한 없는 후보/미탐지, 실제 응답의 경로 비노출, GUI 없음, 모바일·프록시 거부, 인증 거부, 서버·프로젝트 읽기 전용, 경로 탈출·외부 symlink, 임의 executable/args 거부, 특수문자·공백·한글 파일명의 정확한 단일 인자와 cwd, 멱등 재전송/키 충돌, 접수 DB 실패·완료 DB 실패, spawn 실패 및 원문 보존을 확인했다.
- 최초 Rust 선택 검사도 통과했다. 추가 Windows 탐지와 복구 시나리오를 반영한 뒤 위 선택 검사를 재실행하여 최종 입력으로 통과했다.
- 중간 웹 검사는 새 E2E의 optional header 타입 때문에 `TS2345: Argument of type 'string | undefined' is not assignable to parameter of type 'string'`로 실패했고 그 호출의 Vitest는 미실행이었다. 헤더 존재 assertion으로 수정한 뒤 동일 선택 명령이 최종 통과했다.
- E2E는 COMMON의 병렬 기능 작업 규칙에 따라 실행하지 않았다. 웹 typecheck에는 작성한 E2E도 포함된다. 통합 후 실행할 명령은 `python3 scripts/build.py test --e2e e2e/external-editor.spec.ts`이며 고정 포트를 다른 E2E와 동시에 쓰지 않아야 한다.
- 전체 회귀·release·패키징·실제 GUI 실행·Windows/macOS 빌드/실행은 미실행이다. Linux의 가짜 실행 파일로 확인한 범위를 실제 편집기·타 플랫폼 통과로 해석하면 안 된다.

## TODO·남은 조건·위험
- `FILEUI-007`: PC capability 분리, 고정 후보 목록, 프로젝트 파일 열기, 파일 화면 연결과 선택 Rust/Vitest 검증을 구현했다. 필수 E2E가 미실행이므로 아직 전체 완료 후보로 단정하지 않으며 `[ ]`를 유지한다.
- 다음 통합 단계: 해당 E2E 4개 실행, 필요 플랫폼의 실제 편집기/GUI·서비스 세션 확인 후 `TODO.md` 완료 여부 판단. Windows JetBrains 등은 CLI `.exe`가 절대 PATH에 있어야 탐지하며 모든 Toolbox 버전 디렉터리를 순회하지 않는다.
- GUI 프로그램은 서버 sandbox 밖의 사용자 프로세스다. 실행 직전에 경계를 재검사하지만, 실행 이후 외부 편집기가 경로를 다시 여는 동안 로컬 OS 사용자가 파일·부모 디렉터리를 교체하는 것까지 sandbox로 묶지는 못한다.
- PC 구분은 연결·listen·Host·전달 헤더·UA 기준이다. 원격 터널이 loopback/Host와 UA를 그대로 위장하며 전달 헤더도 제거하면 서버만으로 실제 물리적 클라이언트 위치를 증명할 수 없다.
- 편집기 CLI가 spawn 후 내부적으로 실패하거나 기존 GUI에 전달하지 못한 경우는 종료를 기다리지 않는 고정 계약상 서버의 실행 성공 판정 대상이 아니다.
- 인계 후 추가 작업 없이 멈춘다.
