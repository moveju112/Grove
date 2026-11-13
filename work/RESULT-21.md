# b02 / 21 — 원본 Claude/Codex 스킬·hook 읽기 전용 조회

## 상태와 기준

- **부분 구현 · 웹 검증 blocker · 통합 인수 대기**. RESOURCE-018 전체 완료가 아니다.
- worktree: `/home/ubuntu/.local/share/paseodog/paseo/worktrees/0q796rug/b02-21-source-skills-hooks`
- branch: `parallel/b02-source-skills-hooks`
- 공통 기준 SHA: `7b3949d24e420d09e6e4cde29405414b2d99253a`
- 원본 `work/ENTRY.md`, `work/COMMON.md`, `work/21.md`를 읽고 README의 21 행과 실제 top-level·branch를 대조했다. 시작 HEAD가 기준 SHA와 같았고 worktree는 clean이었다.
- Codex inline TOML hook은 미지원으로 명시한다. 웹 dependency 부재 때문에 typecheck·Vitest·E2E의 완료 근거도 없다.

## 소유 변경

- `src/source_settings/resources.rs`: 출처별 스킬 메타데이터·JSON hook projection, capability 경계, symlink 거부, 읽기·탐색 한도, 고정 오류.
- `src/source_settings/mod.rs`: 새 읽기 함수·응답 타입 export.
- `src/source_settings/routes.rs`: 기존 owner 전용 GET 응답에 `resources` 추가, 기존 blocking 경계 안에서 조회.
- `tests/source_settings.rs`: 리소스 projection·격리·원문 비노출·권한·잘못된 형식·한도·symlink·재조회 회귀.
- `web/app/api/sourceSettings.ts`: 리소스 typed 응답.
- `web/app/components/source-settings/types.ts`: 기존 ready view에 선택적인 리소스 목록 추가.
- `web/app/components/source-settings/SourceSettings.tsx`: 인증 조회 결과의 리소스 목록 전달.
- `web/app/components/source-settings/SourceSettingsPanel.tsx`: 출처별 리소스·상태 표시. 새 쓰기 동작·애니메이션은 추가하지 않았다.
- `web/app/components/source-settings/SourceSettingsPanel.test.ts`: 메타데이터·hook 표시, 원문 필드 무시, 오류 상태 시험.
- `web/app/components/source-settings/SourceSettings.test.ts`: API 리소스와 화면 연결 시험.
- `web/e2e/source-settings.spec.ts`: 실제 조회·권한 거부·명령 및 본문 비노출·가림·형식 오류·symlink·복구 시나리오 4개.
- `work/RESULT-21.md`: 이 인계.

`src/skills/`, 공통 router·Settings mount, dependency/lockfile, TODO, 음성 입력·녹음·STT·TTS·마이크 차단 코드는 수정하지 않았다. 다른 세션 접촉·위임·merge·push·배포·workspace 삭제는 하지 않았다.

## API와 서버 계약

기존 `GET /api/v1/source-settings[?project_id=<id>]`의 `{ items }`를 유지하고 `{ items, resources }`로 확장했다. 입력은 기존 프로젝트 ID 하나뿐이고 root·path·source·filename 입력은 계속 거부한다.

```text
SourceResource = {
    source: 기존 SourceId,
    relative_path: 서버가 고정한 리소스 위치,
    kind: "skills" | "hooks",
    result:
        { status: "present", entries: [...], ignored_invalid_entries: boolean }
      | { status: "missing" }
      | { status: "read_error", code: 기존 ReadErrorCode }
      | { status: "unsupported_format", format: "toml" }
}

SkillMetadata = { name, description, relative_path }
HookMetadata = { event, matcher: string | null, has_command: boolean }
```

- public export: `source_settings::SourceResource`, `read_resources(Option<&Path>, SourceId) -> Vec<SourceResource>`, `read_codex_user_agents(Option<&Path>) -> SourceResource`. `None` root는 원본 부재로 오인하지 않고 `read_error/io`다. 이 함수의 root는 신뢰된 서버 코드만 결정해야 한다.
- 기존 `auth::Owner` 추출기와 등록된 활성 프로젝트 조회를 유지했다. 미인증 401, 일반 기기·기기 브라우저 403, 미등록 프로젝트 404, 보관 프로젝트 409다. 별도 프로젝트 사용자 ACL이나 권한 완화를 추가하지 않았다.
- 사용자 Claude root는 `CLAUDE_CONFIG_DIR` 또는 서버 홈의 `.claude`, Codex root는 `CODEX_HOME` 또는 `.codex`다. 현재 Codex 사용자 스킬 위치는 절대 서버 `HOME`/`USERPROFILE` 아래 `.agents/skills`로 고정한다. 프로젝트 조회에 사용자 원본을 섞지 않는다.
- 모든 파일 I/O·사용자 root 결정은 기존 `spawn_blocking` 안에서 실행한다.
- ProjectFs capability 안에서 각 상대 경로 요소의 symlink를 거부하고 읽기 후에도 검사한다. root 밖 탈출은 기존 capability가 차단한다. 일반 파일만 bounded read하고 원본을 수정하거나 실행하지 않는다.
- hook JSON은 기존 256 KiB 한도를 사용한다. 스킬은 기존 `skills::MAX_BODY_BYTES` 64 KiB, `MAX_SKILLS` 256개, `MAX_SCANNED_ENTRIES` 4096개 한도를 재사용한다. hook projection도 최대 256개다. 목록 전체 한도 초과는 부분 목록 대신 `read_error/too_large`다.
- 잘못된 개별 스킬·hook 항목은 생략하고 `ignored_invalid_entries`로 알린다. JSON 파싱·최상위 형태 오류와 OS 오류는 고정 코드만 반환한다. 원문·절대 경로·에러 문자열을 응답이나 로그에 넣지 않는다.
- 스킬 본문은 파일 제한 안에서 메타데이터를 추출할 때만 읽고 응답·화면·모델에 전달하지 않는다. 그 밖의 frontmatter·script·환경 변수도 반환하지 않는다.
- hook은 이벤트·matcher·명령 존재 여부만 반환한다. command, commandWindows, prompt, URL, 환경값, MCP 인수는 반환하지 않는다. Grove hook의 명령 공개·가림 경로 자체를 호출할 필요가 없도록 명령을 항상 제외했다.
- 표시 메타데이터는 기존 `tools::shell::is_sensitive_env` 정책과 알려진 credential prefix·URL·긴 opaque token 징후를 사용해 문자열 전체를 `[redacted]`로 가린다.
- `SkillCatalog`는 내부 symlink/alias를 허용하고 metadata를 opaque하게 취급한다. 이번의 symlink 거부·설명 projection 계약과 달라 catalog의 본문/선택 API를 호출하지 않았다. `src/skills/`는 변경하지 않고 기존 ProjectFs 읽기 API·스킬 한도·`definitions::split_front_matter`를 재사용했다. Catalog read API 직접 재사용은 이 구현에 포함되지 않는다.

| 출처 | 스킬 위치 | Hook 위치 |
|---|---|---|
| `claude_user` | CLI root의 `skills/<dir>/SKILL.md` | `settings.json` |
| `claude_project` | `.claude/skills/<dir>/SKILL.md` | `.claude/settings.json` |
| `claude_project_local` | 별도 스킬 root 없음 | `.claude/settings.local.json` |
| `codex_user` | 서버 홈의 `.agents/skills`, CLI root의 legacy `skills` | `hooks.json`, `config.toml`은 미지원 |
| `codex_project` | `.agents/skills`, legacy `.codex/skills` | `.codex/hooks.json`, `.codex/config.toml`은 미지원 |

스킬 frontmatter는 `name`·`description`의 일반 scalar·인용 문자열·`|`/`>` 블록과 CRLF를 지원한다. 전체 YAML parser는 아니며 미지원·누락·중복 metadata는 본문을 대신 표시하지 않고 해당 항목을 생략한다.

위치·JSON 형태 확인에 사용한 문서:
- `https://developers.openai.com/codex/hooks`와 `https://developers.openai.com/codex/skills`가 반환한 현재 공식 문서.
- `https://code.claude.com/docs/en/hooks`.

## 웹 연결과 적용 구분

- `getSourceSettings(projectId?)`의 입력과 인증 client는 유지하고 typed `resources`를 추가했다.
- 기존 `SourceSettings({ projectId? })`와 `SourceSettingsPanel({ view })`에 연결했다. 기존 데이터 주입 소비자는 선택적인 `view.resources`를 생략할 수 있다.
- 기존 `src/lib.rs` route와 `Settings.tsx` mount를 재사용하므로 새 공통 파일 등록은 필요 없다.
- 각 원본 카드에 리소스 root 설명·상대 위치·목록·부재·오류·부분 생략·미지원 상태를 표시한다. Codex 사용자 홈의 `.agents/skills`와 CLI 설정 디렉터리를 구별한다.
- “원본을 조회했다고 Grove에 적용된 것은 아닙니다”와 Grove 적용 상태·우선순위 미계산 안내를 유지한다.
- 새 가져오기·적용·실행·선택·편집 버튼은 없다. 기존 재조회 버튼만 사용하며 프로젝트별 cache·로딩·고정 오류 안내를 유지한다.

## 실제 검증

Rust 선택 검사:

```sh
ln -s /data/project/paseodog_opus/.dev .dev && source /data/project/paseodog_opus/.envrc.dev && CARGO_TARGET_DIR=/data/project/paseodog_opus/target CARGO_BUILD_JOBS=2 CARGO_NET_OFFLINE=true RUSTUP_AUTO_INSTALL=0 flock /home/ubuntu/.cache/grove-rust-check.lock python3 scripts/build.py test --rust source_settings
```

- exit 0. 라이브러리·integration target 컴파일 포함, `tests/source_settings.rs` **23개 통과**, 실패·ignored·filtered 0.
- 기존 인증/인가·입력·서버 프로젝트 격리·읽기 복구 회귀를 포함한다.
- 신규 스킬·hook projection, 모든 출처의 고정 상대 위치, 원문·명령·절대 root 비노출, 비밀 징후 가림, 잘못된 JSON·metadata, 파일·목록·탐색 제한, 내부/외부 symlink, 읽기 권한 거부, HTTP 격리·반복 조회·복구를 검증했다.
- 공유 빌드 잠금 대기 후 실행됐다. timeout·취소·실패한 Rust 검사는 없다. 이후 Rust·시험 입력은 변경하지 않았다. 실행 UID 1000을 확인했으므로 권한 거부 시험의 root 우회는 적용되지 않았다.
- 설치·복사 없이 공용 툴체인과 cache를 사용했다. 검증에 만든 `.dev` symlink는 정확한 target을 확인하고 제거했다. 공용 툴체인·target은 보존했다.

웹 선택 검사:

```sh
source /data/project/paseodog_opus/.envrc.dev && python3 scripts/build.py test --vitest app/components/source-settings/SourceSettingsPanel.test.ts app/components/source-settings/SourceSettings.test.ts --typecheck
```

- 전체 exit 127. 첫 typecheck에서 `sh: 1: react-router: not found`.
- Vitest는 선행 typecheck 실패로 **미실행**이다. 원본 프로젝트 `web/node_modules`가 없으므로 공통 계약의 symlink 복구도 적용하지 않았다. dependency 설치·복사·업그레이드·npx 다운로드 우회는 하지 않았다.
- 이후 웹의 출처 root 설명·한도 안내와 E2E 가림 assertion을 보완했다. 웹 환경 blocker가 그대로여서 같은 실패 명령을 재시도하지 않았으며 최종 웹 입력은 미검증이다.
- E2E 4개는 작성했지만 COMMON의 독립 단계 E2E 금지와 dependency 부재로 **미실행**이다. 통합 단계의 `python3 scripts/build.py test --e2e e2e/source-settings.spec.ts` 대상이다.
- `git diff --check`를 실행해 통과했다. 최종 staged diff도 whitespace 검사 후 커밋한다.

## RESOURCE-018 남은 요구와 다음 통합

- 제공: 실제 기존 API·설정 화면에 Claude/Codex의 고정 위치 스킬 metadata와 JSON hook 정의를 출처별로 연결했다. Rust에서 읽기 전용·보안·오류·복구 동작을 검증했다.
- **미충족: Codex `config.toml`의 inline hook 정의 조회**. 전용 TOML parser가 없고 dependency 변경이 금지돼 있어 `unsupported_format/toml`로 표시한다. 임의의 축약 TOML parser로 내용을 추측하지 않았다. parser 재사용 또는 승인된 dependency 연결이 필요하다.
- **미충족: 브라우저 완료 근거**. 준비된 웹 환경에서 typecheck, 선택 Vitest 2개, 선택 E2E 1개 spec을 실행해야 한다. 실패하면 해당 범위만 고치고 재검증해야 한다.
- 제한: 전체 YAML, 재귀 스킬 탐색, plugin·managed·admin root, Codex 실행 cwd의 상위 폴더별 탐색·최종 유효값은 구현하지 않았다. 고정 출처의 바로 아래 스킬만 조회한다.
- 실제 개인 원본 파일·자격증명·서비스·유료 모델은 시험에 사용하지 않았다. Linux 합성 fixture로 검증했으며 Windows 실행·실기기는 미검증이다.
- 기존 route·Settings mount는 연결돼 있다. 통합 담당은 위 미완료 요구와 공통 파일 충돌 여부를 확인한 뒤 RESOURCE-018 완료 여부를 판단해야 한다. TODO는 수정하지 않았다.
- 관련 코드·시험·이 인계만 한국어 메시지로 로컬 커밋하고 종료한다. 이 파일을 포함한 commit SHA는 순환 기록하지 않는다.
