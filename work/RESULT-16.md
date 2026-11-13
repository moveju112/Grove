# b02 / 16 — 서버 첫 시작·오류 안내 인계

## 위치·상태

- worktree: `/home/ubuntu/.local/share/paseodog/paseo/worktrees/0q796rug/b02-16-first-start`
- branch: `parallel/b02-first-start`
- 공통 기준: `bc797b36cd0c09ce41eb675d7d152ce95ffa7ef1` (시작 HEAD 및 merge-base 일치)
- 상태: 배정 범위 구현·시험 작성 종료, **컴파일·동작 검증 blocker로 통합 대기**. 검증 완료나 `PC-003` 완료 후보로 간주하지 않는다.
- 세션 조회는 런타임의 `session: cross-session control is unavailable in this runtime`으로 불가했다. 시작 Git 상태는 깨끗했고 다른 변경을 인수하지 않았다.

## 제공 동작·소유 변경

| 파일 | 변경 |
|---|---|
| `src/cli.rs` | `serve` 준비 안내·오류별 종료 코드·`--json` 처리. JSON 모드의 옵션/설정 오류도 JSON으로 출력 |
| `src/startup.rs` | 안전한 원인·조치·경로 보고, 첫 시작/재시작 안내, 기계용 인자 배열 |
| `src/server.rs` | 시작 오류를 내부 구조체로 전달. 기존 공개 `start`와 `acquire_lock`의 문자열 Result 계약 유지 |
| `src/lib.rs` | 비공개 `startup` 모듈 등록 한 줄 |
| `tests/first_start.rs` | 임시 데이터·동적 포트를 사용하는 실제 CLI 회귀 시험 9개 |
| `work/RESULT-16.md` | 이 인계 |

DB가 아직 없으면 `first_start`, 기존 DB가 있으면 `restart`로 안내한다. 정상 초기화·복구와 신호 핸들러 준비 뒤에만 준비 완료를 출력한다.
데이터 디렉터리·DB·owner token **파일 위치**·실제 바인딩 포트·접속 URL·health URL·재시작/doctor 안내를 제공한다.
전체 주소 바인딩의 접속 안내는 IPv4/IPv6 loopback을 사용하고 웹 접속 URL에는 기존 `web_base`를 반영한다.
owner token 원문은 출력하지 않는다. 기존 명시적 `token`/`auth token` 명령의 계약은 바꾸지 않았다.

## 연결·입출력·오류 계약

새 외부 공개 API나 HTTP 라우트는 없다.
내부 `startup::{StartupError, FailureKind}`와 `server::start_with_diagnostics(Config, SharedClock)`를 CLI에서 사용한다.
`server::start(Config, SharedClock) -> Result<Server, String>`은 기존 호출부를 유지하는 래퍼다.
모듈 등록과 실제 CLI·서버 시작 경로 연결을 완료했으며 추가 mount·migration·dependency는 필요하지 않다.

| 종료 코드 | JSON `error.code` | 원인·안내 |
|---|---|---|
| 0 | 해당 없음 | 준비 후 정상 종료 |
| 2 | `configuration` | serve 옵션/환경 설정 오류, 설정 확인 |
| 10 | `port_in_use` | 사용 중 포트, 기존 서버 진단 또는 다른 `--listen` |
| 11 | `data_permission` | 경로 접근 권한, 소유자·상위 디렉터리 권한 확인 |
| 12 | `database_busy` | DB 잠금, 기존 작업 완료 후 재시도·파일 삭제 금지 |
| 13 | `schema_mismatch` | 더 새로운 DB schema, 호환 버전 사용·다운그레이드/덮어쓰기 금지 |
| 14 | `already_running` | 동일 데이터 디렉터리 서버, 진단 후 정상 종료·재시작 |
| 15 | `storage` | 그 밖의 데이터/DB 준비 오류, 원본 보존·읽기 전용 doctor |
| 16 | `runtime` | 실행 환경 준비 오류 |
| 17 | `listen` | 그 밖의 바인딩 오류 |

사람용 실패는 stderr, 준비 안내는 stdout에 출력한다.
JSON 모드는 stdout에 단일 준비 또는 실패 객체를 출력한다. 기존 런타임 로그는 기존 stderr/파일 로그 경로를 유지한다.
실패 객체는 `status`, `ready`, `error.{code,exit_code,cause,action,path}`를 제공한다.
Config 생성에 성공했으면 `data_dir`, `db_path`, `owner_token_file`, `listen`, `doctor_args`도 포함한다.
준비 객체는 `mode`, 위 경로/주소, `url`, `health_url`, `restart_args`, `doctor_args`, `restart_action`을 제공한다.
`restart_args`는 `grove` 뒤에 전달할 인자 배열이며 환경변수를 대신하지 않는다. 동일 환경 설정도 유지해야 한다.
외부 원본 오류·stack·토큰은 보고 객체에 포함하지 않는다. 권한을 변경하거나 DB/잠금을 자동 삭제·복구하지 않는다.
health·version 형식, 정상 종료·복구 경로, systemd 서비스 정의/설치기는 변경하지 않았다.

## 실행한 검사·제약

아래 실행은 worktree에서 `source .envrc.dev`를 먼저 적용했다. 설치·툴체인 복사·공통 설정 수정·E2E 실행은 하지 않았다.

| 명령 | 실제 결과 |
|---|---|
| `source .envrc.dev && python3 scripts/build.py test --rust first_start cli` | exit 1. `FileNotFoundError: [Errno 2] No such file or directory: 'cargo'`. cargo 실행 전 중단했으므로 컴파일·Rust 시험 모두 미실행 |
| `source .envrc.dev && python3 scripts/build.py test --typecheck` | exit 127. `sh: 1: react-router: not found`. typegen에서 중단, TypeScript 검사 미실행 |
| `source .envrc.dev && python3 scripts/build.py test --rust first_start cli --dry-run` | exit 0. `cargo test --test first_start --test cli` 선택만 확인. 컴파일·시험 통과가 아님 |
| `git diff --check` | 통과. 공백 오류 없음. 컴파일·동작 검증을 대체하지 않음 |

Rust 선택 검사 실패 뒤 JSON 옵션 오류 분기·회귀 시험을 보완했다. 도구 부재가 바뀌지 않아 Rust 검사를 반복하지 않았다.
Vitest는 웹 변경·해당 시험이 없어 미선택이다. E2E·전체 회귀·release는 COMMON의 통합 단계 범위라 미실행이다.
환경 복구는 통합 담당의 승인된 빌드 환경에서 수행해야 한다. 현재 worktree에는 빌드 실행기가 요구하는 `.dev` 및 웹 실행 도구가 없다.

## PC-003 요구와 남은 조건

작성된 Rust 시험은 JSON 첫 시작·안내 인자 재실행·데이터/토큰 보존·health/version 계약, 사람용 첫 시작/재시작·전체 주소 접속 안내, 포트 충돌, 동일 데이터 중복 서버, schema 불일치, 실제 SQLite 외부 잠금, Unix 권한 거부, 잘못된 환경/옵션 JSON을 다룬다.
모든 데이터·잠금·프로세스는 시험 소유 임시 경로를 사용하며 오류·비밀값 assertion에 토큰 원문을 넣지 않았다.

아직 어떤 Rust 시험도 컴파일·실행되지 않았으므로 첫 시작·재시작·오류별 종료 코드가 검증됐다고 주장하지 않는다.
Windows 자동 시작(`PC-014`)·설치 프로그램·실제 systemd 설치/재시작·Windows 권한 오류는 이번 범위 밖이거나 미검증이다.
기존 store 시작 오류가 문자열만 보존하므로 schema/SQLite 잠금/읽기 전용 원인은 기존 오류 문구로 분류한다. 원문은 출력하지 않고 그 밖의 오류는 `storage`로 보고한다.

## 다음 통합 단계

1. 승인된 공통 빌드 환경에서 `python3 scripts/build.py test --rust first_start cli api --typecheck`를 실행한다. `api`는 기존 `start` 래퍼의 포트 충돌·중복 서버 계약까지 확인하는 범위다.
2. 컴파일/시험 실패를 해결하고 필요한 플랫폼·서비스 통합 검증을 마친다. 현재 통과 근거는 dry-run과 공백 검사뿐이다.
3. `PC-003`의 필수 동작 검증이 실제로 통과한 뒤 통합 담당이 `TODO.md` 완료 여부를 판단한다. 기능 담당은 TODO를 수정하지 않았다.

push·merge·배포·사용자 서비스 조작·다른 worktree 수정은 하지 않았다.
