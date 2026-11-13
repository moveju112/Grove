# b02 / 28 — Grove 스킬 관리

## 상태와 기준

- 상태: 배정된 구현·연결과 선택 로컬 검증 종료. 브라우저 E2E 인수는 COMMON 계약에 따라 통합 단계 대기다. 전체 브라우저 사용자 흐름을 검증 완료했다고 주장하지 않는다.
- Worktree: `<세션 worktree 루트>/b02-28-skill-management`
- Branch: `parallel/b02-skill-management`
- 공통 기준 및 시작 HEAD: `551f551d48d1f47cd3ad67015f1737c62d576228`
- ENTRY의 원본 README 표에서 실제 top-level·branch가 일치하는 28번을 확인했고 시작 상태는 clean이었다.
- 다른 세션 접촉·위임·main 수정·TODO 수정·dependency 변경·merge·push·배포·workspace 삭제는 하지 않았다. 마이크 녹음·음성 입력·STT는 포함하지 않았다.

## 제공 동작과 소유 변경

| 경로 | 제공 동작 |
|---|---|
| `src/skills/management.rs` | 인증된 추가·본문 저장·켜기/끄기, 승인 root·쓰기 정책·revision 검사, 원자적 파일 저장, 기존 멱등 receipt를 이용한 결과 불명 처리 |
| `src/skills/mod.rs` | 활성 상태와 관리 세대를 catalog에 연결, 비활성 선택 거절, 비공개 추가 staging 제외, 내부 root alias의 읽기와 관리 경계 구분 |
| `src/skills/api.rs` | catalog 조회·세션 선택·모델 입력 재검증에서 DB 활성 상태를 같은 방식으로 반영 |
| `src/lib.rs` | 기존 세션 스킬 route 옆에 관리 route 한 곳 등록 |
| `src/store.rs` | MIGRATIONS 끝에 독립 `skill_states` migration 추가 |
| `tests/skill_management.rs` | 실제 HTTP·임시 파일/DB·로컬 모델 fixture 보안/충돌/복구 회귀 11개 |
| `web/app/api/skills.ts` | 관리 wire type과 `skillsApi.manage` |
| `web/app/components/skills/SkillEditor.tsx` | 전역/프로젝트 추가, 원문 편집, 편집 시작 revision 고정 |
| `web/app/components/skills/SessionSkills.tsx` | 기존 Composer mount 안에서 관리 흐름 연결, 초안 보존 reload, 같은 key 결과 확인과 불명 요청 닫기 |
| `web/app/components/skills/SkillsPanel.tsx` | 활성/비활성 표시·변경, 본문 편집 연결, 비활성 항목의 모델 선택 차단 |
| `web/app/components/skills/SkillEditor.test.ts`, `web/app/components/skills/SkillsPanel.test.ts` | 편집 binding·이스케이프·pending·비활성 선택·callback 검증 |
| `web/e2e/skill-management.spec.ts` | 추가·실제 전송 응답 유실·같은 key 복구·외부 변경 충돌·초안 보존·재활성화 후 명시적 재선택 시나리오 작성 |
| `work/RESULT-28.md` | 이 인계 |

`Composer.tsx`의 기존 `SessionSkills({sessionId})` mount와 프로젝트/세션별 key를 그대로 사용한다. 새 props나 추가 mount가 필요하지 않아 Composer는 수정하지 않았다. Settings 중복 화면·새 공통 store는 없다. `src/runner.rs`의 기존 `skills::api::model_instructions` 연결을 재사용하며 runner 수정도 없다. `src/source_settings/`와 실제 Claude/Codex 설정·정의는 수정하지 않았다.

## Public 계약과 연결

`PUT /api/v1/sessions/{id}/skills/management`는 기존 `Principal` 인증과 `Idempotency-Key`를 요구한다. 최상위 미지 필드는 거절한다.

| 요청 | 입력 |
|---|---|
| 추가 | `{op:"add", scope:"global" \| "project", name, text}` |
| 저장 | `{op:"save", selection:{id,source,revision}, text}` |
| 활성 변경 | `{op:"set_enabled", selection:{id,source,revision}, enabled:boolean}` |

- 성공은 HTTP 200의 `{id,revision,enabled}`다. 성공·replay 뒤 UI는 현재 GET catalog를 별도로 읽는다. replay 응답 자체를 최신 상태로 간주하지 않는다.
- `selection.revision`이 expected revision이다. 최신 본문과 같은 bytes를 보내도 오래된 expected binding이면 409다. 저장·활성 변경이 저장된 세션 binding을 수정하는 경로는 없다.
- 기존 GET은 `SkillEntry.enabled`를 추가로 반환한다. `selected`는 원래 `{id,source,revision}` 그대로이며 `validation_error`로 적용 차단을 알린다. 기존 body API는 비활성 본문도 관측할 수 있지만 select/model 적용은 거절한다.
- 관리 이력 없는 항목은 기존 원문 SHA-256 revision을 유지한다. 활성 상태가 실제로 바뀔 때마다 DB generation을 올리고 원문 hash와 함께 revision을 만든다. 다시 켜도 과거 선택이 자동으로 유효해지지 않는다. 같은 활성 값 또는 같은 본문의 정상 revision 저장은 no-op이고 변경 이벤트를 만들지 않는다.
- `skill_states(skill_id PRIMARY KEY, enabled, generation)`은 source를 포함해 만들어진 기존 ID로 상태를 구분한다. 다른 신규 migration에 의존하지 않는다. 전역 스킬 상태는 다른 프로젝트의 catalog에서도 동일하게 관측된다.
- Rust public export는 `skills::management::{Scope,Mutation,mutate}`다. 기존 catalog/selection 및 API export는 유지한다.
- Web export는 `SkillMutation`, `SkillChange`, `skillsApi.manage`, `SkillEditor`, `SkillDraft`, `SkillEditorProps`, `draftMutation`, `uncertainSkillResult`다. `SkillsPanelProps`에는 선택적인 `onEdit(body)`와 `onSetEnabled(selection,enabled)`만 추가했다. SessionSkills 외부 props는 그대로다.
- 공통 파일의 추가 연결은 남지 않았다.

## 보안·오류·복구

- 전역은 서버 `Config.data_dir/skills`, 프로젝트는 서버가 구한 `sessions::exec_root/.agents/skills`만 사용한다. client root/path를 입력으로 받거나 권한으로 신뢰하지 않는다.
- 현재 인증·활성 세션/프로젝트·실행 root·server/project/session의 모든 `tools.mode` 계층을 검사한다. 어느 계층이든 `read_only`면 거절한다. `project_resources.ui_write`와 기존 `storage.mutations` 잠금을 사용하며 대기 후와 접수/실행 transaction에서도 다시 검사한다. 진행 중 프로젝트 프로세스는 `resource_busy`로 거절한다.
- 읽기 catalog의 기존 내부 상대 symlink·alias 정책은 유지한다. 관리 API는 다른 위치로 연결된 root/상위 alias를 거절한다. 아직 skills root가 없어도 상위 `.agents` alias를 따라 Claude/Codex 폴더를 생성하지 않는다. symlink 항목의 본문 저장도 거절한다. hardlink/metadata alias 판별을 추가하지 않았다.
- 추가는 비공개 `.grove-skill-*` staging에 완성본을 쓰고 기존 `ProjectFs.rename_noreplace`로 게시한다. 저장은 같은 capability의 `atomic_write`를 사용한다. root/항목 존재·본문 revision은 접수 후 실행 직전에도 재검증한다. 중단된 staging은 catalog/선택 후보에서 제외하며 임의로 삭제하지 않는다.
- 파일 변경 전에 기존 `idem::run`으로 409 `result_unknown` receipt를 확정하고 완료 transaction에서 `idem::complete`와 `skill.changed` 이벤트를 함께 기록한다. 파일 저장 뒤 DB 확정 실패는 성공으로 숨기지 않는다. 응답은 `result_unknown`과 안전한 원인 code만 알리며 receipt는 불명 상태로 남는다. 같은 key는 실제 변경을 재실행하지 않는다.
- UI는 결과 불명/전송 중단 시 같은 key의 결과 확인만 제공한다. 새로고침은 관측만 하고 pending·편집 초안·편집 기준 binding을 바꾸지 않는다. 사용자가 불명 요청을 닫으면 catalog를 다시 조회해야 다른 저장을 할 수 있다. 초안은 메모리에만 있고 disclosure 닫기/화면 unmount/인증 종료 시 폐기된다.
- 인증 epoch·요청 순서·unmount 검사를 기존 경계로 유지한다. 원문은 textarea/pre의 텍스트이며 HTML/Markdown 실행이나 도구 권한으로 해석하지 않는다.
- 일반 오류는 기존 표준 API body를 사용한다. `skill_not_found` 404, `skill_changed`/`skill_disabled`/`already_exists`/`idempotency_conflict`/`resource_busy` 409, `skill_forbidden`/`skill_read_only` 및 read-only 정책 403, 형식·크기 제한 422다. 잘못된 이름·누락 key는 400이다.
- 이벤트/receipt 성공 응답은 ID·revision·enabled만 포함한다. 원문·파일명·root 경로·OS 오류 원문을 추가하지 않는다. 추가 import·실행·자동 매칭은 없다.
- 기존 파일/프로젝트 guard 범위를 재사용한다. filesystem과 SQLite가 하나의 원자 commit이 되는 것은 아니며, 그 사이의 실패는 영속 pending receipt와 명시적 관측으로 처리한다.

## 실제 검증

의존성 설치·복사 없이 `<원본 저장소>/.dev`와 `<원본 저장소>/web/node_modules`를 가리키는 작업 소유 symlink로 공용 환경을 사용했다. Rust는 지정 flock과 공용 cargo build cache를 사용했다. 이 symlink 두 개는 검증 후 제거했다.

| 실제 명령 | 결과 |
|---|---|
| `source <원본 저장소>/.envrc.dev && flock /home/ubuntu/.cache/grove-rust-check.lock python3 scripts/build.py test --rust skill_management skills` | 최종 Rust 컴파일, 관리 11개 및 기존 catalog/선택/모델 17개 통과, exit 0 |
| `source <원본 저장소>/.envrc.dev && flock /home/ubuntu/.cache/grove-rust-check.lock python3 scripts/build.py test --lib --filter store::tests` | migration/기존 데이터 보존 7개 통과, 179개 미선택, exit 0. 이후 migration/store 입력은 바뀌지 않아 재사용 |
| `source <원본 저장소>/.envrc.dev && python3 scripts/build.py test --vitest app/components/skills/SkillsPanel.test.ts app/components/skills/SkillEditor.test.ts --typecheck` | typecheck 및 Vitest 12개 통과, exit 0. 이후 웹 입력은 바뀌지 않아 재사용 |
| `git diff --check` | 공백 검사 통과 |

- 승인 root의 첫 생성·전역/프로젝트 저장·동시 저장의 단일 승자·같은 bytes의 stale 저장 거절·외부 변경 reload·재시작 후 원래 선택 보존을 확인했다.
- 실제 로컬 HTTP 모델 fixture에서 활성 선택 본문이 system 입력에 들어가며, 비활성 후 추가 모델 요청은 없음을 확인했다. 비활성 중 저장·재시작·다른 프로젝트의 전역 상태 조회·재활성화 후에도 기존 선택은 복구되지 않으며 해제/재선택 후에만 수정 본문이 적용됐다.
- 성공 후 실제 파일이 다시 바뀐 경우 같은 key replay가 원문을 재저장하지 않음을 확인했다. DB trigger로 파일 저장 후 receipt 확정 실패를 실제 유발했으며 파일은 저장됐지만 응답/receipt는 `result_unknown`이었다. 서버 재시작 뒤 같은 key도 재실행하지 않았다.
- 익명·위조 source·다른 프로젝트 binding·경로 이름 주입·NUL/크기 제한·read-only 세 계층·보관 프로젝트·실행 중 프로젝트 프로세스·외부 root symlink·원본 정의로 이어지는 내부 root/상위 alias를 검증했다. 이벤트와 receipt에 본문·경로가 없음을 확인했다.
- 검사 실패나 미해결 실패는 없다. 중간 통과 후 추가된 복구/보안 분기는 최종 관련 Rust 검사에 포함했다.
- COMMON에 따라 E2E·웹/debug 빌드·전체 회귀·release·패키징은 실행하지 않았다. 새 E2E 1개와 기존 `web/e2e/skills.spec.ts`는 통합 단계에서 실행해야 한다. Linux 임시 fixture만 검증했고 Windows/junction·실제 사용자 설정·외부 CLI/유료 모델은 미검증이다.

## RESOURCE-011 충족 근거와 남은 인수

| 요구 | 근거와 상태 |
|---|---|
| Grove 전역/프로젝트 추가·저장 | 승인 root에 연결된 인증 API와 기존 Composer 안의 폼 구현, 첫 생성/충돌/권한/동시 저장 HTTP 회귀 통과 |
| 다시 읽기 | 기존 GET catalog의 현재 파일/활성 상태 관측 재사용, 초안과 저장 binding 불변, 외부 변경·재시작 회귀 통과 |
| 켜기/끄기 | 영속 활성 상태와 관리 세대 연결, 비활성 적용 차단 및 재활성화 시 과거 선택 자동 부활 방지 회귀 통과 |
| 기존 세션 선택·모델 적용 | 기존 선택 API/runner 경로 재사용, 실제 로컬 모델 입력 및 실패 시 추가 호출 없음 확인 |
| 보안·충돌·복구 | 기존 guard/정책/파일 경계/receipt 재사용, 원본 root alias 쓰기 차단 및 저장 후 DB 확정 실패 회귀 통과 |
| 실제 브라우저 사용자 흐름 인수 | UI/typed API 연결과 단위/typecheck 완료. E2E는 작성했으나 미실행이므로 전체 인수 완료로 체크하면 안 됨 |

구현을 막는 blocker는 없다. 다음 통합 단계는 선택 E2E `e2e/skill-management.spec.ts`와 기존 `e2e/skills.spec.ts` 실행, 다른 migration 추가분과의 append 순서 통합 확인, 실제 인수 근거에 따른 RESOURCE-011 TODO 반영이다. 이 작업에서는 TODO를 갱신하지 않았다.
