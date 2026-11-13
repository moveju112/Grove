# b01 / 01 — 스킬 탐색·조회·명시적 선택

## 상태·기준

- 상태: 독립 구현 종료, 공통 연결·실행 검증 대기. 제품 기능 전체 완료가 아니다.
- Worktree: `<세션 worktree 루트>/b01-01-skills`
- Branch: `parallel/b01-skills`
- 공통 기준 SHA: `c186b31ab62734c9f91803cf7848b639ad9871fb`
- 시작 시 HEAD가 공통 기준과 같고 Git 상태가 clean이었다. `ENTRY.md`와 `README.md`의 경로·브랜치 양쪽 일치로 01을 선택했다. 앞선 00 지정으로는 편집하지 않았다.
- 소유 범위 밖 파일·의존성·TODO·공통 등록은 수정하지 않았다. push·merge·배포·서비스 조작은 하지 않는다.

## 소유 변경 파일

- `src/skills/mod.rs`
- `tests/skills.rs`
- `web/app/components/skills/types.ts`
- `web/app/components/skills/SkillsPanel.tsx`
- `web/app/components/skills/SkillsPanel.test.ts`
- `work/RESULT-01.md`

## 제공 동작·지원 형식

- 허용 root 바로 아래 `<name>/SKILL.md`만 비재귀 탐색한다. 이름은 디렉터리명이며 대소문자를 포함한 정확한 문자열로 동명을 판별한다.
- 저장소에 스킬 전용 parser가 없고 기존 `definitions::split_front_matter`만 있으므로 새 YAML parser나 임의 metadata 파싱은 추가하지 않았다. UTF-8 원문 전체를 표시하며, 기존 helper가 식별한 front matter는 미해석 상태로 표시한다. metadata의 name·description·alias·도구·platform 요구를 추측하지 않는다. CRLF 등 helper가 인식하지 않는 구분자도 원문 그대로 보존한다.
- source·이름으로 안정적인 opaque ID를 만들고 원문 전체 bytes의 SHA-256을 revision으로 사용한다. 목록에는 본문·실제 root·symlink 대상 절대 경로를 넣지 않는다.
- 프로젝트가 전역보다 우선한다. 같은 tier의 동명 항목은 충돌이고 자동 winner를 만들지 않는다. 상위/동급 동명 후보의 읽기가 실패하면 `incomplete`로 표시해 전역 후보를 확정 우선순위로 오표시하지 않는다.
- 상대 symlink는 기존 capability가 허용하는 root 내부에서만 따라간다. 같은 root의 동일 canonical 상대 파일 경로는 alias로 표시하며 실제 비-symlink 항목을 우선 대표로 삼는다. dangling·외부·순환 symlink·특수 파일은 읽을 수 있는 스킬에서 제외하고 issue로 표시한다.
- 본문 조회는 목록 ID와 source·revision을 대조한 뒤 capability I/O, live hash, canonical target을 재확인한다. 원문 변경·삭제·alias retarget을 조용히 새 내용으로 대체하지 않는다.
- 명시적 선택은 shadowed/conflict 후보도 정확한 ID로 지정할 수 있다. 동명 또는 동일 root target의 중복 선택은 거부하며 먼저 명시적으로 해제해야 한다. 같은 binding의 재선택과 해제 재전송은 멱등이다.
- 선택 상태의 재검증은 하나라도 stale/중복 alias이면 전체 실패한다. 실패 시 부분 본문은 반환하지 않는다. 삭제·변경된 선택도 원래 binding으로 해제할 수 있다.
- 본문 상한 64 KiB, 스킬 상한 256, 전체 탐색 entry 상한 4096, root 상한 16이다. 스킬/탐색/root 한도 초과는 불완전한 목록의 우선순위를 내놓지 않고 전체 실패한다.
- UI는 주입된 목록·본문·선택·오류와 typed callback만 사용한다. API·store·localStorage를 직접 호출하지 않는다. 본문을 React 텍스트로만 표시하고 HTML/명령/파일 링크로 실행하지 않는다. loading·오류·revision 불일치 시 이전 본문과 선택 버튼을 재사용하지 않는다. stale·누락 선택은 보존하고 해제를 제공한다.
- UI의 선택 표시는 항상 모델 미적용이다. 자동 매칭·원문 수정·설치·삭제·다운로드·hook·모델 입력 연결은 구현하지 않았다. 정적 조회 UI이므로 별도 애니메이션은 넣지 않았다.

## Public export·입출력·오류

### Rust

- `SkillSource::{Global { root_id }, Project { root_id, project_id }}`: 서버가 승인한 출처의 식별자. 하나의 catalog에 서로 다른 project_id 또는 중복 root_id를 넣으면 거부한다.
- `AllowedRoot::open(source, path) -> ToolResult<AllowedRoot>`: 신뢰된 서버 코드가 **이미 허용한 실제 source root**만 전달한다. 경로를 deserialize하지 않으며 인증·root 승인·project_id 소유권 검증을 대신하지 않는다. root가 바뀌면 root_id도 바꿔야 한다.
- `SkillCatalog::discover(Vec<AllowedRoot>) -> ToolResult<SkillCatalog>`: 열린 root에 한정된 snapshot을 만든다. root 열기/열거 실패는 전체 오류, 개별 후보 실패는 `SkillListing.issues`다.
- `SkillCatalog::listing() -> &SkillListing`: `entries`와 `issues` projection.
- `SkillEntry::selection() -> SkillSelection`: `{ id, source, revision }` binding.
- `SkillCatalog::read(&SkillSelection) -> ToolResult<SkillBody>`: `{ selection, text }`, 최대 64 KiB. 식별자를 경로로 역변환하지 않는다.
- `SkillSelections::{default, bindings, select, deselect, validate}`: 메모리 내 명시적 선택 집합. `select`는 live 검증 후 상태 변경, `deselect`는 정확한 기존 binding 제거, `validate`는 실제 소비 직전 전부 재검증한다. DB 저장·요청 동기화·모델 적용 기능은 없다.
- 데이터형: `SkillEntry`, `SkillSelection`, `SkillBody`, `SkillListing`, `DiscoveryIssue`, `SkillPriority` (`preferred/shadowed/conflict/incomplete`), `MetadataSupport` (`none/opaque_front_matter`).
- 기존 `ToolResult`/`ToolError`, `ProjectFs`, `util::sha256_hex`, `definitions::split_front_matter`를 재사용했다. 새로운 모델 도구가 아니라 조회 모듈이므로 registry·`Planned`·plan/execute 등록은 추가하지 않았다.
- 주요 오류 code: `invalid_source`, `skills_limit`, `skill_not_found`, `skill_forbidden`, `skill_too_large`, `unsupported_format`, `skill_read_failed`, `skill_changed`, `selection_conflict`. 목록 issue에는 `unsupported_name`도 있다.
- 오류 message는 정적인 안전 문구다. OS 오류 원문·본문·root·symlink 대상 경로를 로그/응답에 넣지 않는다.

### Web

- `SkillsPanel` / `SkillsPanelProps`: `listing: SkillListing | null`, `selected: readonly SkillSelection[]`, `preview: SkillBody | null`, `loading`, 선택적 `busy/error`, 필수 `onInspect/onSelect/onDeselect`.
- callback 입력은 화면에 표시된 정확한 `{ id, source, revision }`이다. 현재 목록과 다른 오래된 선택의 해제에는 그 원래 binding을 전달한다.
- `types.ts`에서 wire type과 `bindingOf`, `sameSource`, `sameSelection`, `sourceLabel`, `selectionStatus`를 export한다.
- 웹 type은 Rust projection의 수동 대응이다. API/generated binding 연결·실제 타입 검사는 통합 담당에게 남긴다.
- 부모는 요청·오류·busy 상태와 응답 순서/취소를 관리해야 한다. 인증 주체/프로젝트가 바뀌면 이전 목록·본문·선택을 폐기하고, 오래된 응답이 새 문맥을 덮지 않게 해야 한다.

## 권한·필요 공통 연결

1. `src/lib.rs`에 `pub mod skills;` 등록이 필요하다. 지금 모듈은 제품 컴파일 그래프에 들어가지 않는다. `tests/skills.rs`는 이 등록 후 실행해야 한다.
2. 인증된 `Principal`과 활성 프로젝트 root 결정을 기존 서버 경계에 연결해야 한다. 프로젝트 I/O에는 기존 `project_resources.ui_read` 수명과 권한 검사를 재사용하고, root는 서버가 승인한 스킬 디렉터리만 선택해야 한다. client path, root_id, project_id를 root 승인 근거로 신뢰하면 안 된다.
3. 전역 source root 허용 정책·인증과 프로젝트별 source root 결정은 아직 없다. `AllowedRoot::open`은 기존 `ProjectFs::open`을 사용하므로 최초 root를 여는 시점의 ambient 경로 승인 책임은 호출자에게 있다. 프로젝트 하위 경로를 승인할 때 symlink/교체로 프로젝트 밖 root를 승인하지 않도록 기존 경계에 연결해야 한다. 열린 뒤의 모든 조회는 capability를 사용하며 ambient fallback은 없다.
4. 목록/본문/선택/해제 API, `ToolError`의 API 오류 mapping, 선택의 세션별 저장·동시성/멱등 요청 처리는 미연결이다. 선택 binding 자체는 권한 증명이 아니므로 요청마다 현재 인증·프로젝트·허용 root를 다시 확인해야 한다.
5. `Settings` 또는 `Composer`의 적절한 위치에서 `SkillsPanel`을 import하고 조회 결과·선택 상태·callback을 주입해야 한다. 실제 라우트가 없는 API 호출은 만들지 않았다.
6. 모델 적용은 이번 범위 밖이다. 후속 구현이 적용한다면 기존 selection의 source/revision을 보존하고 소비 직전에 `validate`해야 한다. 선택을 다시 조회한 최신 hash로 몰래 갱신하면 안 된다.

## 실제 검사·미실행

| 명령·입력 | 실제 결과 |
|---|---|
| `git status --short --branch`, `git rev-parse --show-toplevel`, `git rev-parse HEAD` | 지정 worktree/branch와 정확히 일치, 시작 HEAD=공통 기준, clean |
| `python3 scripts/build.py test --vitest app/components/skills/SkillsPanel.test.ts --dry-run` | exit 0, 선택 Vitest 명령 출력만 확인. 시험 실행 아님 |
| `python3 scripts/build.py test --rust skills --vitest app/components/skills/SkillsPanel.test.ts --typecheck --dry-run` | exit 0, Rust integration·typecheck·Vitest의 선택 진입점과 순서 확인. 시험/컴파일 실행 아님 |
| `git diff --cached --check` | 스테이징된 소유 코드·시험의 whitespace 검사 통과 |

- Rust 계약 시험 12개와 웹 단위 시험 7개를 작성했지만 **실행 통과 근거는 없다**. 개수는 작성 범위이며 기능 완료율이 아니다.
- Rust 시험은 목록/metadata 비해석·안정 ID·전역/프로젝트 우선순위·동급 충돌·프로젝트 혼합 거부·위조 ID/source/revision·변경/삭제·상한·부분 실패 우선순위·alias 중복·외부/순환/dangling symlink·FIFO·root 교체·재탐색 alias 충돌을 다룬다.
- 웹 시험은 binding 동등성·원문 HTML escape·모델 미적용·loading/error/stale 본문 차단·누락 선택 해제·출처/충돌/alias/부분 오류·callback payload·중복/stale 선택 차단을 다룬다. 실제 브라우저 시험은 아니다.
- 이 worktree에는 `.dev` 및 `web/node_modules`가 없다. 설치·복사·다운로드·우회 실행은 하지 않았다.
- COMMON 지시에 따라 Rust 컴파일/통합 시험, 웹 typecheck/build, E2E, release/패키징은 실행하지 않았다. `src/lib.rs` 미등록 때문에 기존 검사 성공으로 이 모듈의 통과를 주장할 수도 없다.
- 실행한 시험의 실패는 없으며, 위 시험들은 미실행이다. Windows의 대소문자·UNC·junction·symlink/TOCTOU와 실제 UI 상호작용은 미검증이다.
- 개발 세션 조회는 런타임에서 `session: cross-session control is unavailable in this runtime`으로 실패했다. 다른 세션에 메시지·승인·슬롯을 요구하지 않았다.

## TODO별 남은 요구·통합 단계

| TODO | 이번 제공 범위 | 전체 요구 상태 |
|---|---|---|
| `RESOURCE-010` | 허용 root 발견→목록→본문→revision 기반 명시적 선택·해제 모듈과 주입형 UI | 부분 구현. 서버 등록·인증/API·선택 저장·실제 화면·필수 실행 검증·모델 적용이 남음 |
| `RESOURCE-012` | 전역/프로젝트 우선순위, 동명 충돌, 동일 root 상대 symlink alias, 탈출 거부 | 부분 구현·미검증. metadata alias와 다른 root 간 alias/hardlink 판별은 미지원. absolute symlink는 root 내부 대상이어도 capability 정책대로 거부하며 fallback하지 않음. 플랫폼 검증 필요 |
| `RESOURCE-014` | 사용자 명시적 선택은 우선순위 안내와 분리, 자동 대체/자동 매칭/적용 없음 | 부분 구현. 자동 매칭·실제 모델 적용 규칙과 연결은 범위 밖이며 전체 요구 완료 아님 |

현재 독립 구현을 막는 추가 계약 blocker는 없다. 다만 공통 연결·의존성 환경·실행 검증이 남아 있으므로 TODO를 완료 처리하면 안 된다. 통합 담당은 위 연결 후 선택 Rust/Vitest/typecheck를 실행하고 실제 서버→화면→선택 변경/해제·권한 변경·응답 순서·변경 본문 거부 흐름을 검증해야 한다. 실패하면 해당 검사를 수정·재실행하고, 남은 플랫폼/미지원 형식은 별도로 유지해야 한다.
