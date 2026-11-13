# b02 / 25 — SETTINGS-016 서버 업데이트 설정

<!-- grove-handoff:v1
{"state":"ready","remaining":[],"blockers":[],"integration_checks":[]}
-->

## 식별·상태

- Worktree: `<세션 worktree 루트>/b02-25-update-settings`
- Branch: `parallel/b02-update-settings`
- 공통 기준: `7b3949d24e420d09e6e4cde29405414b2d99253a`
- 재개 기준: 기능 커밋 `fbbd6aa2545b2399483416cab5aecbfb901a5802`, 원본 배정 갱신 `4439295801693d17c7d150fb126eb364fbd7593c`의 25번 문서와 live COMMON.
- 상태: 소유 범위 구현·연결·선택 브라우저 인수 완료(`ready`). 실행 가능한 잔여·blocker는 없다. 설정 저장·표시와 로컬 확인의 완료이며 실제 자동 설치 완료를 뜻하지 않는다.
- 설치·실서비스 재시작·배포·원격 릴리스 조회·의존성 변경·TODO 수정은 구현에 포함하지 않았다. TTS·마이크 차단·STT 관련 코드는 변경하지 않았다.

## 제공 동작·소유 변경

| 경로 | 제공 내용 |
| --- | --- |
| `src/update.rs` | 기존 CLI와 공유하는 서명·제품·버전 비교, 로컬 채널별 확인, 서버 설정·마지막 결과 영속화 |
| `src/admin.rs` | 설정 조회·소유자 저장·소유자 확인 handler. 기존 owner-only readiness는 유지 |
| `src/lib.rs` | 지정 연결 지점에 `/updates/settings`, `/updates/check` route 등록 |
| `tests/update_settings.rs` | 실제 임시 서버를 사용하는 통합 시험 5개 |
| `web/app/api/updateSettings.ts` | 전용 typed API 계약. 기존 hooks API처럼 별도 모듈로 선언·import하며 공통 생성기를 수정하지 않음 |
| `web/app/components/update/UpdateSettings.tsx` | 설정·버전·결과·보류·권한 화면과 동일 키 재확인 |
| `web/app/components/update/UpdateSettings.test.ts` | 표시·권한·응답 유실 분류 단위 시험 7개 |
| `web/app/components/Settings.tsx` | 서버 메뉴·검색 registry 항목과 화면 mount |
| `web/e2e/update-settings.spec.ts` | 로컬 서명 fixture·읽기 전용·보류 fixture·응답 유실/충돌 시나리오 4개. 지정된 브라우저 인수 실행으로 모두 통과 |
| `work/RESULT-25.md` | 이 인계 |

## 공개 계약·연결

- `GET /api/v1/updates/settings`: 모든 인증 기기에 현재 서버 `version/protocol/schema`, `settings`, `last_check`, `can_manage`, `readiness`, `automatic_application: "not_enabled"`를 제공한다. 비인증은 401이다.
- `PUT /api/v1/updates/settings`: 소유자 전용. `{channel, auto_apply, expected_revision}`를 받고 `{settings}`를 반환한다. 채널은 `stable|beta`, 범위는 `notify_only|patch|minor`다. 기본값은 stable·알림만·revision 0이다.
- `POST /api/v1/updates/check`: 소유자 전용. `{expected_revision}`를 받고 `{last_check}`를 반환한다. 확인 자체의 실패도 HTTP 200의 `status: "failed"`로 저장한다.
- 두 변경 API는 기존 `Owner`, `idem::run`, `Idempotency-Key`를 재사용한다. 일반 기기는 403, revision 불일치는 표준 409 `revision_conflict`, 동일 키의 다른 본문은 기존 idempotency 충돌 계약을 따른다. 잘못된 enum·추가 필드는 기존 Axum JSON 거부(422)를 따른다.
- 저장은 기존 settings 테이블의 server / `-` 범위와 `server_update.preferences`, `server_update.last_check` 키를 사용한다. migration·공통 registry 변경은 없다. 설정 변경은 감사 로그에 기록한다.
- 확인 결과는 `available|up_to_date|failed`, 채널, 확인 시각, 설정 revision을 보존한다. 성공 시 기존 비교 결과·후보 protocol/schema·현재 플랫폼 artifact 유무를 포함한다. 이전 설정에서 확인한 결과임을 화면에 표시한다.
- 확인 실패 코드는 `local_source_unavailable`, `channel_source_unavailable`, `local_source_required`, `manifest_check_failed`다. 파일 경로·manifest 원문·키·내부 오류는 응답에 노출하지 않는다.
- `UpdateSettings()`는 실제 API를 연결한다. `UpdateSettingsPanel({data, blocked, onSave, onCheck})`는 typed props/callback으로 동작한다. `CheckResult({check})`, `updateResultUnknown(error)`도 export한다. 관련 타입은 `web/app/api/updateSettings.ts`에 있다.
- 저장 응답 이후 GET까지 완료해야 저장 확인을 표시한다. 응답 유실·timeout·서버 오류·확인 GET 실패는 원래 키와 본문을 보존하여 같은 요청으로 복구한다. revision 거부는 초안을 유지한다.
- 지정된 route·Settings mount 연결은 완료했다. 추가 공통 연결은 필요하지 않다. 전용 API 타입은 실제 컴포넌트에서 import하며 typecheck에 포함된다.

## 로컬 확인 소스·실행 경계

서버 관리자가 data_dir의 `update-source.json`을 로컬에 준비하는 명시적 계약이다:

```json
{
  "root": "/absolute/local/trust-root",
  "manifests": {
    "stable": "/absolute/local/stable.json",
    "beta": "/absolute/local/beta.json"
  }
}
```

- `root`의 기존 `trusted-keys.json` 형식과 서명 manifest 형식을 그대로 사용한다. 웹 API는 경로·URL·신뢰 키를 받지 않는다.
- 절대 로컬 경로만 허용한다. 미설정이면 실패 결과를 저장하며 원격 URL로 대체하지 않는다.
- CLI `check`와 서버 확인은 `inspect_manifest`의 기존 검증·비교 경로를 공유한다. 서버 확인은 실행 중 서버 버전과 비교하며 설치의 current 포인터·update-state·서비스를 변경하지 않는다. 후보 패키지도 다운로드하지 않는다.
- 자동 적용 범위는 저장·표시만 한다. executor·주기적 확인·알림 발송·설치·재시작을 새로 구현하지 않았다. patch/minor는 같은 major 내 범위이고 protocol/schema 변경은 자동 적용 범위가 아니라는 설명을 제공한다.
- readiness는 기존 `admin::busy`를 재사용한다. 실행 턴·승인·작업·터미널·예약·MCP의 보류 수를 표시하며 기존 updater의 유예·강제 적용 동작은 바꾸지 않는다. 현재 화면의 readiness는 마지막 조회 시점 기준이며 새로 조회 버튼을 제공한다.
- PWA UI 갱신과 서버 실행 파일 업데이트를 명시적으로 구분한다. PWA·TTS·마이크 정책은 변경하지 않았다.

## 실제 검증

### 기존 유효 근거 보존

아래 Rust·웹 근거는 `fbbd6aa`의 코드·시험 입력 기준이다. 이번 브라우저 후속에서는 제품 코드·시험·환경 설정 파일을 수정하지 않았고 인계 문서만 갱신하므로 통과 근거를 재사용했으며 반복 실행하지 않았다.

| 명령 | 입력·결과 |
| --- | --- |
| `source <원본 저장소>/.envrc.dev && flock /home/ubuntu/.cache/grove-rust-check.lock python3 scripts/build.py test --rust update_settings access` | update_settings 5개·access 9개 통과, exit 0 |
| `source <원본 저장소>/.envrc.dev && flock /home/ubuntu/.cache/grove-rust-check.lock python3 scripts/build.py test --lib --filter update::tests` | 서명·키 회전/폐기·버전 비교·복구·서비스 HTTP redirect 금지 5개 통과, exit 0 |
| `source <원본 저장소>/.envrc.dev && python3 scripts/build.py test --vitest app/components/update/UpdateSettings.test.ts --typecheck` | 최종 코드 기준 7개 통과, typecheck 통과. E2E 소스도 타입 검사 범위에 포함, exit 0 |
| `git diff --check` | 통과 |

- 초기 도구 반환은 `Cancelled`였지만 실제 실행은 계속되었으며, 해당 두 명령의 런타임 완료 알림과 exit 0을 확인했다. 초기 웹 단위 시험 5개 이후 응답 유실 분류를 보완해 최종 7개와 typecheck를 재검증했다.
- 최종 웹 검사 호출 한 번은 실행 시작 전 `atomic lock timeout after 2000ms`로 실패했다. 다른 작업 완료 후 한 번 재시도한 최종 명령이 통과했다. 이를 시험 실패로 숨기거나 통과 수에 더하지 않았다.
- 공통 문서의 경로를 source했지만 `scripts/build.py::env()`가 worktree의 `.dev` 경로를 다시 지정했다. 첫 Rust 검사에서 Rust 1.93.0 도구 5개와 Cargo 의존성 다운로드가 자동 발생했다. 설치·복사를 의도적으로 실행하지 않았고 dependency/lockfile은 변경하지 않았다. 이 환경 동작은 소유 범위 밖이므로 스크립트를 수정하지 않았다.
- 웹은 공통 문서에 따라 메인 node_modules를 symlink해 사용했으며 npm 설치는 하지 않았다.
- 위 취소 반환·lock timeout·자동 다운로드는 최초 구현 당시 이력이다. 이후 브라우저 후속의 새로운 실패·설치가 아니며 기존 시스템 오류 retry count=1을 초기화하거나 재사용하지 않았다.
- 최초 구현에서는 당시 COMMON에 따라 E2E를 실행하지 않았다. 이번 후속 배정으로 정확한 spec의 실행 권한을 받아 아래 검증을 완료했다. 전체 회귀·release·패키징·Windows/ARM64 실기기 검증은 여전히 미실행이며 이번 인수 범위에 포함되지 않는다.

### 후속 브라우저 인수

실제 실행 명령:

```bash
source <원본 저장소>/.envrc.dev && CARGO_TARGET_DIR=<원본 저장소>/target CARGO_BUILD_JOBS=2 CARGO_NET_OFFLINE=true RUSTUP_AUTO_INSTALL=0 flock /home/ubuntu/.cache/grove-rust-check.lock python3 -c 'from scripts import build; build.DEV = "<원본 저장소>/.dev"; build.main(["test", "--e2e", "e2e/update-settings.spec.ts"])'
```

- 현 worktree의 기존 `scripts/build.py` 진입점을 그대로 실행하되, 실행 시 `DEV`만 공용 툴체인 경로로 지정했다. source만 하면 실행기가 다시 로컬 `.dev`를 지정하는 기존 문제를 회피한 것이며 runner 소스·분기·검사·포트는 바꾸지 않았다.
- 공유 target·jobs=2를 사용했고 새 설치·다운로드를 막기 위해 Cargo offline·rustup 자동 설치 금지를 지정했다. 서버 빌드부터 웹 빌드·브라우저 종료까지 전체 명령에 같은 `grove-rust-check.lock`을 적용했다.
- `scripts/build.py`가 이번 코드로 만든 공유 target의 debug 실행 파일을 E2E에 명시적으로 전달했다. 별도 브랜치 동기화·다른 검사 중단·포트 변경·실서비스 재시작·원격 릴리스 조회는 없었다.
- 개발 런타임 fast=false와 다른 모델·런타임 설정은 변경하지 않았다. 실행기의 선택 E2E fast 정책은 기존 기본값 그대로이며 시스템 오류 retry count와 별개다.

| 단계 | wall / CPU / peak RSS | 결과 |
| --- | --- | --- |
| server debug build | 124.07s / 194.23s / 2096.3MB | exit 0 |
| web build | 3.5s / 4.92s / 525.6MB | exit 0 |
| E2E | 5.23s / 4.67s / 264.6MB | desktop 4개 모두 통과, exit 0 |

| 브라우저 시나리오 | 검증한 동작 |
| --- | --- |
| 버전·채널·결과·PWA 구분 | 실제 서버 버전·schema 표시, 알림만 기본값, 로컬 서명 manifest의 새 버전·최신·실패, beta/patch 저장·재조회·새로고침 보존 |
| 일반 기기 읽기 전용 | 실제 기기 인증 GET 200, 설정 PUT/확인 POST 403, 브라우저 필드·확인 버튼 disabled |
| 작업 보류 fixture | 로컬 readiness 응답 fixture의 실행 턴·작업·승인 대기 표시. 실제 작업 중단·설치를 하지 않음 |
| 저장 응답 유실·충돌 | 서버에서 PUT을 완료한 뒤 전송을 abort하여 응답 유실 재현, 같은 요청 재확인 후 revision 1회 증가, 다른 요청의 revision 충돌에서 초안 보존 |

첫 실행에서 4개 모두 통과했고 자기 결함 수정이나 재실행은 필요하지 않았다. 빌드에는 기존 chunk 500kB 초과 경고가 있었지만 모든 단계 exit 0이며 이번 소유 범위의 실패는 아니다. 세션 로그는 `<실행 로그>/shell_da25ba81.stdout`, `<실행 로그>/shell_da25ba81.stderr`다.

## SETTINGS-016 충족 근거·남은 요구

| 요구 | 근거·현재 판정 |
| --- | --- |
| 현재 서버 version/protocol/schema | 실제 HTTP 상수 일치 시험, 화면 단위 시험 통과 |
| 채널·자동 적용 범위·알림 기본값 | 저장·revision·재조회·임시 서버 재기동 후 보존 통합 시험 통과. 자동 적용 실행은 의도적으로 제외 |
| 마지막 확인 새 버전·최신·실패 | 로컬 서명 fixture 통합 시험·화면 단위 시험 통과. 채널 불일치·소스 누락·네트워크 URL 거부·결과 영속화도 확인 |
| 소유자 변경·다른 기기 읽기 전용 | GET 허용, PUT/POST 403, 비인증 401 통합 시험·화면 disabled 표시 시험 통과 |
| 활성 작업 유예·PWA 분리 | 기존 readiness 수 일치·확인 후 작업 유지 통합 시험, 화면 보류·PWA 분리 단위 시험 통과 |
| E2E 완료 조건 | 정확한 지정 spec의 desktop 4개 통과. 버전·채널·결과·권한·응답 유실 복구를 실제 브라우저에서 확인 |

## 다음 통합 단계·blocker

blocker·실행 가능한 소유 잔여·필수 연결 누락은 없다. 브라우저 후속에서는 제품 코드·E2E·Settings 상위 로직을 수정하지 않았으므로 33 Profiles·37 직접 링크·36 MCP 소유권을 건드리지 않았다. 인계 문서 갱신만 관련 로컬 커밋으로 남긴다.

로컬 확인 소스는 운영자가 준비해야 하며, 없을 때의 실패 표시는 의도한 동작이다. 자동 적용 범위는 알림만 기본값의 정책 저장이며 실제 알림 발송·자동 설치·서비스 재시작은 이 작업의 비목표다. 이후 통합·TODO 판정은 메인 소유이며 여기서는 TODO 체크·merge·workspace 정리를 하지 않는다.
