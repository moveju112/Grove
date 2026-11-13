# b02 / 11 — 스킬 선택·세션 저장·모델 적용 연결

## 상태와 기준

- 상태: 배정 범위 구현 종료, 통합 및 웹 실행 검증 대기. 웹 검증 blocker가 있으므로 전체 완료로 처리하면 안 된다.
- Worktree: `<세션 worktree 루트>/b02-11-skills-wire`
- Branch: `parallel/b02-skills-wire`
- 공통 기준 SHA 및 시작 HEAD: `bc797b36cd0c09ce41eb675d7d152ce95ffa7ef1`
- `ENTRY.md` 절차에 따라 원본 준비 표의 경로·브랜치가 모두 일치하는 11번을 선택했다. 기준 SHA와 merge-base가 같고 시작 상태는 clean이었다.
- 세션 조회는 `session: cross-session control is unavailable in this runtime`으로 실패했다. 다른 세션에 메시지·승인·슬롯을 요구하지 않았다.
- `TODO.md`, dependency/lockfile, 다른 기능 파일은 수정하지 않았다. push·merge·배포·서비스 조작은 하지 않았다.

## 소유 변경과 제공 동작

| 경로 | 변경 |
|---|---|
| `src/skills/mod.rs`, `src/skills/api.rs` | 기존 catalog/selection 재사용, 서버 승인 root를 capability로 한정, 인증된 API, 세션별 선택 저장, 모델 지침 조립 |
| `src/lib.rs` | 스킬 route 3개 등록. 기존 `pub mod skills;` 유지 |
| `src/store.rs` | MIGRATIONS 끝에 `session_skills` migration 1개 추가 |
| `src/runner.rs` | `load_step`의 system 지침 조립 한 곳에서 검증된 선택 본문 추가 |
| `tests/skills.rs` | 기존 catalog 12개에 실제 HTTP·저장·동시성·로컬 모델 fixture 회귀 5개 추가 |
| `web/app/api/skills.ts` | 스킬 wire type과 typed API 함수 |
| `web/app/components/skills/types.ts` | API type을 단일 정의로 사용하고 기존 binding helper 유지 |
| `web/app/components/skills/SkillsPanel.tsx`, `web/app/components/skills/SkillsPanel.test.ts` | 모델 미적용 문구를 실제 명시적 선택·재검증 규칙으로 교체 |
| `web/app/components/skills/SessionSkills.tsx` | 조회·본문·선택·해제 요청, 인증 epoch/요청 순서 차단, 결과 유실 시 같은 key로 확인 |
| `web/app/components/Composer.tsx` | 세션 입력창에 `대화 스킬` disclosure 한 곳 mount |
| `web/e2e/skills.spec.ts` | 선택·실제 응답 유실 복구·모델 입력·변경/삭제·해제 및 늦은 이전 세션 응답 시나리오 2개 작성 |
| `work/RESULT-11.md` | 이 인계 |

### 서버 권한·root 정책

- 전역 출처는 서버가 설정한 `Config.data_dir/skills/`, 프로젝트 출처는 서버가 구한 세션 실행 root의 `.agents/skills/`다. 세션이 worktree를 사용하면 그 실행 root를 따른다. 임의 HOME 스킬 디렉터리는 읽지 않는다.
- root는 `ProjectFs`로 연 서버 승인 부모의 `Dir.open_dir`로 좁힌다. `ProjectFs`의 절대→상대 경로 변환 기준은 부모에 유지하고 실제 I/O capability만 하위 root로 바꿔 기존 bounded read·일반 파일·symlink 경계를 재사용한다. 확인 후 ambient 하위 경로로 다시 여는 fallback은 없다.
- 부모 내부 상대 symlink root는 허용한다. 부모 밖으로 나가는 root·절대 symlink는 capability 정책으로 거부한다. source root_id에는 승인 부모와 canonical 상대 target의 native bytes hash가 들어간다. root target·프로젝트 위치가 바뀌면 기존 선택과 매칭하지 않는다.
- 없는 스킬 디렉터리는 빈 출처다. 허용 root 열기 자체의 권한·형식 오류는 요청 전체 오류이며 조용히 다른 출처로 대체하지 않는다.
- client의 path/root_id/project_id를 root 승인에 사용하지 않는다. Principal, 활성 세션·프로젝트, `sessions::exec_root`, 현재 허용 root를 요청마다 확인한다. UI 요청은 `project_resources.ui_read` lease를 응답 생성까지 보유하며 대기 후 인증도 다시 검사한다.
- 저장 선택은 `{id, source, revision}` 원본 그대로다. 하나라도 stale/누락/alias 충돌이면 전체 모델 입력 적용을 거절한다. 최신 revision으로 바꾸거나 부분 적용하지 않는다.
- 선택된 본문만 JSON 문자열로 system 지침에 추가한다. **자동 매칭 없음**. metadata는 해석하지 않으며 본문은 도구 권한·승인이나 상위 안전 규칙 변경 근거가 아니다. 스킬 본문을 직접 실행하지 않는다.
- system 입력에 스킬이 포함되므로 기존 native resume의 system hash 비교도 그 내용을 포함한다. 외부 CLI 모델 실행은 검증하지 않았다.

## Public API·export·오류·저장 계약

| 경로 | 입출력 |
|---|---|
| `GET /api/v1/sessions/{id}/skills` | `{listing: SkillListing, selected: SkillSelection[], validation_error: {code,message} \| null}`. stale 선택은 보존하고 원인을 알린다 |
| `POST /api/v1/sessions/{id}/skills/body` | `{selection}` → `{selection,text}`. 읽기 전용이며 현재 출처·revision을 재검증한다 |
| `PUT /api/v1/sessions/{id}/skills/selection` | `{selection,selected: boolean}` → `{selected: SkillSelection[]}`. `Idempotency-Key` 필수 |

- 모든 route는 기존 `Principal` 인증을 사용한다. 본문·선택 요청의 최상위 미지 필드는 거절하며, selection의 어느 필드도 ambient 경로로 역변환하지 않는다.
- 선택 변경은 기존 `idem::run` transaction으로 저장·이벤트·receipt를 함께 확정한다. 같은 binding 재선택 및 해제는 새 key여도 멱등이며, 상태가 실제로 바뀔 때만 `session.skills_changed`를 낸다.
- replay도 현재 인증·세션·프로젝트·허용 root 검사를 거친다. 같은 key의 다른 요청은 `idempotency_conflict`, 없는 key는 `invalid_request`다. 저장된 replay 응답은 현재 상태와 다를 수 있으므로 화면은 성공 뒤 GET을 다시 읽는다.
- tool 오류는 표준 `ApiError` body로 매핑한다: `skill_not_found` 404, `skill_forbidden` 403, `skill_changed`/`selection_conflict` 409, 나머지 catalog 제한·형식 오류 422. root/OS 경로·본문은 오류나 이벤트에 넣지 않는다.
- 원래 binding으로 변경·삭제된 본문을 해제할 수 있다. 단, 보관된 세션·프로젝트나 root 열기 권한 오류는 해제 요청도 거절하므로 해당 문맥을 먼저 복원해야 한다.
- migration은 `sessions`와 SQLite JSON 함수만 사용한다. `session_skills(session_id PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE, bindings TEXT)`이며, 다른 신규 migration에 의존하지 않는다. 통합 시 순서 변경이 가능하다.
- Rust export: `skills::api::{list,inspect,select,model_instructions,SessionSkills,SkillProblem,Inspect,Select}`. 기존 catalog export는 유지한다.
- Web export: `skillsApi.{list,inspect,select}`, `SkillSource/SkillSelection/SkillEntry/SkillBody/SkillListing/SessionSkills`. Rust projection과 대응하는 typed 수동 wire 정의이며 generated registry를 변경하지 않았다.
- `SessionSkills({sessionId})`는 session/project별 key로 mount한다. `SkillsPanelProps` 계약은 유지한다. 닫힌 disclosure에서는 조회하지 않는다.
- 인증 epoch 변경·unmount·이전 요청은 응답을 폐기한다. 인증 refresh처럼 epoch가 그대로면 정상 응답을 사용한다. 결과 불명 변경은 자동 반복하지 않고 같은 key의 `같은 요청 결과 확인`만 제공한다. 닫기/새로고침 후에는 서버 선택 상태를 다시 조회한다.
- 별도 store/API 공통 연결은 남지 않았다. 다른 화면 사본의 실시간 선택 동기화는 제공하지 않으며 `스킬 새로고침`으로 서버 상태를 읽는다.

## 실제 검증

검사 전에 기존 `<원본 저장소>/.dev`를 가리키는 로컬 `.dev` symlink를 사용하고 `source .envrc.dev`를 적용했다. 의존성 설치·다운로드·통째 복사는 하지 않았다. 이 symlink는 검증 후 제거했다. 실행 파일은 호스트 공용 cargo cache에 생성됐으며 실제 로그의 경로는 `/home/ubuntu/.cache/cargo-build/0c/a57d71094bfb80/debug/deps/`다.

| 명령 | 결과 |
|---|---|
| `source .envrc.dev && CARGO_TARGET_DIR=<원본 저장소>/target CARGO_BUILD_JOBS=2 npm_config_offline=true npm_config_yes=false python3 scripts/build.py test --rust skills --vitest app/components/skills/SkillsPanel.test.ts --typecheck` | Rust 컴파일 및 `tests/skills.rs` **17개 통과**. 이후 typecheck가 exit 127, `sh: 1: react-router: not found`로 실패. 전체 명령 exit 127, Vitest는 실행기에서 미실행으로 표시 |
| `source .envrc.dev && CARGO_TARGET_DIR=<원본 저장소>/target CARGO_BUILD_JOBS=2 npm_config_offline=true npm_config_yes=false python3 scripts/build.py test --lib --filter store::tests` | migration·기존 데이터 보존 관련 library 시험 **7개 통과**, 173개 미선택, exit 0 |
| `git diff --check` | whitespace 검사 통과 |

- Rust API 회귀는 승인된 전역/프로젝트 root, 익명·위조 요청, 본문 조회, 선택 충돌, 세션 격리, 재시작 보존, 같은 요청 replay, missing key, 상태변경 이벤트 1회, 프로젝트 보관 후 replay 거부를 확인했다.
- 동시 선택이 한 binding만 남는 것, 프로젝트 위치/내부 root target 변경 시 원본 binding이 stale로 남는 것, 외부 root symlink 거부도 통과했다.
- 로컬 HTTP 모델 fixture가 수신한 실제 system 입력에서 선택 원문과 JSON quoting을 확인했고 미선택 본문은 없었다. 선택 본문의 변경·삭제 후 turn은 실패하며 추가 모델 요청은 없었고, 해제 뒤 다음 요청에는 이전 본문이 없었다.
- 웹 dependency 환경이 없어 typecheck를 마치지 못했다. Vitest 7개와 신규 E2E 2개는 **미실행**이다. COMMON에 따라 E2E/debug 웹 빌드/전체 회귀/release/패키징은 독립 작업에서 실행하지 않았다.
- Linux 임시 fixture에서만 실행했다. Windows 경로·junction·symlink 및 실제 외부 모델/CLI는 미검증이다.

## TODO별 상태와 다음 통합 단계

| TODO | 이번 근거 | 남은 조건 |
|---|---|---|
| `RESOURCE-010` | catalog→인증 API→세션 저장→Composer→runner 연결, Rust 모델 fixture·저장·해제 회귀 통과 | 웹 typecheck·Vitest·E2E 실행 및 실제 화면 통합 검증. 아직 전체 완료 아님 |
| `RESOURCE-012` | 승인 root·우선순위·충돌·내부 alias·외부 symlink·root 재지정·프로젝트 이동 회귀 통과 | 기존 metadata alias/다른 root 간 alias/hardlink 미지원은 유지. Windows 및 실제 화면 검증 필요 |
| `RESOURCE-014` | 사용자 선택만 다음 모델 입력에 적용, 자동 매칭 없음, source/revision 재검증·실패 시 전체 거절을 코드·화면·모델 지침에 명시 | 규칙의 웹 표시·응답 유실 및 늦은 응답 E2E 확인 필요 |

통합 담당은 준비된 웹 의존성 환경에서 typecheck와 `app/components/skills/SkillsPanel.test.ts`, `e2e/skills.spec.ts`를 실행하고 Composer 공통 변경 및 12번 provider 이미지 경로와의 결합을 확인해야 한다. Rust 17개 및 store 7개는 관련 입력이 그대로면 재사용할 수 있다. 모든 요구와 필수 검증을 확인한 뒤에만 `TODO.md`를 갱신한다.

현재 blocker는 웹 dependency 환경과 그로 인한 웹 검증 미완료다. `RESOURCE-011` 스킬 추가·저장·reload·활성화는 이 작업 범위가 아니며 구현하지 않았다.
