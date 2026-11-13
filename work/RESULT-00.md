# b01 / 00 — 원본 설정의 읽기 전용 출처 보기

## 현재 상태

- 독립 구현 종료, **통합·실행 검증 대기**. 제품 기능 전체 완료는 아니다.
- worktree: `<세션 worktree 루트>/b01-00-source-settings`
- branch: `parallel/b01-source-settings`
- 공통 기준 SHA: `c186b31ab62734c9f91803cf7848b639ad9871fb`
- 시작 시 HEAD와 merge-base 모두 위 기준과 일치했고 Git 상태는 깨끗했다.
- 사용자 후속 요청의 `<원본 저장소>/work/ENTRY.md`에 따라 실제 Git top-level과 branch를 README 표에 다시 대조했다. 정확히 00 한 행과 일치했고, 당시 변경은 이 세션이 작성한 아래 소유 파일뿐이었다.
- 확인 가능한 이전 서버 세션 조회에서 같은 cwd에는 이 작업 세션 하나만 있었다.
- 독립 구현을 막는 blocker는 없다. 모듈 등록·권한·API·화면 연결과 실행 검증은 남아 있다.
- 로컬 커밋만 수행한다. push·merge·배포·서비스 중단은 하지 않는다.

## 소유 변경 파일

- `src/source_settings/mod.rs`
- `tests/source_settings.rs`
- `web/app/components/source-settings/types.ts`
- `web/app/components/source-settings/SourceSettingsPanel.tsx`
- `web/app/components/source-settings/SourceSettingsPanel.test.ts`
- `web/app/components/source-settings/index.ts`
- `work/RESULT-00.md`

공통 파일·dependency·lockfile·`TODO.md`는 수정하지 않았다.

## 제공 범위와 Rust 계약

`read_source(root: &Path, source: SourceId) -> SourceSettings`는 서버가 결정한 root와 고정 식별자만 받는 동기 조회 함수다. HTTP API나 모델 도구가 아니며 `ToolResult`·`ToolError`·`Planned` 기반 registry에 등록하지 않았다. 인증이나 권한 검사를 대신하지 않는다.

| `SourceId` / 직렬화 식별자 | 서버가 전달할 root | 고정 상대 파일 |
|---|---|---|
| `ClaudeUser` / `claude_user` | 서버가 결정한 Claude 사용자 설정 디렉터리 | `settings.json` |
| `ClaudeProject` / `claude_project` | 인가한 프로젝트 디렉터리 | `.claude/settings.json` |
| `ClaudeProjectLocal` / `claude_project_local` | 서버가 결정하고 인가한 로컬 설정 대상 프로젝트 디렉터리 | `.claude/settings.local.json` |
| `CodexUser` / `codex_user` | 서버가 결정한 Codex 사용자 설정 디렉터리 | `config.toml` |
| `CodexProject` / `codex_project` | 인가한 프로젝트 디렉터리 | `.codex/config.toml` |

User root는 home 자체가 아니라 각 CLI의 설정 디렉터리다. 환경 변수에 따른 설정 디렉터리 변경이나 Claude worktree/main checkout의 로컬 설정 위치 선택은 호출자의 책임이다. 조회 모듈은 환경 변수나 개인 설정을 직접 탐색하지 않으며 CLI의 최종 유효 설정이라고 주장하지 않는다.

Public export는 `SourceId`, `SafeSettings`, `ReadErrorCode`, `SourceFormat`, `SourceState`, `SourceSettings`, `MAX_SOURCE_BYTES`, `read_source`다. `SourceId::relative_path()`도 고정 경로만 반환한다.

응답은 `source`와 flatten된 `SourceState`다. 실제 절대 경로나 적용 여부 필드는 없다.

| `status` | 추가 필드 | 의미 |
|---|---|---|
| `present` | `projection`, `ignored_invalid_fields` | JSON 객체를 읽고 허용된 값만 반환 |
| `missing` | 없음 | 파일 또는 root 부재 |
| `read_error` | `code` | 읽기·파싱 실패, 원문이나 OS 오류 문자열 없음 |
| `unsupported_format` | `format: "toml"` | 경계 내 일반 파일 존재만 확인, 내용을 열거나 파싱하지 않음 |

`ReadErrorCode`는 `permission_denied`, `not_regular_file`, `too_large`, `invalid_json`, `invalid_shape`, `io`다. 허용 필드의 잘못된 타입·범위는 값 자체를 버리고 `ignored_invalid_fields: true`만 반환한다. 알 수 없는 필드는 이름도 반환하지 않는다.

Claude JSON의 명시적 허용 필드는 다음 네 개뿐이다.

| JSON 필드 | 반환 타입·제한 |
|---|---|
| `alwaysThinkingEnabled` | boolean |
| `autoCompactEnabled` | boolean |
| `autoMemoryEnabled` | boolean |
| `cleanupPeriodDays` | 0부터 `u32::MAX`까지 정수 |

없는 값·잘못된 값은 projection에서 생략하며 원본 기본값으로 채우지 않는다. `cleanupPeriodDays`는 표시 가능한 안전 정수 범위만 제한하며 Claude 전체 schema 검증을 대체하지 않는다. 필드가 하나도 없어도 원본이 비었다거나 Grove 기본값이 적용됐다고 표시하지 않는다.

기존 `crate::project_fs::ProjectFs`의 실제 capability I/O·일반 파일 검사·제한 읽기와 `crate::util::canonical`을 재사용했다. JSON 읽기 한도는 `MAX_SOURCE_BYTES = 256 * 1024`다. symlink로 source root 밖을 읽는 ambient fallback은 없다. 기존 `serde_json`만 사용한다.

원문·환경 변수·토큰·자격증명·명령·permissions 규칙·스킬 본문·모델명 등 임의 문자열을 반환하지 않는다. 원본 수정·적용·import·hook 실행·로깅도 하지 않는다.

필드와 기본 출처 위치를 확인한 문서:

- `https://code.claude.com/docs/en/settings`
- `https://code.claude.com/docs/en/settings-reference`

## 웹 계약

`web/app/components/source-settings/index.ts`에서 `SourceSettingsPanel`과 `ReadErrorCode`, `SafeSettings`, `SourceId`, `SourceSettings`, `SourceSettingsPanelProps`, `SourceSettingsView` 타입을 export한다.

`SourceSettingsPanelProps`는 `{ view: SourceSettingsView }`다.

- `{ status: "loading" }`
- `{ status: "error" }`
- `{ status: "ready", items: readonly SourceSettings[] }`

Rust 직렬화와 같은 source/status/projection을 주입한다. `types.ts`는 연결 전의 지역 타입 계약이며 공통 API generated 타입은 수정하지 않았다. 통합 시 양쪽 계약의 일치를 확인해야 한다.

UI는 출처·존재/부재·읽기 실패·TOML 미지원·잘못된 값 생략·표시할 안전 필드 없음·목록 로딩/오류를 구분한다. Grove 실제 적용 설정은 별도 범위별 설정 화면에서 확인하도록 안내한다. 출처별 값은 합치거나 우선순위를 계산하지 않는다.

값은 고정 허용 필드만 렌더링한다. 알려지지 않은 키를 나열하거나 원본 문자열·서버 오류 본문을 출력하지 않는다. 쓰기 컨트롤·API 호출·적용 callback이 없다. 기존 `setting`, `muted`, `small`, `scope`, `warn`, `err` 클래스를 사용한다. 읽기 전용 정적 정보라 추가 애니메이션은 넣지 않았다.

## 필요한 공통 연결과 권한

1. 통합 담당이 `src/lib.rs`에 `pub mod source_settings;`를 등록해야 한다. 현재 새 모듈은 library 컴파일 그래프에 포함되지 않는다. `tests/source_settings.rs`는 이 등록을 요구하므로 등록 전에는 해당 target이 컴파일되지 않는다.
2. 실제 인증된 조회 라우트를 추가하고 사용자 원본 조회에 필요한 소유자/관리 권한 및 프로젝트 접근 권한을 검사해야 한다. 인증됐다는 이유만으로 모든 사용자가 서버 사용자 원본을 조회하게 하면 안 된다.
3. 클라이언트는 고정 source 식별자와 인가 가능한 프로젝트 식별자만 제공하게 한다. root·임의 파일명·파일 경로를 입력으로 노출하지 않는다. 원본 root는 서버 설정·인가한 프로젝트 기록에서 결정한다.
4. `read_source`는 동기 filesystem I/O다. async route에서는 blocking 실행 경계를 사용하고 조회 source 수를 고정된 목록으로 제한한다. 비멱등 쓰기나 idempotency key는 필요하지 않다.
5. `web/app/api/`의 실제 typed 조회와 외부 상태를 연결하고 `web/app/components/Settings.tsx`의 적절한 영역에서 `SourceSettingsPanel`을 렌더링한다. 사용자·프로젝트 구분과 로컬 출처 root를 유지한다. 존재하지 않는 endpoint를 미리 호출하는 코드는 없다.
6. 통합된 API의 인증 거부·다른 프로젝트 접근 거부·root 입력 거부·원문 비노출과 실제 설정 화면 동작을 검증해야 한다. 이번 작업에는 HTTP 권한/E2E 시험이 없다.

## 검증 근거와 미실행

실행한 확인:

| 명령 | 입력·결과 |
|---|---|
| `git status --short` | 시작 시 clean. 이후 생성된 변경은 위 소유 파일뿐임을 확인 |
| `git branch --show-current` | `parallel/b01-source-settings` |
| `git rev-parse --show-toplevel` | 위 worktree 절대 경로와 일치 |
| `git rev-parse HEAD` | 시작 기준 SHA와 일치 |
| `git merge-base HEAD c186b31ab62734c9f91803cf7848b639ad9871fb` | 공통 기준 SHA 반환 |
| `source .envrc.dev && python3 scripts/build.py test --rust source_settings --vitest app/components/source-settings/SourceSettingsPanel.test.ts --dry-run` | exit 0. 선택 명령이 `cargo test --test source_settings`와 `npx vitest run app/components/source-settings/SourceSettingsPanel.test.ts`임만 확인. 시험 자체는 실행하지 않음 |
| `git diff --cached --check` | 소유 변경 7개 파일의 staged diff 공백 오류 없음. 기능·컴파일 검증은 아님 |
| `git diff --cached --name-only` | stage 대상이 위 소유 변경 7개 파일과 일치 |

작성한 Rust 시험은 안전 필드만 직렬화, 원본 불변, 출처 독립, 기본값 미추측, 부재, TOML 미지원, 비정상 JSON·비객체, 잘못된 값/범위, 크기 한도, 일반 파일 검사, 식별자 경로 입력 거부, Unix 파일/부모 symlink 경계, Unix 권한 거부를 다룬다. 권한 거부 시험은 root 실행 시 검증하지 않고 반환하므로 비-root 실행 근거가 필요하다.

작성한 Vitest 시험은 SSR로 적용 오인 방지·쓰기 컨트롤 부재·출처/상태 구분·미지원/생략 안내·임의 키/문자열 비출력·오류 코드 안내·로딩/목록 오류/빈 목록 구분을 다룬다.

**기능 시험 통과 근거는 없다.** COMMON 규칙에 따라 Rust 컴파일·통합 시험, 웹 build/typecheck, E2E는 통합 단계로 남겼다. `web/node_modules/vitest/package.json`도 존재하지 않아 작은 Vitest를 실행하지 않았으며 의존성을 설치·복사하거나 `npx` 다운로드를 시도하지 않았다. standalone crate·가짜 실행기로 우회하지 않았다. 실제 개인 설정은 읽거나 fixture로 복사하지 않았다.

통합 후 위 dry-run에서 선택된 명령을 프로젝트 진입점으로 실행하고, 연결된 웹 typecheck/build 및 관련 권한·브라우저 검증을 수행해야 한다. Windows 파일 경계와 실제 렌더링·보조기술 동작도 미검증이다.

## TODO별 판단과 남은 위험

| TODO | 이번 제공 범위 | 남은 요구·판단 |
|---|---|---|
| `SETTINGS-010` | Claude JSON 네 안전 필드 projection, Claude/Codex 출처 상태, 주입형 읽기 전용 UI와 시험 코드 | API·권한·공통 등록·실제 화면 연결·실행 검증이 없고 Codex TOML 내용은 미지원이므로 **부분 구현**. 전체 완료로 체크하면 안 됨 |
| `RESOURCE-019` | 원본과 Grove 적용 상태가 별개임을 상시 안내하며 적용값/우선순위를 추측하지 않음 | 연결된 제품 화면과 회귀 검증이 남아 있어 **부분 구현·통합 대기**. 미검증 상태를 완료 후보로 단정하지 않음 |

Codex TOML을 읽으려면 별도로 승인된 전용 parser 경로와 안전 필드 계약이 필요하다. 이번 범위에서는 새 의존성을 추가하지 않고 미지원 상태를 유지했다. Claude managed settings·`~/.claude.json`·임의 CLI 설정 파일·환경/실행 인자에 따른 최종 적용값도 지원 범위가 아니다. 01의 스킬 본문·선택·우선순위는 구현하지 않았다.

다음 단계는 통합 담당의 공통 등록·인증/인가와 root 결정·실제 조회 라우트·Settings 화면 연결 및 필수 실행 검증이다. 그 전에는 두 TODO를 전체 완료로 갱신하지 않는다.
