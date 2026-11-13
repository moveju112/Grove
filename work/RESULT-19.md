# b02 / 19 — Git stash·discard 인계

## 식별·상태

- worktree: `/home/ubuntu/.local/share/paseodog/paseo/worktrees/0q796rug/b02-19-git-stash`
- branch: `parallel/b02-git-stash`
- 공통 기준: `bc797b36cd0c09ce41eb675d7d152ce95ffa7ef1`
- 원본 `work/ENTRY.md`·README의 절대 경로와 브랜치가 정확히 일치하는 19번을 선택했고, `git merge-base HEAD <기준>`도 위 SHA였다.
- 시작 시 Git 변경은 없었다. 세션 목록 조회는 `session: cross-session control is unavailable in this runtime`으로 제공되지 않았다. 다른 세션의 변경을 인수하지 않았다.
- 구현 편집 종료, **필수 검증 blocker·통합 대기**다. Rust 컴파일·타입·실행 검증은 완료하지 못했으며 제품 완료로 판단하면 안 된다.
- `TODO.md`는 소유 범위 밖이므로 변경하지 않았다. `GIT-005`의 `[ ]`를 유지한다.

## 소유 변경

| 경로 | 제공 내용 |
|---|---|
| `src/git.rs` | stash 목록·명시적 저장, pop/discard 검토·확인 handler, 공유 stash 잠금·fingerprint·충돌 보존 |
| `src/lib.rs::router` | 아래 네 API route 추가 |
| `tests/git_stash.rs` | 격리 저장소 HTTP 회귀 시험 9개 작성 |
| `web/app/components/GitPanel.tsx` | 실제 Git 패널의 stash 저장·목록·pop·파일 discard 연결, 기존 결과 불명 복구 재사용 |
| `web/app/components/git/types.ts` | `ReviewAction`, `GitReview`, `ConfirmGitBody`, `Stash`, `confirmationBody` |
| `web/app/components/git/GitConfirmation.tsx` | native modal dialog, 대상·요약·위험 표시, 취소·명시적 실행 |
| `web/app/components/git/GitConfirmation.test.ts` | 확인 화면·요청 대상 유지·HTML escaping 단위 시험 4개 작성 |
| `web/e2e/git-stash.spec.ts` | 실제 서버·화면 흐름 5개 작성 |
| `work/RESULT-19.md` | 이 인계 |

dependency·lockfile·migration·공통 store·runner·설정은 변경하지 않았다.
기존 Git API는 JSON 응답과 클라이언트 generic 타입을 사용하므로 `generated.ts`를 수동 변경하지 않고 전용 UI 타입을 사용했다.
새 handler는 router에 연결됐고, 새 UI도 기존 Git 패널에 연결됐다. 미등록 standalone 모듈이나 가짜 실행기는 없다.

## API·권한·오류 계약

공통 prefix는 `/api/v1/projects/{id}/git`다.

| API | 입력 | 결과 |
|---|---|---|
| `GET /stashes` | 없음 | `{stashes:[{oid,reference,subject}]}` |
| `POST /stash-save` | `{message,expected_fingerprint}` | tracked index·작업 트리 변경만 저장, `{stashes,untracked_included:false,fingerprint}` |
| `POST /review` | 아래 `ReviewAction` | `{action,paths,summary,expected_fingerprint}`, 변경 없음 |
| `POST /confirm` | `{action,expected_fingerprint,confirmed:true}` | discard `{discarded,fingerprint}` 또는 pop `{popped,fingerprint}` |

`ReviewAction`은 `{operation:"discard",paths:string[]}` 또는 `{operation:"stash_pop",stash_oid:string}`다.
저장용 fingerprint는 기존 status API에서 얻고, confirm용 fingerprint는 review 응답 그대로 사용한다.

- `Principal`, `root_of`, `check_path`, 기존 `mutate`의 인증 재검증·프로젝트 자원 잠금·Git 직렬화·이벤트·idempotency receipt를 재사용한다.
- linked worktree는 stash를 공유하므로 canonical `git-common-dir`를 키로 추가 잠금을 잡는다. 새 stash-save/confirm끼리는 프로젝트가 달라도 공유 stash를 직렬화한다.
- 검토 fingerprint는 root·action·기존 HEAD/status/index/작업 트리 fingerprint·stash 목록과 OID·non-ignored untracked 파일 내용/symlink 대상을 묶는다. 요약을 만들기 전후 상태도 대조한다.
- 확인 뒤 상태·대상·stash 목록이 달라지면 `409 stale_diff`로 거부한다. 없는 stash OID는 `409 stash_changed`, 확인 false는 표준 invalid 오류다.
- discard는 선택한 변경 tracked 파일의 index와 작업 트리를 HEAD로 되돌린다. 디렉터리·광범위 pathspec을 받지 않으며 새 Git 명령에 `--literal-pathspecs`와 `--`를 사용한다.
- untracked 삭제 기능은 제공하지 않는다. staged deletion과 같은 경로에 생긴 untracked/ignored 파일도 거부한다. 새로 stage된 파일은 tracked 파일로 취급하므로 명시적 discard 대상이 될 수 있다.
- pop은 선택 OID를 `stash apply --index`로 적용하고, 성공 및 stash 참조 재확인 뒤에만 drop한다. `--index`를 쓰므로 stage 상태도 복원한다.
- 적용 실패 시 `409 stash_conflict`와 `{stash_oid,stash_retained:true,status}`를 제공한다. 실제 충돌·부분 적용 상태를 되돌리거나 stash를 삭제하지 않는다.
- 적용 후 drop 실패/목록 변경은 성공으로 숨기지 않으며 `applied:true,stash_retained:true`를 오류 details에 남긴다.
- 저장할 tracked 변경이 없으면 `409 nothing_to_stash`, 기타 Git 실패는 기존 `git_failed`다.
- 전송 실패·서버 오류·결과 저장 실패는 기존 결과 불명 처리와 같은 요청 키 재확인 경로를 유지한다. 자동 재실행이나 새 키로의 자동 재시도는 없다.

`GitConfirmation` props는 `{projectId,review,onConfirm,onCancel}`다.
`review`의 경로·요약·stash OID·index 영향·삭제/충돌 위험을 보여 주고, 취소를 기본 focus로 두며 Escape도 취소한다.
프로젝트가 바뀌면 검토 화면을 버린다. 별도 애니메이션·dependency는 추가하지 않았다.

## 검증 근거·blocker

실행 전 매번 `/home/ubuntu/.config/environment.d/60-build-storage.conf`를 `set -a; source ...; set +a`로 적용했다.
공통 cache·병렬도 설정은 변경하지 않았다.

| 실제 실행 명령 | 결과 |
|---|---|
| `set -a; source /home/ubuntu/.config/environment.d/60-build-storage.conf; set +a; python3 scripts/build.py test --rust git_stash git git_receipts --vitest app/components/git/GitConfirmation.test.ts --typecheck` | exit 1. Rust 단계 시작 시 `FileNotFoundError: [Errno 2] No such file or directory: 'cargo'`. 컴파일·Rust 시험은 시작되지 않았고, 뒤의 typecheck·Vitest는 미실행 |
| `set -a; source /home/ubuntu/.config/environment.d/60-build-storage.conf; set +a; python3 scripts/build.py test --typecheck --vitest app/components/git/GitConfirmation.test.ts` | exit 127. `sh: 1: react-router: not found`. typecheck 완료 실패, Vitest 미실행 |
| `git diff --check` | 통과. 당시 tracked 변경의 공백 검사이며 컴파일·동작 검증이 아님 |

위 환경 실패 이후에도 소유 범위의 안전성 검토와 수정은 마쳤지만, 도구/의존성이 바뀌지 않아 동일한 실패 명령을 반복하지 않았다.
설치·의존성 복사·다른 worktree의 산출물 사용·우회 실행은 하지 않았다.
Rust 9개·Vitest 4개·E2E 5개는 작성 수이며 통과 수가 아니다.
E2E·전체 회귀·release는 COMMON 계약상 통합 단계로 남겼다. 실제 Windows 실행·브라우저 focus/모바일 표현도 미검증이다.

## GIT-005 충족 범위·다음 통합 단계

실제 Git 화면과 서버 route에 stash save/list/pop 및 파일 discard를 연결했고, 확인 화면·fingerprint 거부·untracked 보존·충돌 보존·같은 키 복구를 구현했다.
시험은 저장/목록/pop/index 복원, 빈 저장/stale 저장, 충돌과 receipt 재생, stash 목록/untracked 내용 변경, discard 확인·취소·stale·대상 변조, literal 파일명·경로 공격, 인증, linked worktree 동시 pop을 다룬다.
다만 필수 실행 검증이 전부 남아 있으므로 `GIT-005` 완료 후보로 단정하지 않는다.

통합 담당이 승인된 기존 개발 환경을 준비한 뒤 다음 선택 검사를 실행해야 한다.

1. `python3 scripts/build.py test --rust git_stash git git_receipts --typecheck --vitest app/components/git/GitConfirmation.test.ts`
2. 공통 E2E 실행이 겹치지 않을 때 `python3 scripts/build.py test --e2e e2e/git-stash.spec.ts e2e/git-recovery.spec.ts`
3. 충돌 표시·native dialog focus/취소·응답 유실 복구와 API/router 교차 경계를 확인하고 전체 요구가 충족됐을 때만 `TODO.md`를 갱신한다.

추가 공통 mount나 route 연결은 필요하지 않다. 다른 병렬 작업의 `src/lib.rs::router` 추가와는 route 줄을 모두 보존하면 된다.
임의 외부 셸/Git 프로세스는 서버 잠금에 참여하지 않으므로 파일시스템 전체를 원자적으로 고정한다고 주장하지 않는다.
discard는 선택 경로만 처리하며 rename 원본 등 다른 경로를 자동으로 추가하지 않는다.
실제 사용자 저장소의 stash/reset/restore/clean이나 서비스 변경은 실행하지 않았다.
인계 후 로컬 커밋만 남기고 편집을 종료하며 push·merge·배포는 하지 않는다.
