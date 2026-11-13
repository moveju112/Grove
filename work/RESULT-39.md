<!-- grove-handoff:v1
{"state":"ready","remaining":[],"blockers":[],"integration_checks":["통합된 root에서 e2e/definition-updates.spec.ts 재실행","Settings::DefinitionEditor 충돌 해결 시 root의 기존 ServerActionButton·공용 serverActionGuard를 보존하고 신규 선택 적용·동일 요청 확인에도 동일 보호를 연결한 뒤 e2e/pwa-update.spec.ts 및 e2e/pwa-lifecycle.spec.ts로 확인"]}
-->

# 39 — AGENT-024 기본 정의 비교·선택 적용

- 상태: 고정 baseline에서 소유 구현·실제 mount·선택 인수 완료. blocker 없음. root 통합은 수행하지 않음.
- Worktree: `/home/ubuntu/.local/share/paseodog/paseo/worktrees/0q796rug/b02-39-definition-updates`
- Branch: `parallel/b02-definition-updates`
- 고정 기준: `eb841bb51dfde92a714f48189d02b0f568ad23c0`. `339f5167b1883d4db17134bd4277ffeee983f47b` 포함을 `git merge-base --is-ancestor`로 확인.
- 정본: `/data/project/paseodog_opus/work/ENTRY.md`, `/data/project/paseodog_opus/work/COMMON.md`, `/data/project/paseodog_opus/work/39.md` 및 README의 정확한 경로·브랜치 매칭.
- 초기 Git clean 확인. 개발 세션 조회는 런타임의 `session: cross-session control is unavailable in this runtime`으로 불가. 사용자 지시에 따라 런타임 설정·workspace 관리·위임은 하지 않음.

## 제공 동작·소유 변경

| 경로 | 동작 |
|---|---|
| `src/definitions.rs` | resolver는 변경하지 않음. 일반 update에서 보내지 않은 필드의 NULL/명시적 override를 그대로 보존. restore에 비교 baseline 검증을 선택 확장하고 빈 선택을 거절 |
| `tests/definition_updates.rs` | 기존 definitions 저장 형식으로 이전 override fixture를 생성. 읽기·재시작·선택 복원·disabled·baseline/revision 경합·권한·receipt 재사용 회귀 3개 |
| `web/app/components/definition-updates/model.ts` | 선택 필드·비교 snapshot·원래 idempotency key의 요청/복구 계약 |
| `web/app/components/definition-updates/DefinitionUpdates.tsx` | 현재 번들/현재 적용값의 이름·설명·본문 비교, 명시적 다중 선택 적용, 취소·다시 비교·응답 유실 복구 |
| `web/app/components/definition-updates/useDefinitionDraft.ts` | revision을 고정한 기기 내 본문 초안. 빈 본문도 reload에 보존하고 저장 공간 오류를 표시 |
| `web/app/components/definition-updates/definition-updates.css` | 전용 비교 표의 원문 줄바꿈·스크롤 |
| `web/app/components/definition-updates/model.test.ts` | 요청·재시작 복구·HTML escaping·손상 요청 거절·로그아웃 정리 3개 |
| `web/app/components/Settings.tsx` | `DefinitionEditor` 안에서 기존 전체 복원/본문 비교를 교체하고 초안 보존을 연결. 다른 Settings 영역·Definitions overview는 변경하지 않음 |
| `web/e2e/definition-updates.spec.ts` | 실제 인증 서버/Chrome에서 소유 사용자 흐름 3개 |
| `work/RESULT-39.md` | 이 인계 |

`assets/`, resolver, migration/updater/dependencies, 공용 API client/store/CSS, 생성 타입, Profiles/MCP/직접 링크 effect, `TODO.md`는 변경하지 않음.
읽기·비교·취소는 서버 mutation을 하지 않음. 과거 번들 원문·실제 사용자 DB·외부 계정/서비스를 변경하지 않았음.
긴 원문은 React text로 렌더하며 HTML을 실행하지 않음. 기존 스타일을 재사용하고 비교에 불필요한 애니메이션은 추가하지 않음.

## API·UI 연결 계약

- 기존 `POST /api/v1/definitions/{kind}/{id}/restore`를 그대로 사용. 라우트·권한·DB schema·응답 `DefinitionDetail` 변경 없음.
- `RestoreDef.expected_baseline?: { name: string, description: string, body: string, sha256: string }` 추가. UI는 비교 때 읽은 baseline 전체를 항상 보냄. 기존 raw `baseline_sha256` 의미를 유지하면서 agent metadata만 달라진 경우도 잡음.
- `expected_revision` 불일치는 기존 `revision_conflict`, 비교 baseline 불일치는 HTTP 409 `baseline_conflict`와 기존 `error` envelope 및 `details.current`를 반환. transaction 안에서 검사하므로 변경·이벤트·receipt를 남기지 않음.
- legacy 클라이언트의 baseline 생략·fields 생략(전체 복원)·기존 request hash는 유지. 명시적 빈 fields는 HTTP 400. 사용자 정의 복원은 기존대로 거절. 인증과 Idempotency-Key 요구도 그대로임.
- 명시적으로 고른 `name`, `description`, `body`만 NULL로 복원. 고르지 않은 값·enabled는 유지. 현재 기본값과 같은 명시적 override도 선택하여 해제 가능.
- 새 요청은 비교 snapshot과 key를 `grove.draft.definition-restore.<kind>.<id>`에 전송 전에 보존. 응답 유실/재시작 후 같은 본문·키만 재전송하며 새 mutation을 잠금. 성공 시 receipt 본문을 현재 상태로 덮어쓰지 않고 서버를 다시 조회하므로 이후 다른 기기 편집을 보존.
- 본문 초안은 `grove.draft.definition.<kind>.<id>`에 별도 보존. 복원 성공·실패·취소에 자동 삭제/저장하지 않음. 기존 auth cleanup의 `grove.draft.` 정리 범위에 포함됨.
- 초안 save는 작성 시점 revision을 사용. 서버 revision 변경 후 명시적 비교 및 “비교한 revision으로 초안 저장 준비”로만 새 revision을 채택. 자동 rebase/무음 덮어쓰기 없음. 편집 취소는 초안만 지움.
- public UI export `DefinitionUpdates`: `definition: DefinitionDetail`, `draft?: string`, `disabled?: boolean`, `onLocked(boolean)`, `onApplied()`, `onDraftReviewed(DefinitionDetail)`. `DefinitionEditor`에 실제 mount 완료. `useDefinitionDraft(kind,id)`는 `draft/error/write`를 반환.

## 실행 근거

모든 명령은 이 worktree에서 실행. 원본 환경을 source하고 baseline 실행기의 `build.DEV`만 프로세스에서 지정함.
`build.py` 수정이나 툴체인 설치/복사 없이 기존 공통 cache·병렬도·환경을 유지함.
없던 `web/node_modules`만 승인된 원본 공유 경로로 symlink 연결. 모든 Rust/E2E는 전체 builder 명령을 공용 잠금으로 직렬화했으며 타 검사 취소·포트 변경은 하지 않음.

최초 선택 검사:

```bash
source /data/project/paseodog_opus/.envrc.dev && flock /home/ubuntu/.cache/grove-rust-check.lock python3 -c 'import sys; sys.path.insert(0, "scripts"); import build; build.DEV="/data/project/paseodog_opus/.dev"; build.main(["test", "--rust", "definitions", "definition_updates", "--vitest", "app/components/definition-updates/model.test.ts", "--typecheck"])'
```

- Rust `definitions` 3개와 `definition_updates` 3개 통과. Rust 156.45s wall / 213.06s CPU.
- typecheck는 신규 E2E 배열 접근의 `TS2532: Object is possibly 'undefined'.`로 실패(8.67s wall / 11.9s CPU), 뒤 Vitest는 미실행. 실패를 숨기거나 전체 통과로 취급하지 않음.
- 알려진 요청 길이를 먼저 검증하는 시험의 배열 접근에 non-null assertion을 추가. 이후 다음 명령으로 typecheck(7.69s wall / 12.13s CPU), Vitest 3개(1.5s wall / 2.28s CPU) 통과:

```bash
source /data/project/paseodog_opus/.envrc.dev && python3 -c 'import sys; sys.path.insert(0, "scripts"); import build; build.DEV="/data/project/paseodog_opus/.dev"; build.main(["test", "--vitest", "app/components/definition-updates/model.test.ts", "--typecheck"])'
```

최초 브라우저 인수:

```bash
source /data/project/paseodog_opus/.envrc.dev && flock /home/ubuntu/.cache/grove-rust-check.lock python3 -c 'import sys; sys.path.insert(0, "scripts"); import build; build.DEV="/data/project/paseodog_opus/.dev"; build.main(["test", "--e2e", "e2e/definition-updates.spec.ts"])'
```

- 3개 통과. debug 서버 빌드 80.32s wall / 83.0s CPU, 웹 빌드 4.84s wall / 5.13s CPU, E2E 6.85s wall / 5.02s CPU.
- 이후 같은 값의 override도 선택 가능하도록 UI를 보완하고 해당 DB 회귀/E2E 기대를 추가. Rust 문서 주석과 완료 메시지도 정확화.

안정된 최종 입력의 영향 검사:

```bash
source /data/project/paseodog_opus/.envrc.dev && flock /home/ubuntu/.cache/grove-rust-check.lock python3 -c 'import sys; sys.path.insert(0, "scripts"); import build; build.DEV="/data/project/paseodog_opus/.dev"; build.main(["test", "--rust", "definition_updates", "--vitest", "app/components/definition-updates/model.test.ts", "--typecheck", "--e2e", "e2e/definition-updates.spec.ts"])'
```

| 단계 | 결과 | wall | CPU |
|---|---|---:|---:|
| Rust `definition_updates` | 3개 통과 | 43.79s | 10.32s |
| typecheck | 통과 | 11.02s | 11.72s |
| Vitest `model.test.ts` | 3개 통과 | 1.95s | 2.15s |
| debug 서버 빌드 | 통과 | 21.09s | 6.81s |
| 웹 빌드 | 통과 | 5.84s | 5.05s |
| Chrome desktop E2E | 3개 통과 | 7.37s | 4.94s |

기존 `definitions` 3개 통과는 이후 실행 코드 변경 없이 재사용. 마지막 검사 뒤 제품/시험 입력 변경은 없고 이 RESULT만 작성함.
실행기 시간은 단계 측정치이며 공용 잠금 대기 시간이나 생산성/절감량으로 해석하지 않음.
최종 원본 로그: `/home/ubuntu/.local/share/paseodog/mixdog/data/shell-output/shell_5e9ebbe4.stdout`, `/home/ubuntu/.local/share/paseodog/mixdog/data/shell-output/shell_5e9ebbe4.stderr`.
최초 실패 로그: `/home/ubuntu/.local/share/paseodog/mixdog/data/shell-output/shell_d3d4a4c5.stdout`, `/home/ubuntu/.local/share/paseodog/mixdog/data/shell-output/shell_d3d4a4c5.stderr`.
`git diff --check` 통과. 빌드의 React Router future flags 및 500 kB chunk 경고는 남아 있고 관련 없는 설정/코드를 고치지 않음.
전체 suite·release·모바일·외부 모델·실제 다른 번들 binary의 교체는 미선택. 이전 번들 상황은 기존 DB fixture와 이전 metadata의 브라우저 응답으로 검증했으며 실제 번들을 바꾸지 않았음.

## AGENT-024 충족·통합 경계

| 요구 | 근거 |
|---|---|
| 업데이트 후 사용자 수정본·enabled 보존 | 이전 override fixture가 현재 builtin과 함께 resolve되고 읽기·목록·서버 restart 뒤 동일. 일반 enabled update도 기존 명시적 override를 NULL로 바꾸지 않음 |
| 현재 기본값 비교·필드별 명시 적용 | 이름·설명·본문 원문 비교와 다중 선택. Rust/브라우저에서 미선택 본문·disabled 유지, 본문만 복원 및 reload 확인 |
| 취소·미저장 초안 | 취소 무변경, 선택 복원 후 초안 유지, reload 복구, 명시적 revision 확인 뒤 초안 저장 |
| stale baseline/revision·권한 | 각 baseline 필드·raw hash mismatch, concurrent revision, 빈/알 수 없는 선택, unauthenticated/key 누락, custom restore 거절 |
| 응답 유실·재시작·동시 편집 | HTTP commit 후 실제 transport abort, reload, 같은 본문/key 확인. Rust는 서버 restart 후 receipt 재조회. 이후 편집/revision은 그대로 유지 |

root의 후속 PWA 변경은 이 고정 baseline에 없으며 가져오거나 재구현하지 않았음.
현재 root `Settings::DefinitionEditor`의 저장·복원·삭제·enabled 버튼은 `ServerActionButton`을 사용한다는 점을 읽기 전용으로 확인함.
통합 충돌 해결 시 이 래퍼/기존 import/공용 API `serverActionGuard`를 native button으로 되돌리지 말 것.
새 컴포넌트의 “선택한 필드만 기본값 적용”·“원래 복원 요청 결과 확인”도 root의 동일 `ServerActionButton`을 재사용해 보호해야 함.
이 baseline에서 해당 후속 래퍼의 통합·PWA 인수까지 통과했다고 주장하지 않으며 위 `integration_checks`에 명시함.
41 Definitions overview, 37 직접 링크, 38 Profiles, 36 MCP의 변경과 독립된 `DefinitionEditor` 연결만 통합할 것.
관련 로컬 커밋만 수행하고 TODO 체크·merge/rebase·push·배포·workspace 정리는 하지 않음.
