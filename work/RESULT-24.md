# b02 / 24 — SETTINGS-011 실행 설정

## 상태

**부분 구현 종료 / 기본 cwd 실행 연결 blocker / 통합 인수 대기.**
SETTINGS-011 전체 완료가 아니다. 기본 cwd는 저장·상속·검증·resolver까지만 제공하며 실제 셸 계획·사용자 작업에는 아직 적용되지 않는다. 화면과 설정 설명에도 이 제한을 명시했다.

- Worktree: `<세션 worktree 루트>/b02-24-exec-settings`
- Branch: `parallel/b02-exec-settings`
- 공통 기준 SHA: `7b3949d24e420d09e6e4cde29405414b2d99253a`
- ENTRY의 README 24 행, 실제 top-level·branch·HEAD·merge-base가 일치했고 시작 상태는 clean이었다.
- 다른 세션 접촉·위임·main 편집·TODO 변경·merge·push·배포·의존성 변경·workspace 삭제는 하지 않았다. TTS·마이크 차단 및 녹음·음성 입력·STT 코드는 변경하지 않았다.

## 제공 동작과 변경 파일

| 파일 | 제공 동작 |
|---|---|
| `src/settings.rs` | 기존 `exec.shell`, `exec.max_memory_mb`, `exec.max_cpu_seconds`에 session 범위 추가. `exec.isolation`, `exec.default_cwd`를 같은 settings 저장소·revision·상속 API에 등록. 셸 capability, cwd 문법·기존 프로젝트 경계·디렉터리 검증, cwd resolver 제공. |
| `src/procs.rs` | 범위별 한도를 읽을 때 registry 검증을 재사용. 잘못된 값이 제한 없음으로 조용히 변환되지 않게 거부. 고정 승인 target의 한도 해석·실행 경로는 변경하지 않음. |
| `web/app/api/execSettings.ts` | 실행 설정 키 분류와 registry의 실행 capability 메타데이터 타입. 기존 생성 타입 파일을 수동 수정하지 않음. |
| `web/app/components/exec-settings/ExecSettings.tsx` | 기존 `ScopedSettings`로 범위 선택·revision 저장·상속·복원을 재사용. 미지원 선택지는 사유가 항상 보이는 disabled radio로 표시. unsupported OS 한도는 비활성화. 다음 계획부터 적용 및 cwd 미연결 안내. |
| `web/app/components/exec-settings/ExecSettings.test.ts` | 범위별 편집기 연결, 대상·상속 표시, 미지원 선택지·사유·비활성, 적용 시점·미연결 안내 검사. |
| `web/app/components/Settings.tsx` | 전용 항목 등록·mount. 기존 일반 registry 렌더링에서는 해당 키를 제외하여 중복 편집 방지. 검색·deep link·고급 항목 숨김·기존 영역 복원 대상은 유지. |
| `tests/exec_settings.rs` | 인증 API의 범위 상속·해제·프로젝트 분리, 값·revision·미지원 선택지 거부, cwd 경계·실행 root 재검증, session 셸·한도의 다음 계획 적용 및 고정 승인 대상 실행 검사. |
| `web/e2e/exec-settings.spec.ts` | 실제 API와 화면의 저장·거부·상속 복원·미지원 표시 및 승인 전후 셸·한도 변경 시나리오 작성. 미실행. |
| `work/RESULT-24.md` | 이 인계. |

`src/exec.rs`는 수정하지 않았다. 이 파일은 독립 `grove exec` CLI이며, 배정 기능의 모델 셸 계획과 사용자 작업 cwd를 결정하는 위치가 아니다.

## Public 계약

- `ExecSettings({ defs, target })`: `defs: ExecSettingDef[]`, `target: SettingsTarget`. 외부가 조회한 registry와 설정을 연 프로젝트·대화 대상을 주입한다. 저장·조회·복원은 기존 `ScopedSettings`가 수행하며 별도 저장 방식은 없다.
- `ExecSettingDef`: 기존 `SettingDef`에 `unavailable_options?: { value: string; reason: string }[]`, `disabled_reason?: string`을 더한다.
- `EXEC_SETTING_KEYS`, `isExecSetting(def)`는 전용 영역에 속하는 다섯 키만 분류한다.
- 기존 `GET /settings/registry`: 실행 enum의 `options`에는 서버에서 지원하는 값만 반환하고, 지원하지 않는 값·이유는 `unavailable_options`에 반환한다. 비 Linux/Windows 자원 한도에는 `disabled_reason`을 반환한다. 새 라우트는 없다.
- 기존 `PUT /settings/{scope}/{scope_id}/{key}`: 인증·멱등성·존재하는 대상·expected_revision·감사 기록·설정 이벤트 계약을 재사용한다. 잘못된 값은 400, stale revision은 409, 인증 없음은 401이며 기존 저장값을 보존한다. null은 override 해제다.
- 셸은 기존 허용 목록만 사용한다. Windows 전용 셸은 다른 OS에서 거부하고, 서버 PATH에서 실행 파일과 Unix 실행 비트를 확인한다. 이후 제거되거나 실제 spawn에 실패하는 경우는 기존 실행 오류 계약을 따른다.
- 격리의 유일한 지원값은 `process_tree`다. 기존 Unix process group / Windows Job Object 동작을 나타낸다. `none`은 소유권·정리 해제가 허용되지 않아, `sandbox`는 미구현이라 비활성이다. 파일·네트워크 sandbox를 제공한다고 표시하지 않는다. 기존 실행기가 항상 트리 격리를 수행하므로 새 격리 분기를 만들지 않았다.
- `exec.default_cwd`: 기본값 `"."`, 전역·프로젝트·대화 범위, 최대 4096자. `/` 구분 상대 경로만 받고 빈 문자열·NUL·역슬래시·콜론·절대 경로·`..`를 거부한다. 프로젝트·대화 저장은 기존 `tools::fs::resolve`와 디렉터리 존재 검사를 사용하고 대화는 실제 `sessions::exec_root`에서 검사한다. 전역은 특정 프로젝트가 없으므로 문법만 검사한다.
- `settings::execution_cwd(c, root, project, session, explicit) -> ApiResult<PathBuf>`: 새 실행을 계획하는 호출자용 resolver. 명시적 cwd가 우선한다. 생략 시 범위별 기본값을 읽고 실제 실행 root에서 경계·디렉터리를 다시 검사한다. root는 호출자가 인증·확정한 프로젝트 또는 worktree root여야 한다. 승인된 target에는 다시 호출하면 안 된다. **현재 production 호출자는 없다.**
- 셸·자원 한도는 기존 `approvals::create_call`이 계획 시 target에 고정하고 기존 실행기가 그대로 사용한다. session 추가만으로 모델 foreground·background 및 대화 사용자 작업에 적용된다. 프로젝트 터미널은 전역·프로젝트 셸만 상속하고 한도를 적용하는 대상으로 표시하지 않았다.

## 검증 근거

모든 명령은 자기 worktree에서 실행했다. 메인 `.envrc.dev`를 source했고, 기존 환경을 가리키는 Git ignore symlink `.dev`와 `web/node_modules`만 만들었다. 툴체인·node_modules를 복사하거나 의존성을 설치·업그레이드하지 않았다.

| 실제 명령 | 결과·입력 |
|---|---|
| `source <원본 저장소>/.envrc.dev && flock /home/ubuntu/.cache/grove-rust-check.lock python3 scripts/build.py test --rust exec_settings settings tasks` | 성공. 새 통합 시험 4개, 기존 settings 5개, 기존 tasks 8개, 총 17개 통과. 컴파일 포함. |
| `source <원본 저장소>/.envrc.dev && python3 scripts/build.py test --vitest app/components/exec-settings/ExecSettings.test.ts --typecheck` | 최종 입력으로 성공. Vitest 3개 및 typecheck 통과. 작성한 E2E도 타입 검사에 포함. |
| `git diff --check` | 코드·시험 변경에 대해 성공. |

- Rust 실행 검사는 Linux의 실제 셸에서 `$0`, `ulimit -v`, `ulimit -t` 결과를 확인했다. 승인 대기 중 session 설정을 바꿔도 foreground·background 모두 기존 shell·limits·target을 유지하며 다음 계획만 새 값을 사용했다. 사용자 작업의 session 값도 확인했다.
- cwd 검사는 저장 거부, symlink 탈출, 존재하지 않는 디렉터리·일반 파일, 명시적 cwd 우선, 다른 실행 root에서의 재검증, 저장 뒤 symlink 교체를 확인했다. 실제 셸 계획에 기본 cwd가 적용된다는 검사는 아니며, 승인 target cwd 변경 방지의 새 통합 인수도 남아 있다.
- 웹 선택 검사는 미지원 사유를 닫힌 select 안이 아니라 항상 보이는 disabled 선택지로 바꾼 뒤 재실행했다. 이전 웹 검사도 통과했으며 실패·취소·timeout은 없었다.
- E2E·전체 회귀·release·패키징은 COMMON의 기능 병렬 작업 규칙에 따라 미실행이다. Windows/macOS 빌드·실행 및 해당 OS capability는 미검증이다.

## SETTINGS-011 충족 범위와 blocker

| 요구 | 현재 근거·남은 사항 |
|---|---|
| 전역·프로젝트·대화 설정 및 상속 | 다섯 키를 기존 API·편집기로 저장·상속·해제. Rust 통과, 웹 표시 시험 통과. 실제 브라우저 인수는 남음. |
| 셸·자원 한도의 다음 실행 적용 | 기존 계획 고정 경로를 재사용. session 변경 후 새 foreground·background·사용자 작업의 실제 셸·한도를 Rust로 확인. |
| 이미 승인한 실행 불변 | shell·limits 및 전체 target 불변을 Rust로 확인. E2E 시나리오 작성, 미실행. |
| 지원하지 않는 셸·격리 비활성 및 사유 | 서버 메타데이터·값 거부와 웹 disabled 선택지 시험 통과. 실제 OS별 브라우저 인수는 남음. |
| 기본 cwd 설정·안전성 | 저장·상속·문법·프로젝트 경계·실행 root 재검증 resolver는 구현·시험 완료. **실제 실행 계획 연결은 미완료.** |

실제 cwd 기본값을 정하는 `src/approvals.rs::create_call`과 `src/tasks.rs::start`는 편집 소유 범위에 없다. `src/exec.rs`를 바꾸어 이 경로를 대체하거나 settings 조회에 부작용을 넣지 않았다. 범위 밖 수정 없이 전체 실행 의미를 완성할 수 없어 이 지점을 blocker로 남긴다.

## 다음 통합 단계

1. `src/approvals.rs::create_call`에서 셸 도구의 명시적 cwd가 생략됐을 때만 `settings::execution_cwd`를 사용해 기존 plan 이전에 인자를 확정한다. `tools::shell::plan`의 프로젝트 root는 유지하여 cwd를 프로젝트 상대 target으로 고정하고 경계 위반은 기존 실패 기록 계약으로 처리한다.
2. `src/tasks.rs::start`에서 새 사용자 작업의 cwd를 같은 resolver로 확정한다. 멱등 재전송은 기존 receipt를 재사용하며 이미 고정한 `Spawn`·승인 call에는 설정을 다시 읽지 않는다. 새 터미널까지 기본 cwd 적용 대상에 포함한다면 별도 소유 범위인 `src/terminals.rs::create`도 연결한다.
3. 실제 foreground·background·사용자 작업에서 cwd 생략·명시값·session 상속·worktree root·symlink 변경을 인수하고, 설정을 바꾼 뒤 이미 고정한 cwd는 바뀌지 않는 회귀를 추가한다. 연결 전에는 현재의 미적용 경고를 제거하지 않는다.
4. 고정 포트를 독점하는 통합 환경에서 `python3 scripts/build.py test --e2e e2e/exec-settings.spec.ts e2e/settings-reset.spec.ts`를 실행한다. 새 E2E의 실행 확인은 Linux 셸·ulimit 기준이다. 타 플랫폼 실행 검증은 별도다.
5. 실제 cwd 연결·브라우저 인수가 끝난 뒤에만 SETTINGS-011 전체 완료를 판정한다. 이 기능 worktree에서는 TODO를 변경하지 않았다.
