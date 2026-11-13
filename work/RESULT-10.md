# b02 / 10 — 원본 설정 조회 API·설정 화면 연결

## 상태·기준

- 구현 종료, **웹 검증 blocker·통합 인수 대기**. 전체 기능 검증 완료가 아니다.
- worktree: `/home/ubuntu/.local/share/paseodog/paseo/worktrees/0q796rug/b02-10-source-settings-wire`
- branch: `parallel/b02-source-settings-wire`
- 공통 기준 SHA: `bc797b36cd0c09ce41eb675d7d152ce95ffa7ef1`
- `work/ENTRY.md` 절차로 실제 top-level·branch를 원본 프로젝트의 준비 표와 대조해 10 한 행에 매칭했다. 기준 SHA가 HEAD의 조상임을 확인했고 시작 상태는 clean이었다.
- 처음에는 준비 표가 미등록 상태라 편집 없이 중단했다. 표 갱신 후 실제 10번 배정을 확인해 재개했으며, 다른 worktree의 11번 작업으로 전환하지 않았다.
- 세션 목록 조회는 런타임에서 `session: cross-session control is unavailable in this runtime`으로 거부됐다. 다른 세션 제어·실행은 하지 않았다.

## 소유 변경

- `src/source_settings/mod.rs`: 기존 projection을 유지하고 조회 handler를 export.
- `src/source_settings/routes.rs`: 소유자 전용 조회 API, 서버 측 root 결정, blocking I/O, root 결정 단위 시험.
- `src/lib.rs`: `router`의 조회 route 등록 한 줄.
- `tests/source_settings.rs`: 기존 파일 경계 시험에 실제 HTTP 인증·인가·입력 거부·projection·읽기 오류 복구 회귀를 추가.
- `web/app/api/sourceSettings.ts`: typed 조회 함수와 단일 웹 응답 타입 정의.
- `web/app/components/source-settings/types.ts`: API 타입을 재사용하며 기존 UI export 계약 유지.
- `web/app/components/source-settings/SourceSettings.tsx`: 실제 API와 조회 상태·재조회·프로젝트별 cache 연결.
- `web/app/components/source-settings/SourceSettings.test.ts`: typed 요청·프로젝트 분리·오류 본문 비노출·로딩 시험.
- `web/app/components/Settings.tsx`: 설정 메뉴·검색 등록과 panel mount 한 곳.
- `web/e2e/source-settings.spec.ts`: 실제 프로젝트 화면·인증 경계·root 거부·원문 비노출·오류 복구 시나리오.
- `work/RESULT-10.md`: 이 인계.

`TODO.md`, dependency/lockfile, 공통 빌드·E2E 설정과 다른 기능은 수정하지 않았다. push·merge·배포·서비스 중단은 하지 않는다.

## 제공 동작·권한 계약

`source_settings::list`를 `GET /api/v1/source-settings`에 연결했다. 쓰기 method는 제공하지 않는다.

| 요청 | 고정 조회 대상 |
|---|---|
| query 없음 | `claude_user`, `codex_user` |
| `?project_id=<등록된 활성 프로젝트 ID>` | 해당 프로젝트의 `claude_project`, `claude_project_local`, `codex_project` |

- 기존 `auth::Owner` 추출기를 재사용한다. 소유자 토큰과 소유자 브라우저만 허용하고, 미인증은 401, 일반 기기와 그 브라우저는 403이다.
- Grove의 기존 권한 모델은 단일 사용자·기기 공유 모델이며 별도 프로젝트별 사용자 ACL은 없다(`tests/access.rs`). 소유자는 모든 등록 프로젝트의 관리자다. 일반 기기는 어느 프로젝트도 원본 조회할 수 없으며, 요청한 프로젝트는 `projects::active_root`로 존재·보관 상태·가용성을 확인한다. 존재하지 않는 프로젝트는 404, 보관된 프로젝트는 409다.
- 입력은 선택적인 `project_id` 하나뿐이다. 클라이언트가 root·path·filename·source를 지정할 수 없다. 알 수 없는 query, 중복/빈 프로젝트 ID는 원문을 되돌리지 않는 표준 `invalid_request` 400으로 거부한다.
- 사용자 root는 서버의 `CLAUDE_CONFIG_DIR` / `CODEX_HOME`을 사용한다. override가 없으면 Unix `HOME`, Windows `USERPROFILE` 아래 `.claude` / `.codex`를 사용한다. 비어 있거나 상대 경로인 환경값은 현재 디렉터리로 추측하지 않고 `read_error/io`로 표시한다.
- 프로젝트 로컬 출처는 선택한 등록 프로젝트의 `.claude/settings.local.json`이다. main checkout으로 자동 이동하거나 CLI 최종 적용 위치라고 주장하지 않는다.
- 고정 2개 또는 3개 source만 읽는다. 파일 읽기와 사용자 root 결정은 `tokio::task::spawn_blocking`에서 실행하고, 프로젝트 DB 조회·가용성 확인은 기존 DB worker 경계를 사용한다.
- 응답은 `{ items: SourceSettings[] }`다. 기존 안전 필드 projection·파일 경계·256 KiB 제한을 재사용했다. 절대 경로·원문·환경값·명령·hook 본문·자격증명을 반환하지 않는다.
- `present`, `missing`, `read_error`, `unsupported_format` 계약은 `work/RESULT-00.md`와 같다. Codex TOML은 존재만 확인하며 파싱하지 않는다. source별 오류는 고정 enum만 반환한다.
- 읽기 전용이므로 idempotency key·적용·우선순위 계산·원본 수정은 없다.

## 웹 public 계약·연결

- `web/app/api/sourceSettings.ts`의 `getSourceSettings(projectId?: string): Promise<{ items: SourceSettings[] }>`는 기존 인증 API client를 사용한다.
- `SourceId`, `SafeSettings`, `ReadErrorCode`, `SourceSettings` 타입은 위 API 파일에서 정의하고 기존 `source-settings/types.ts`에서 재export한다. 수동 지역 타입 복제를 제거했으며 unrelated generated 타입은 수정하지 않았다.
- 새 `SourceSettings({ projectId?: string })` wrapper가 기존 `SourceSettingsPanel({ view })`에 안전한 조회 상태만 전달한다. 기존 panel의 props/export는 유지했다.
- 설정의 “에이전트·워크플로우” 메뉴 또는 “원본” 검색에서 접근한다. 전역 설정은 사용자 원본, 프로젝트·대화에서 연 설정은 고정된 프로젝트 원본을 조회한다.
- cache 키는 프로젝트 ID별로 분리한다. 첫 렌더·조회 중에는 로딩을, 오류 시에는 이전 결과 대신 고정 안내를 표시한다. 서버 오류 본문은 렌더링하지 않으며 재조회 버튼으로 복구한다.
- 원본 조회와 Grove 실제 적용 설정을 명시적으로 구분한다. 읽기 전용 정보이므로 새 애니메이션이나 쓰기 컨트롤은 추가하지 않았다.
- 공통 route·typed 조회·Settings mount 연결은 이 브랜치에 포함돼 있다. 추가 연결 누락은 없지만 브라우저 실행 검증은 남아 있다.

## 실제 검증

최초 실행:

```sh
source .envrc.dev && python3 scripts/build.py test --rust source_settings --vitest app/components/source-settings/SourceSettingsPanel.test.ts app/components/source-settings/SourceSettings.test.ts --typecheck
```

exit 1, `FileNotFoundError: [Errno 2] No such file or directory: 'cargo'`. 이 시도에서는 컴파일·시험이 시작되지 않았고 typecheck·Vitest도 미실행이다.

원본 프로젝트의 기존 `.dev`를 이 작업의 `.dev` 심볼릭 링크로 일시 연결해 복사·설치 없이 툴체인과 cache를 재사용했다. 이후 실행:

```sh
source /data/project/paseodog_opus/.envrc.dev && CARGO_TARGET_DIR=/data/project/paseodog_opus/target CARGO_BUILD_JOBS=2 CARGO_NET_OFFLINE=true RUSTUP_AUTO_INSTALL=0 python3 scripts/build.py test --rust source_settings --vitest app/components/source-settings/SourceSettingsPanel.test.ts app/components/source-settings/SourceSettings.test.ts --typecheck
```

| 단계 | 결과 |
|---|---|
| Rust library·integration 컴파일, `--test source_settings` | 14개 통과, 실패 0 |
| HTTP 회귀 | 소유자·소유자 브라우저 성공, 미인증/기기/기기 브라우저 거부, 두 프로젝트 거부 경계, 프로젝트별 내용 분리, 미등록·보관 거부, root/임의 query 거부, 원문·경로 비노출, 반복 조회 불변, 파일 오류 후 복구 통과 |
| 기존 파일 경계 회귀 | 안전 projection·TOML 미지원·크기 제한·symlink 탈출·권한 거부 등 10개 통과. 실행 UID 1000으로 권한 거부 시험의 root skip은 적용되지 않음 |
| 웹 typecheck | exit 127, `sh: 1: react-router: not found` |
| Vitest | 앞 typecheck 실패로 미실행 |

두 번째 명령의 전체 exit는 127이다. Rust 통과와 별개로 전체 검사 성공을 주장하지 않는다.

서버 root 결정 단위 시험도 별도로 실행했다:

```sh
source /data/project/paseodog_opus/.envrc.dev && python3 -c 'import os; print("검증 UID:", os.geteuid())' && CARGO_TARGET_DIR=/data/project/paseodog_opus/target CARGO_BUILD_JOBS=2 CARGO_NET_OFFLINE=true RUSTUP_AUTO_INSTALL=0 python3 scripts/build.py test --lib --filter source_settings::routes
```

exit 0. `roots_use_server_environment_without_guessing_relative_or_missing_paths` 1개 통과, 나머지 180개는 미선택이다. 서버 환경 override·기본 위치·상대/빈/부재 값 거부를 합성 경로로 검증했다.

`git diff --check`는 통과했다. 검증 후 이 작업이 만든 `.dev` 심볼릭 링크만 정확한 target 확인 후 제거했다. 공용 툴체인·cache는 보존했다.

## blocker·미검증·다음 통합

- **웹 의존성 부재**: worktree와 원본 프로젝트의 `web/node_modules`가 없는 상태다. 설치·복사·업그레이드는 공통 계약상 하지 않았다. typecheck와 선택 Vitest 2개 파일을 준비된 웹 환경에서 실행해야 한다.
- E2E 3개 시나리오는 작성했지만 공통 계약에 따라 통합 단계로 남겼다. 준비된 환경에서 `python3 scripts/build.py test --e2e e2e/source-settings.spec.ts`로 실제 화면·재조회·원문 비노출·인증 거부·root 거부를 검증해야 한다. 고정 포트 E2E는 다른 세션과 동시에 실행하지 않는다.
- 실제 개인 사용자 원본은 시험에서 읽지 않았다. 사용자 root 결정과 `read_source`는 합성 fixture로 검증했으며, 실제 사용자 원본의 API·화면 성공 흐름과 Windows 실행은 미검증이다.
- `RESOURCE-018`은 API/출처 화면 연결을 제공했지만 원본 스킬·훅 전체 보기와 Codex TOML 내용은 지원하지 않으므로 **부분 구현**이다. 새 parser·스킬 본문·hook 실행으로 확장하지 않았다.
- `RESOURCE-019`는 적용 상태 구분 문구와 안전한 UI 연결을 유지했지만 웹 타입·단위·E2E 실행이 남아 있다. 전체 요구 충족이나 완료 체크를 주장하지 않는다.
- 통합 담당은 공통 `router`·`Settings.tsx`의 다른 기능 추가와 충돌을 맞추고 남은 웹 검사를 수행한 뒤 TODO 상태를 판단해야 한다. 기능 담당은 `TODO.md`를 갱신하지 않았다.
- 관련 코드·시험·이 RESULT만 한국어 메시지로 로컬 커밋하고 종료한다. 이 파일을 포함한 커밋 SHA를 본문에 재기록하지 않는다.
