# b02 / 17 — hook 설정 인계

## 상태·기준

- worktree: `/home/ubuntu/.local/share/paseodog/paseo/worktrees/0q796rug/b02-17-hooks-config`
- branch: `parallel/b02-hooks-config`
- 공통 기준 SHA: `bc797b36cd0c09ce41eb675d7d152ce95ffa7ef1`
- 실제 top-level·branch가 원본 `work/README.md`의 17번 행과 일치하고 merge-base·시작 HEAD도 위 SHA였다. 시작 상태는 깨끗했고 기존 `work/RESULT-17.md`는 없었다.
- 구현 종료, **검증 환경 blocker로 통합·인수 대기**. Rust 컴파일·HTTP 시험·웹 타입·Vitest·브라우저 동작은 통과로 주장하지 않는다.
- `TODO.md`는 수정하지 않았다. push·merge·배포·서비스 중단·의존성 설치는 하지 않았다.

## 제공 동작·변경 소유권

- `src/hooks/mod.rs`: 설정 전용 CRUD, 고정 이벤트·glob 검증, 범위·소유자 검사, revision 충돌, idempotency, 응답 가림, ID·revision만 담는 감사·이벤트 기록.
- `src/lib.rs`: `pub mod hooks` 및 `/hooks`, `/hooks/{id}` 라우트 등록.
- `src/store.rs`: 기존 migration은 보존하고 `hook_definitions` 생성 migration 하나만 끝에 추가. 공통 기준에서는 57번째이며 통합 시 다른 신규 migration 뒤로 옮겨도 앞선 병렬 작업의 테이블에 의존하지 않는다.
- `tests/hooks.rs`: 실제 HTTP·격리 DB의 CRUD·저장 지속성·미실행·범위·권한·충돌·validation·명령 보존·응답 및 기록 가림 시험 5개.
- `web/app/api/hooks.ts`: hook 전용 API 타입과 URL·update 생성 함수. 기존 `generated.ts`·생성기는 수정하지 않았다.
- `web/app/components/hooks/HooksSettings.tsx`: 전역/프로젝트 선택, 서버 이벤트 선택, glob 안내, 추가·편집·명령 교체·활성 설정·비활성화·삭제 확인, 충돌 초안 보존·최신 설정 채택, 결과 불명 요청의 동일 키 재확인.
- `web/app/components/hooks/HooksSettings.test.ts`: SSR escape·미실행 상태·범위·조회 상태·URL·명령 생략 계약 시험 5개.
- `web/app/components/Settings.tsx`: agents 메뉴의 hook 검색 항목·관리 화면 mount.
- `web/e2e/hooks.spec.ts`: 실제 API를 쓰는 CRUD·가림·새로고침, matcher/편집/삭제 충돌, 프로젝트·기기 권한, 실제 transport abort 후 동일 키 복구 시나리오 4개.
- `work/RESULT-17.md`: 이 인계.

## public 계약

서버 export: `hooks::{Hook, Scope, Definition, Update, Delete, EVENTS, EXECUTION_STATE, list, create, update, remove}`.

모든 endpoint는 기존 `auth::Owner`를 사용한다. 인증 없음은 401, 등록 기기와 그 브라우저는 403이다. 단일 사용자 서버의 프로젝트 공유 모델을 유지하되 명령 설정은 소유자만 관리한다.

| 요청 | 입력·출력 |
|---|---|
| `GET /api/v1/hooks` | 전역만 조회. `{hooks, events, matcher_syntax:"glob", execution_state:"not_implemented"}` |
| `GET /api/v1/hooks?project_id=P` | 해당 프로젝트만 조회. 전역을 합치거나 적용 우선순위를 주장하지 않음 |
| `POST /api/v1/hooks[?project_id=P]` | `{name,event,matcher,command,enabled?}`. `enabled` 기본 false. 201과 가림 처리된 Hook |
| `PUT /api/v1/hooks/ID[?project_id=P]` | `{expected_revision,name,event,matcher,enabled,command?}`. command 생략/null은 기존 원문 유지, 문자열은 명시적 교체. 200과 revision 증가 Hook |
| `DELETE /api/v1/hooks/ID?expected_revision=N[&project_id=P]` | revision 일치 시 삭제. `{deleted:true,execution_state:"not_implemented"}` |

Hook 응답 필드: `id, project_id, name, event, matcher, command, command_redacted, enabled, revision, execution_state`.

- 전역 범위의 `project_id`는 null이다. 생성 후 범위는 이동하지 않는다. 다른 프로젝트 또는 전역 경로에서 같은 ID를 수정·삭제하면 404다.
- 프로젝트 ID의 존재를 DB 안에서 검사한다. 보관된 프로젝트는 현재 조회·변경 모두 `409 archived`로 거부한다. 경로의 실제 접근 가능 여부는 검사하지 않으며 설정 저장은 파일·프로세스에 접근하지 않는다.
- 고정 이벤트: `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Stop`, `SessionEnd`. 응답의 목록을 UI가 그대로 사용한다.
- matcher는 `globset::Glob` 문법이며 1~512바이트, 제어 문자·공백만 있는 값·문법 오류는 400이다. 정규식이나 셸 문법으로 해석하지 않는다.
- 이름은 제어 문자 없는 1~160바이트, 명령은 공백만 있지 않은 NUL 없는 1~65536바이트다. 명령은 trim·파싱·재작성하지 않고 그대로 저장한다.
- 수정·삭제 revision이 다르면 `409 revision_conflict`와 **가린** 현재 Hook을 표준 오류 `details.current`로 제공한다. 충돌 시 저장 내용은 바뀌지 않는다.
- 모든 변경은 기존 `idem::run` transaction을 재사용한다. `Idempotency-Key`가 필요하고, hash에 범위·ID·입력을 포함한다. 동일 키·동일 요청은 저장된 응답을 재생한다. 다른 입력의 동일 키는 409다.
- 명령에 secret/token/password/key/Authorization/Bearer, 알려진 자격증명 prefix, URL 사용자정보, `-u`, 긴 불투명 문자열 등의 징후가 있으면 **명령 전체**를 `[redacted]`로 응답한다. idempotency 응답·revision 충돌도 같은 view를 사용한다. 이벤트·감사에는 ID·revision·삭제 여부만 넣으며 원문은 로그에 출력하지 않는다.
- `enabled`는 저장된 설정일 뿐이다. 목록·변경 응답과 UI에 `not_implemented` / “아직 실행되지 않음”을 명시한다. 실행기·모델 경로·외부 명령·Windows command 처리는 추가하지 않았다.

웹 export: `HooksSettings({projectId?: string, projectName?: string})`; `Hook`, `HookDefinition`, `HookListing`, `HookUpdate`, `hookPath`, `hookUpdate`.

화면은 프로젝트 context가 있을 때만 해당 프로젝트 선택지를 제공하며 기본은 전역이다. 범위별 editor를 별도 mount한다. 편집 시 명령 필드는 비워 두고 “명령 교체”를 선택한 경우에만 새 원문을 전송한다. 충돌에서 입력을 보존하며 최신 revision을 자동으로 채택하지 않는다. 전송 중·결과 불명 상태에서는 범위 전환·새 변경을 막고 동일 attempt의 body·key로만 재확인한다.

모듈·라우트·migration·Settings mount는 이미 연결했다. 추가 실행 연결은 필요하지 않으며 이번 범위에서 하면 안 된다.

## 실행한 검증과 미실행

| 명령·입력 | 실제 결과 |
|---|---|
| `source .envrc.dev && python3 scripts/build.py test --rust hooks --typecheck --vitest app/components/hooks/HooksSettings.test.ts` | 초기 선택 검사 시도 exit 1. `FileNotFoundError: [Errno 2] No such file or directory: 'cargo'`. Rust는 수집·컴파일·실행 전 실패했고 뒤 typecheck·Vitest는 미실행 |
| `source .envrc.dev && python3 scripts/build.py test --typecheck` | 독립 실행 exit 127. `sh: 1: react-router: not found`. 타입 검사는 시작되지 않음 |
| `python3 -`의 표준 라이브러리 SQLite 검증 | exit 0. 최종 `src/store.rs`의 실제 raw SQL migration 57개를 메모리 DB에 적용. 기존 프로젝트 행 보존, 전역/프로젝트 분리, 명령 원문·기본 revision 보존, event/enabled/revision/FK 제약, 프로젝트 삭제 cascade, `foreign_key_check`·`integrity_check` 통과. Rust/API 검증 대체가 아님 |
| `git diff --check`, `git diff --cached --check` | 실행 통과. staged 검사에는 신규 파일도 포함. 동작·컴파일 근거가 아니라 공백 검사 |

이 worktree에는 `.dev`와 `web/node_modules`가 없다. 원본 프로젝트의 도구 디렉터리는 확인했지만 승인된 worktree용 공통 환경 연결 경로가 문서에 없어 설치·복사·symlink·임시 crate/실행기로 우회하지 않았다. dependency·lockfile은 변경하지 않았다.

최종 Rust·Vitest는 환경 제약 때문에 미실행이다. E2E·전체 회귀·release·패키징은 COMMON의 통합 단계 범위라 실행하지 않았고 고정 포트 서버도 시작하지 않았다. Rust·웹 코드가 컴파일된다는 근거는 아직 없다.

## TODO 충족 범위·위험·다음 통합

`RESOURCE-015`의 목록·이벤트·matcher·명령·활성 설정·저장 CRUD와 실제 관리 화면 연결은 구현했다. 그러나 Rust·타입·Vitest·E2E가 검증되지 않았으므로 **전체 요구 충족·완료 후보로 판정하지 않는다**. 통합 담당이 검증 후 `TODO.md` 완료 여부를 판단해야 한다.

`RESOURCE-016` 실행, `RESOURCE-017` Windows command, `RESOURCE-018` 원본 hook 조회는 제외했다. 다른 기능을 구현하거나 완료로 표시하지 않았다.

가림은 보수적 heuristic이다. 일반 명령도 가려질 수 있고 짧고 표식 없는 임의 비밀값은 자동 식별할 수 없다. 명령 원문은 요구대로 설정 DB에 보관하므로 vault 암호화 저장을 보장하는 기능은 아니다. UI는 가린 명령을 덮어쓰지 않고 보존하며 명시적 교체만 받는다.

통합 담당의 다음 작업:

1. 승인된 공통 빌드 환경·기존 의존성을 이 worktree/통합 checkout에 적용하고 `python3 scripts/build.py test --rust hooks --typecheck --vitest app/components/hooks/HooksSettings.test.ts`를 실행한다.
2. 다른 작업의 E2E와 겹치지 않게 `python3 scripts/build.py test --e2e e2e/hooks.spec.ts`를 실행한다. 작성된 시험은 skip·가짜 API·실행 성공 표시를 사용하지 않는다.
3. `src/lib.rs` 라우트, `src/store.rs` migration 끝, `Settings.tsx` 메뉴·mount의 다른 작업 추가분을 보존해 통합하고 관련 설정 회귀·API 타입 일치를 확인한다.
4. 실제 통과 근거가 생긴 뒤 `RESOURCE-015`의 완료 여부를 결정한다. 실행기 연결은 별도 승인·범위로 남긴다.
