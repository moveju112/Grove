# b02 / 25 — SETTINGS-016 서버 업데이트 설정

## 식별·상태

- Worktree: `/home/ubuntu/.local/share/paseodog/paseo/worktrees/0q796rug/b02-25-update-settings`
- Branch: `parallel/b02-update-settings`
- 공통 기준: `7b3949d24e420d09e6e4cde29405414b2d99253a`
- 상태: 구현 종료, 통합 E2E 검증 대기. 런타임 E2E가 미실행이므로 SETTINGS-016 전체 완료 판정은 보류한다.
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
| `web/e2e/update-settings.spec.ts` | 로컬 서명 fixture·읽기 전용·보류 fixture·응답 유실/충돌 시나리오 4개. 작성 및 typecheck만 완료 |
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
- 지정된 route·Settings mount 연결은 완료했다. 추가 공통 연결은 필요하지 않다. 공통 생성 타입 registry가 필요하다면 통합 담당이 기존 생성기 소유 범위에서 연결할 수 있으며, 현재 전용 타입은 typecheck에 포함된다.

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

| 명령 | 입력·결과 |
| --- | --- |
| `source /data/project/paseodog_opus/.envrc.dev && flock /home/ubuntu/.cache/grove-rust-check.lock python3 scripts/build.py test --rust update_settings access` | update_settings 5개·access 9개 통과, exit 0 |
| `source /data/project/paseodog_opus/.envrc.dev && flock /home/ubuntu/.cache/grove-rust-check.lock python3 scripts/build.py test --lib --filter update::tests` | 서명·키 회전/폐기·버전 비교·복구·서비스 HTTP redirect 금지 5개 통과, exit 0 |
| `source /data/project/paseodog_opus/.envrc.dev && python3 scripts/build.py test --vitest app/components/update/UpdateSettings.test.ts --typecheck` | 최종 코드 기준 7개 통과, typecheck 통과. E2E 소스도 타입 검사 범위에 포함, exit 0 |
| `git diff --check` | 통과 |

- 초기 도구 반환은 `Cancelled`였지만 실제 실행은 계속되었으며, 해당 두 명령의 런타임 완료 알림과 exit 0을 확인했다. 초기 웹 단위 시험 5개 이후 응답 유실 분류를 보완해 최종 7개와 typecheck를 재검증했다.
- 최종 웹 검사 호출 한 번은 실행 시작 전 `atomic lock timeout after 2000ms`로 실패했다. 다른 작업 완료 후 한 번 재시도한 최종 명령이 통과했다. 이를 시험 실패로 숨기거나 통과 수에 더하지 않았다.
- 공통 문서의 경로를 source했지만 `scripts/build.py::env()`가 worktree의 `.dev` 경로를 다시 지정했다. 첫 Rust 검사에서 Rust 1.93.0 도구 5개와 Cargo 의존성 다운로드가 자동 발생했다. 설치·복사를 의도적으로 실행하지 않았고 dependency/lockfile은 변경하지 않았다. 이 환경 동작은 소유 범위 밖이므로 스크립트를 수정하지 않았다.
- 웹은 공통 문서에 따라 메인 node_modules를 symlink해 사용했으며 npm 설치는 하지 않았다.
- E2E·전체 회귀·release·패키징은 COMMON의 독립 구현 규칙에 따라 실행하지 않았다. E2E 시나리오의 런타임 성공은 주장하지 않는다. Windows·ARM64 실기기 검증도 미실행이다.

## SETTINGS-016 충족 근거·남은 요구

| 요구 | 근거·현재 판정 |
| --- | --- |
| 현재 서버 version/protocol/schema | 실제 HTTP 상수 일치 시험, 화면 단위 시험 통과 |
| 채널·자동 적용 범위·알림 기본값 | 저장·revision·재조회·임시 서버 재기동 후 보존 통합 시험 통과. 자동 적용 실행은 의도적으로 제외 |
| 마지막 확인 새 버전·최신·실패 | 로컬 서명 fixture 통합 시험·화면 단위 시험 통과. 채널 불일치·소스 누락·네트워크 URL 거부·결과 영속화도 확인 |
| 소유자 변경·다른 기기 읽기 전용 | GET 허용, PUT/POST 403, 비인증 401 통합 시험·화면 disabled 표시 시험 통과 |
| 활성 작업 유예·PWA 분리 | 기존 readiness 수 일치·확인 후 작업 유지 통합 시험, 화면 보류·PWA 분리 단위 시험 통과 |
| E2E 완료 조건 | 4개 시나리오 작성·typecheck 완료, 런타임 미실행. 이 요구는 아직 충족 판정하지 않음 |

## 다음 통합 단계·blocker

구현 blocker는 없다. 통합 담당이 공통 E2E 자원을 확보해 `python3 scripts/build.py test --e2e e2e/update-settings.spec.ts`를 실행해야 한다. 그 전까지 SETTINGS-016 전체 완료·TODO 체크는 보류한다. 로컬 확인 소스는 운영자가 준비해야 하며, 없을 때의 실패 표시는 의도한 동작이다. 빌드 실행기의 worktree `.dev` 재지정·자동 다운로드도 통합 환경에서 확인할 사항이다.
