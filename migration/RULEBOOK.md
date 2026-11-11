# Grove 설계 문서 (재설계 이전용 RULEBOOK)

> 메타 규칙: 두 구현자가 다르게 답할 수 있는 질문은 여기에 답을 둔다.
> 재설계 이전이므로 이 문서는 "구문 번역표"가 아니라 "새 구조의 설계"다. 원본은 동작 명세로만 쓴다.

## 0. 범위와 자세

- **재설계 이전.** 원본(`/home/ubuntu/project/paseodog`, 기준 SHA `73416e27c452a9285611bf7fc33290e6d3b7cbec`)의 사용자 동작을 보존하되 구조는 새로 만든다. 원본 읽기는 `git show 73416e27:<path>`로 고정 SHA 기준으로 한다(작업 트리 HEAD는 25커밋 앞서 있음).
- 작업 단위는 파일이 아니라 **서브시스템**(TODO 영역 접두어)이다.
- 컴파일러는 저렴하므로 각 단위 루프 안에서 `cargo check`/`cargo test`, `tsc`를 실행한다(키트 README Step 4 흡수 규칙).
- 1차 목표는 동작 정확성. 느리지만 맞는 구현은 `PERF(port):` 표시 후 진행.
- 완료 판정은 TODO.md 체크박스 규칙(§0 "작업 표기와 완료 조건")을 따른다. 실기기·실계정·과금이 필요한 검증은 이 환경에서 수행하지 못하면 체크하지 않고 blocker로 남긴다.

## 1. 생태계 채택

| 영역 | 결정 | 이유 |
|---|---|---|
| Rust 버전 | 1.93.0 고정(`rust-toolchain.toml`), 개발 툴체인은 `.dev/`에 격리 | 재현성, 다른 프로젝트와 분리 |
| crate 구성 | 단일 crate `grove`, 실행 파일 `grove` 하나 | ARCH-001·003: 컴파일 경계가 필요할 때만 분리 |
| 비동기 | Tokio multi-thread runtime. blocking I/O·SQLite는 `spawn_blocking` 또는 전용 DB 스레드 | ARCH-014 |
| HTTP | Axum + tower-http(필요 기능만: cors 미사용, limit, trace, fs) | FRAME-001 |
| DB | rusqlite(`bundled`) + WAL, 연결은 쓰기 1개 직렬화 + 읽기 풀 없음(초기) | 단일 서버, 이식성(Windows/ARM64 정적 포함) |
| 직렬화 | serde / serde_json | 표준 |
| ID | UUID v7 문자열(시간 정렬) | ARCH-005: 서버만 생성 |
| 해시 | sha2 (SHA-256 hex) | 파일 revision·원문 baseline |
| HTTP client | reqwest(rustls, stream) | provider 어댑터 |
| 타입·검증 정보 생성 | `ts-rs`로 Rust 계약 → `web/app/api/generated.ts`, TypeScript compiler API로 `generated.metadata.ts` 생성 | NET-002. `tests/ts_bindings.rs`가 두 산출물의 drift를 검사한다. 갱신은 `GROVE_UPDATE_BINDINGS=1 python3 scripts/build.py test --rust ts_bindings`(Node·웹 개발 의존성 필요). `parseContract`는 추가 필드를 허용하되 필수·중첩 타입을 검사하고 미지원 선언은 생성 실패로 처리한다 |
| 시간 | `time` crate(UTC, RFC3339) | chrono 대신 경량 |
| CLI | 직접 파싱(인자 수 적음) | 의존성 예산 |
| 웹 | React 19 + React Router 7 framework 모드 `ssr:false` + Vite, TypeScript strict | FRAME-007, DEC-008 |
| 웹 시험 | Vitest(상태 로직) + Playwright(실제 서버·Chrome) | 기존 설치된 Google Chrome 사용 |
| 금지 | Node 런타임 서버, Mixdog/Paseo 패키지, 내부 RPC, 동적 플러그인 프레임워크, DI container | TODO §0 |

## 2. 원본 구성 → Grove 구성 대응 (재설계 매핑)

| 원본 | Grove | 비고 |
|---|---|---|
| Paseo 데몬 + Mixdog 엔진 + 플러그인 3프로세스 | `grove serve` 단일 프로세스 | JSON Lines 브리지 제거 |
| Paseo WebSocket 메시지(`messages.ts`) | HTTP JSON 요청(`/api/v1/...`) + SSE 이벤트 stream(`/api/v1/events`) + 터미널 전용 WebSocket | NET-004 결정. 구 wire 비호환(DEC-014) |
| 데몬 저널 파일 | SQLite `events` 테이블(outbox, 단조 증가 `seq`) | NET-006, STORE-003 |
| 세션/에이전트 상태 객체 중복 | DB 행이 실행 상태의 단일 원천, UI는 투영 | ARCH-006 |
| Expo/React Native 앱 | 공용 웹앱/PWA (`web/`) | |
| Mixdog 내장 도구(read/grep/glob/find/list/edit/shell...) | `src/tools/*` 동일 계약의 Rust 구현 | 승인 정책은 서버 강제 |
| Mixdog 기본 에이전트/워크플로우 원문 | `assets/agents/*.md`, `assets/workflows/*.md` 바이트 그대로 + `manifest.json`(sha256) | EVAL-001, WORKFLOW-001 |

## 3. 핵심 불변식 (모든 구현자가 따를 것)

1. **접수 = 영속.** 상태 변경 요청은 DB commit 후에만 성공 응답. 응답에는 receipt(작업 ID)를 포함한다.
2. **idempotency.** 모든 mutation 요청은 `Idempotency-Key` 헤더(필수)를 받는다. 같은 키+같은 요청 본문 hash → 저장된 응답 재반환, 같은 키+다른 본문 → `409 idempotency_conflict`. 키는 소유 주체(토큰 ID) 범위.
3. **revision.** 수정 가능한 자원(세션·정의·설정·초안·레이아웃·파일)은 정수 `revision` 또는 내용 hash를 가지며, 수정 요청은 `expected_revision`을 필수로 받는다. 불일치 → `409 revision_conflict`(현재 값 포함).
4. **이벤트.** 상태 변경과 같은 transaction에서 `events`에 행을 추가한다. SSE는 `Last-Event-ID`/`?cursor=`로 이어받고, 보존 범위 밖 cursor는 `resync_required` 이벤트를 보낸 뒤 종료한다(클라이언트는 snapshot 재조회).
5. **결과 불명.** 외부 부작용(파일 쓰기·셸·원격 API)은 시작 전 `running` receipt를 commit한다. 완료 기록 전 중단되면 재시작 시 `unknown`으로 바꾸고 절대 자동 재실행하지 않는다. `unknown`은 사용자 검토 기록 없이는 성공으로 바뀌지 않는다.
6. **실행 대상 고정.** 모든 실행 요청은 `project_id`/`session_id`를 명시한다. 서버에 "현재 프로젝트" 전역 상태는 없다. UI pane은 자신의 대상 ID를 요청에 넣는다.
7. **경로 경계.** 파일 도구 경로는 프로젝트 root 기준으로 canonicalize 후 root 밖이면 거부. symlink 탈출도 canonicalize로 차단.
8. **비밀정보.** API 키·토큰은 `secrets` 테이블(로컬 파일 권한 0600 DB)과 응답에서 마스킹. 로그·이벤트·오류에 원문 금지.
9. **인증.** loopback 포함 모든 `/api` 요청은 Bearer 토큰 필요(`/api/v1/health` 제외). 브라우저 요청은 `Origin`/`Sec-Fetch-Site` 검사로 교차 사이트 거부.
10. **시간.** 서버는 UTC RFC3339 문자열로 저장/응답한다. 시험 가능성을 위해 `Clock` trait을 둔다.

## 4. 오류 모델

- Rust: `ApiError { status, code: &'static str, message: String, details: Option<Value> }` 하나로 HTTP 응답 변환.
- 표준 code: `unauthorized`, `forbidden`, `not_found`, `invalid_request`, `revision_conflict`, `idempotency_conflict`, `busy`, `queue_full`, `unsupported`, `internal`, `cancelled`, `gone`, `method_not_allowed`, `payload_too_large`, `unsupported_media_type`. Axum의 JSON·라우팅·body limit 오류도 같은 envelope로 변환한다.
- 응답 본문: `{"error":{"code","message","retryable":bool,"details"?}}`.
- 내부 오류는 `internal` + 상관 ID만 노출, 상세는 로그.
- 도메인 함수는 `anyhow` 대신 모듈별 `thiserror` 열거형을 쓰고 경계에서 `ApiError`로 변환.

모델 입력 조회(DB-012): 표시 원본과 모델 입력 표현을 함께 적재하지 않고 `sessions::visit_model_history`로 활성 구간을 순차 처리한다. 압축된 구간은 요약만 읽고, 상속한 분기에도 fork 당시의 압축·상위 분기 경계를 적용한다. 모델 호출·압축은 필요한 활성 입력을 보관하지만 미리보기는 요청 페이지와 항목당 최대 4000자만 보관한다. 사용량 추정도 본문을 누적하지 않는다. 정확한 병합·도구 짝과 전체 개수 계산을 위해 조회 시간은 활성 구간 크기에 비례한다.

백업 staging(DB-016·017): 목적지와 같은 디렉터리에 고유 private staging(Unix 0700)을 만들고 검증·파일 권한(Unix 0600) 설정 후 `rename_noreplace`로 게시한다. 사전 존재 검사 뒤에 대상이 생겨도 덮어쓰지 않으며 dangling symlink도 보존한다. 생성한 staging만 정리하고 기존 고정 `*.partial`은 소유권을 추정해 지우지 않는다.

### HTTP 요청 수명 (NET-003)

| 경계 | 계약 |
|---|---|
| request ID | `X-Request-Id`의 UUID를 정규화해 모든 API 응답과 요청 tracing span에 붙인다. 없거나 잘못됐으면 서버가 발급한다. 인증 재시도마다 새 ID를 쓰되 `Idempotency-Key`는 유지한다. request ID는 실행 중복 방지 키가 아니다 |
| timeout·연결 취소 | 공용 JSON·바이너리 클라이언트는 body 수신까지 기본 300,000ms(`timeoutMs`로 요청별 변경)를 제한한다. `ApiError`의 `status: 0`, `request_timeout`·`cancelled`·`network_error`와 request ID를 반환한다. 서버 실행을 취소하지 않는다. 변경 전송 후에는 `details.result_unknown: true`와 원래 idempotency key를 보존하고 자동 재실행하지 않는다 |
| 실행 취소 | 턴 `POST /turns/{id}/cancel`의 `202 {cancel_requested:true, turn}`은 요청 접수이지 종료 보장이 아니다. 작업 `POST /tasks/{id}/cancel`의 `{cancelled, task}`에서 bool은 취소 신호 전달 여부다. 최종 자원 상태를 조회·이벤트로 확인한다. SSE·터미널 WebSocket은 일반 요청 timeout 대상이 아니다 |

다중 기기(NET-013): 설정 편집 초안은 편집을 시작한 revision과 결합한다. SSE 재조회로 최신 값이 도착해도 초안의 revision을 바꾸지 않는다. 충돌하면 초안을 보존하고 최신 값 사용 또는 명시적 덮어쓰기를 선택한다. 승인 경합은 transaction에서 첫 결정만 확정하고 나머지 기기에는 `already_decided`와 현재 상태를 반환한다.

접속 경로(NET-005): 로컬·LAN·VPN·원격은 모두 같은 `/api/v1`과 같은 서버의 웹앱을 사용한다. 기본은 loopback이고 외부 접속은 `GROVE_LISTEN`/`--listen`으로 명시한다. 외부 공개 시 `GROVE_ALLOWED_HOSTS`에 실제 Host(포트 포함)를 제한하고 앞단 HTTPS에서 TLS를 종료한 뒤 `GROVE_TLS_TERMINATED=1`로 Secure refresh 쿠키를 사용한다. 이 설정은 TLS 자체를 제공하지 않는다. 장기 자격증명을 외부 평문 HTTP로 보내지 않는다. HTTP authority 계약 시험과 실제 네트워크·인증서·방화벽 검증은 구분한다.

## 5. 경로·이름

- Rust 모듈: `src/<영역>.rs` 또는 `src/<영역>/mod.rs`. 영역 이름은 소문자 단수(`store`, `auth`, `events`, `sessions`, `turns`, `tools`, `provider`, `agents`, `settings`, `layout`, `shell`, `git`...).
- Rust 통합 시험: `tests/<영역>.rs`, 공용 harness `tests/common/mod.rs`(임시 디렉터리 + 실제 서버 기동).
- FLOW 판정 시험: `tests/flow_<nn>.rs`(서버 API 수준) 및 `web/e2e/flow-<nn>.spec.ts`(브라우저 수준).
- 웹: `web/app/routes/*`, 상태 로직 `web/app/state/*`(순수 함수 + Vitest), API 클라이언트 `web/app/api/*`.
- 데이터 경로: Linux `$XDG_DATA_HOME/grove`(기본 `~/.local/share/grove`), Windows `%LOCALAPPDATA%\Grove`. `GROVE_DATA_DIR`로 재정의(시험은 항상 임시 디렉터리). 비었거나 상대 경로인 환경값은 무시하고, 정할 수 없으면 추측하지 않고 시작을 거부한다(`config::data_dir_for`).
- 설정·캐시 경로: 설정은 DB(`settings`)에 두므로 별도 설정 파일·`$XDG_CONFIG_HOME` 경로가 없다. 다시 만들 수 있는 캐시를 두지 않으므로 `$XDG_CACHE_HOME`도 쓰지 않는다. 데이터 디렉터리의 파일(DB·blobs·작업 로그·휴지통·worktrees·키)은 모두 사용자 데이터다. 실행 로그는 설치 위치 `logs/`(서비스 설치 시).
- 환경변수 prefix `GROVE_`.
- 표식: `TODO(port):`, `PERF(port):`, `BUG(port):`, `SAFETY:` — 형식 고정.

## 6. 서브시스템 순서 (의존성 지도)

```
config/paths → store(migration) → auth → events → projects → sessions/messages
  → recent/layout/drafts → provider → turns(run loop) → approvals → tools(files/search/edit)
  → shell/process → git → agents/workflows → settings → memory/recall → usage
  → backup/snapshot → web UI(각 단계와 동시) → PWA → package/release
```
사이클 금지: 하위 모듈은 상위 모듈을 import하지 않는다(`turns`는 `tools`를 쓰고, `tools`는 `turns`를 모른다).

## 7. Gap inventory 위치

`migration/inventory.tsv` — 소유권/취소/결과 불명/경계 지점을 한 줄씩 기록.

## 8. 파일 상태 trailer

재설계에서는 파일 단위 trailer 대신 TODO.md의 ID별 체크와 `검증:` 주석을 상태로 쓴다(키트 §6 대체, DEV-003).

## 10. 버전 호환 범위 (DEC-014)

구제품(Paseo·Mixdog)의 wire protocol·플러그인 ABI 호환 계층은 만들지 않는다. 새 제품 안에서의 호환 규칙은 아래와 같다.

| 경계 | 규칙 | 강제 위치 |
|---|---|---|
| HTTP API | 경로 `/api/v1`. v1 안에서는 필드·경로 추가만 허용하고, 필드 의미 변경·삭제는 `PROTOCOL_VERSION`을 올린다 | `src/lib.rs` `PROTOCOL_VERSION` |
| 화면 ↔ 서버 | 웹앱은 같은 서버가 배포하므로 같은 버전이 기본이다. 오래 열린 탭은 모든 요청에 `X-Grove-Protocol`을 보내고, 서버는 다른 protocol의 변경 요청을 `409 protocol_mismatch`로 실행하지 않는다. 조회는 허용하고, 화면은 새로고침을 안내하며 변경 요청을 보내지 않는다 | `web::protocol_guard`, `web/app/api/client.ts` |
| DB schema | migration은 뒤에 추가만 한다(배포된 migration 수정 금지: hash 시험). 실행 파일보다 새 schema의 DB로는 시작하지 않는다. 다운그레이드는 지원하지 않고, 업데이트 전 snapshot으로 되돌린다 | `store::migrate`, `store::tests::migrations_are_append_only`, `tests/api.rs` |
| 이벤트 cursor | 보존 범위 밖 cursor는 `resync_required` 후 snapshot 재조회 | `events` |
| CLI·외부 도구 | `X-Grove-Protocol` 없이 호출하면 검사하지 않는다(사람이 쓰는 도구는 오류 메시지로 판단) | `web::protocol_guard` |

## 12. 자동화(예약 실행) 정책 (AUTO-003~007, 011, 012)

| 상황 | 동작 | 강제 위치 |
|---|---|---|
| 시간대 | 예정 시각은 UTC로 저장한다. 매일 실행은 예약에 저장한 고정 UTC offset으로 계산한다. 서버가 지역 DST 규칙을 추측하지 않으므로 offset이 바뀌면 사용자가 다시 저장한다(화면에 안내) | `schedules::next_after` |
| 놓친 실행(서버 꺼짐·시계 앞으로 이동) | 예정 시각에서 `missed_grace_minutes`(기본 10분)를 넘기면 실행하지 않고 `missed`로 한 번 기록한 뒤 다음 예정 시각으로 넘어간다. 따라잡기 연쇄 실행은 없다 | `schedules::decide` |
| 서버 시계 뒤로 이동 | 다음 예정 시각이 한 주기보다 1분 넘게 멀어지면 현재 시각 기준으로 다시 계산한다 | `schedules::decide` |
| 중복 실행 | 같은 예정 시각은 `UNIQUE(schedule_id, planned_at)`로 한 번만 실행한다. 이전 실행이 끝나지 않았으면 예약 실행은 `skipped_overlap`, 수동 실행은 `409 busy` | `schedules::fire`, `run_now` |
| 재시작 | 이전 프로세스의 실행 턴은 `interrupted`가 되고 실행 로그도 그렇게 닫힌다. 같은 예정 시각을 다시 실행하지 않는다 | `runner::finish_turn` → `schedules::on_turn_finished` |
| 승인 | 자동 승인하지 않는다. `on_approval=wait`이면 사람이 승인할 때까지 대기하고, `fail`이면 턴을 `approval_required`로 실패시킨다 | `runner` 확정 단계 |
| 허용 도구·token 한도 | 예약에 저장하고 턴의 정의 snapshot에 고정한다. 허용 목록 밖 호출은 실행 없이 failed, 누적 token이 한도를 넘으면 남은 도구 호출을 계획하지 않고 `budget_exceeded`로 끝낸다 | `runner` 확정 단계 |
| 알림 | 실행 종료·놓침·시작 실패는 서버 DB의 영속 알림으로 남긴다. 알림은 모델을 다시 부르지 않는다 | `notifications::push` |

## 13. SQLite 운영 정책 (DB-010)

| 항목 | 정책 | 강제 위치 |
|---|---|---|
| journal | WAL. 읽기는 쓰기 잠금 중에도 진행된다 | `store::open` |
| 쓰기 직렬화 | 서버 프로세스의 쓰기 연결은 1개이며 요청은 그 연결에서 순서대로 실행한다. 같은 데이터 디렉터리의 두 번째 서버는 잠금 파일로 시작을 거부한다 | `store::Db`, `server::start` |
| busy timeout | 5초. 넘으면 `409 busy`(`retryable: true`)로 숨기지 않고 알리며, 실패한 transaction은 아무것도 남기지 않는다 | `error.rs` `From<rusqlite::Error>` |
| checkpoint | 평소에는 SQLite 자동 checkpoint(1000 page), 정상 종료 시 `wal_checkpoint(TRUNCATE)`. 백업은 SQLite backup API로 일관된 snapshot을 만든다 | `server::Server::stop`, `backup.rs` |
| 시험 | 외부 연결의 쓰기 잠금 1.2초 → 대기 후 성공, 6.5초 → busy 후 재시도 성공·`integrity_check` ok | `tests/db_lock.rs` |

## 14. 빌드·패키징 (BUILD)

진입점은 `scripts/build.py` 하나다(표준 라이브러리만 사용). 저장소 전용 툴체인은 `.dev/`(rustup·cargo·zig·cargo-zigbuild)에 두고 시스템 패키지에 의존하지 않는다.

| 명령 | 용도 |
|---|---|
| `build.py dev` | debug 서버 + 웹. release 최적화를 하지 않는다 |
| `build.py test --rust TARGET / --lib [--filter NAME] / --vitest FILE / --e2e FILE / --typecheck` | 선택 검사. E2E는 debug 서버·웹 빌드 후 해당 실행 파일로 수행 |
| `build.py test --full` | 명시적 전체 Rust·타입·Vitest·Playwright 인수. 개별 기능마다 실행하지 않음 |
| `build.py test … --dry-run` | 실행 없이 검사 범위 확인. 실패 코드는 보존하고 뒤 단계는 미실행으로 보고 |
| `build.py plan --changed <파일…>` | 변경 영향: 문서만→없음, UI만→웹, 서버만→서버, `generated.ts`/`lib.rs`→protocol(둘 다), lockfile·toolchain·빌드 스크립트·모르는 파일→전체 |
| `build.py package [--targets …] [--dry-run] [--jobs N]` | release artifact |

| 규칙 | 내용 |
|---|---|
| 구성 | Rust 서버 1개 crate + `web/` 정적 SPA. Tauri·Android·Electron 의존성 없음. 셸 채택 시에만 별도 추가 |
| 고정 | `rust-toolchain.toml`(1.93.0), `Cargo.lock`(`--locked`), `web/package-lock.json`·정확한 npm 버전 |
| target | linux-x64(native), linux-arm64(zig, glibc 2.31), windows-x64(zig, windows-gnu) |
| 웹 | 입력 hash당 한 번 빌드해 모든 target이 같은 bytes를 쓴다. UI만 바뀌면 cargo는 재컴파일하지 않는다(fingerprint 불변) |
| 재사용 | target 입력 hash(서버·웹 입력 + toolchain + node + target)가 같고 receipt의 artifact sha256을 다시 계산해 일치할 때만. 아니면 그 target만 다시 만든다 |
| 변경 없음 | 모든 target 재사용이면 아무것도 빌드·패키징하지 않고 끝난다 |
| 병렬도 | `min(CPU, 메모리GB/2)` |
| 개인 경로 | `--remap-path-prefix`로 저장소·cargo·rustup·홈 경로를 지운다. 패키지는 개인 경로·실제 비밀값 형식·개발 파일(.map/.log/.db/.env)을 검사해 있으면 실패 |
| 산출물 | `dist/release/grove-<ver>-<target>/`: 압축본(tar.gz/zip), `manifest.json`(version·protocol·schema·target·source/입력 hash·toolchain·파일별 sha256), `sbom.cdx.json`(CycloneDX 1.5), `SHA256SUMS`, `receipt.json`. 압축본 안에 `licenses/`(Mixdog 원문 라이선스·NOTICE, `THIRD_PARTY_NOTICES.txt`) |
| 라이선스 | `scripts/check_licenses.py`: 4개 플랫폼 cargo 그래프 + 웹 번들 npm 의존성. 허용 목록 밖이면 실패 |
| 실행 검증 | 압축본을 임시 폴더에 풀어 `version --json`이 manifest와 같은지, `serve` 후 health `ready`·웹 200인지 확인. linux-x64는 직접, windows-x64는 wine(실제 Windows 검증은 별도), linux-arm64는 ARM64 장치에서만 |
| 측정 | 단계별 wall·CPU·peak RSS를 `dist/build-log.json`에 기록(`wait4`) |
| commit | 저장소가 git이 아니면 `commit: null`이고 `source_hash`로 식별한다 |
| 시험 | `python3 -m unittest scripts/test_build.py`(영향 규칙 fixture·검사기) |

## 15. 성능 기준선과 예산 (PERF)

측정 도구: `scripts/perf.py`(실행 성능, `--check`로 `scripts/perf_budget.json` 예산 검사), `scripts/build.py bench`(빌드), `build.py package`(`dist/build-log.json`). 결과 JSON은 `dist/perf/`.
환경: Linux x86_64, 8 CPU, 31GB RAM, 2026-11-05. 외부 모델 지연은 로컬 fixture(50 chunk × 10ms = 500ms)로 고정하고 빼서 로컬 처리 시간을 구했다.

| 항목 | 기준선 | 예산(회귀 한도) |
|---|---|---|
| 서버 시작(새 데이터 / 기존 데이터) p95 | 37.7ms / 7.0ms | 200 / 50ms |
| idle 메모리(빈 서버, RSS·PSS) | 13.0MB · 10.8MB, CPU 0% | 40MB, 0.5% |
| 대화 1 / 10 / 50개(각 메시지 20개) idle RSS | 14.0 / 14.6 / 16.0MB | 50개에서 50MB |
| 조회 p95: 대화 목록·대화 열기·최근·본문 검색 | 1.43·0.81·0.60·1.43ms | 10·10·10·50ms |
| 동시 턴 10개: 로컬 처리 p50 / RSS | 11ms / 18.9MB | 50ms / 64MB |
| 취소 응답 p95(stream 중 cancel → cancelled) | 2.5ms | 50ms |
| 연결·세션 생성/보관 각 200회 | +2.2MB, 이후 idle CPU 0% | 16MB |
| 장시간 반복(6라운드) | 각각 따로는 일정 수준에서 멈춤(SSE 17.6MB, 세션 15.8MB). 함께 돌리면 재생할 이벤트 수에 비례해 늘지만 이벤트 보존 5만 개·10분 주기 정리로 상한이 있음 | — |
| 실행 파일 / 패키지 | 15.8MB / tar.gz 6.9MB(linux-x64) | — |

빌드(같은 머신, `build.py bench`·`package`):

| 단계 | wall | peak RSS |
|---|---|---|
| 처음부터 debug 빌드 | 37.9s | 1.43GB |
| 서버 파일 하나 수정 | 4.7s | 0.90GB |
| UI 파일 하나 수정 | 웹 2.3s, 서버 0.13s(재컴파일 없음) | 0.50GB |
| protocol 변경(서버·바인딩·웹) | 2.8 + 7.7 + 2.4s | 1.14GB |
| release 패키지 3개 target(cold, 서버 재사용 없음) | 약 95 + 64 + 62s + 웹 2.5s | 1.72GB(arm64) |

예산: 서버 한 파일 warm 30s·2GB, UI 한 파일 10s·1GB, 전체 cold package 10분·4GB. 넘으면 기능 완료와 별개로 원인을 profiling해 기록한다.

LTO(BUILD-028): thin·cgu4(현재) 106s·16.2MB, off·cgu16 89s·16.9MB, fat·cgu1 197s·14.4MB. 실행 성능 차이는 측정 오차 안이라 현재 설정 유지.

기존 제품 비교(같은 머신, 읽기 전용 측정, 대화 여러 개 실행 중이라 idle 아님): Paseo 서버 트리 32개 프로세스 PSS 3,190MB·CPU 2.7%, Electron 앱 8개 프로세스 PSS 671MB. Grove는 서버 1개 프로세스이고 UI는 기존 브라우저 탭이다(브라우저 메모리는 별도 측정 대상).

## 16. 설치·업데이트 (UPDATE)

updater는 같은 실행 파일의 CLI(`grove install|update|start|stop|release`)로 동작하는 일시적 프로세스다. 상주 업데이트 데몬은 없다. 서비스 관리자는 `process`(updater가 직접 띄움) 또는 `systemd-user:<unit>`.

| 규칙 | 내용 | 시험 |
|---|---|---|
| 배포물 | 서버 단독 압축본(실행 파일 + web + licenses + manifest). Node·npm·git 불필요 | `scripts/test_update.py` 새 설치 |
| 설치 구조 | `releases/<version>-<sha12>/`, `current`·`previous` 포인터 파일(원자적 교체, Windows 호환), `install.json`, `trusted-keys.json`, `backups/`, `receipts/` | 〃 |
| 서명 | release manifest = `{signed, signatures[{key_id, sig}]}`, ed25519, 서명 대상은 키 정렬 JSON. 신뢰 키 하나의 유효한 서명 필요. 서명이 유효한 manifest만 `rotate_keys`·`revoke_keys`를 반영하고, 적용이 성공했을 때만 저장 | `update::tests`, 변조·모르는 키 거부 |
| 배포 서명 키 | 소유자가 `grove release keygen`으로 만든다. 빌드 내장 키(`BUILTIN_KEYS`)는 비어 있고 설치 시 `--trust-key`로 넣는다 | — |
| 구분 | 새 설치(`install`, 이미 있으면 거부) / 확인(`check`: upgrade·same·downgrade, 서비스 무중단) / 다운그레이드는 `--allow-downgrade`가 필요하고, schema가 현재 데이터보다 낮으면 항상 거부 | 〃 |
| 적용 | lock → 서명 → 이미 적용(같은 artifact hash로 실행 중)이면 종료 → 다운로드 크기·hash → 압축 해제(경로 탈출 거부)·파일 hash·`version --json` 대조 → 실행 중 작업이 있으면 보류(종료 코드 3, `--force`는 중단 대상 출력) → DB snapshot → snapshot 복사본에서 새 버전 `migrate-check` → 정지·포인터 전환·시작 → readiness(health ready·버전·인증 조회·웹 200) | 〃 (중단 약 0.4초) |
| 실패 복구 | schema 그대로면 포인터만 되돌린다. migration이 일어났으면 snapshot 이후 이벤트가 늘지 않았을 때만 실패한 DB를 `backups/failed-*`에 보관하고 snapshot을 되돌린다. 늘었으면 덮어쓰지 않고 서비스를 멈춘 채 `needs_attention`. `previous`도 적용 전 값으로 복원 | 고장 버전 C 시험 |
| 결과 | 결과는 데이터 디렉터리 `update-receipts/`에 먼저 파일로 남기고, 준비된 서버에 가져오기를 요청해 알림으로 만든다. 서버는 시작할 때 가져오지 않는다(readiness 중 시스템 기록이 복구 판정을 흐리지 않게). `/updates`는 파일에서 직접 조회 | 결과 알림·`/updates` |
| 수동 되돌리기 | `update rollback`: previous의 schema가 현재 데이터를 열 수 있을 때만 | 〃 |

## 17. 비밀정보와 자식 프로세스 환경 (SEC)

| 규칙 | 내용 | 시험 |
|---|---|---|
| 접근 토큰 | DB에는 hash만. 한 번만 보이는 토큰 응답은 재전송 저장본에 남기지 않음 | `tests/api.rs` |
| API 키 | 데이터 디렉터리 `secret.key`(32B, 0600)로 ChaCha20-Poly1305 암호화(`v1:` 접두어). 이전 평문은 시작 시 암호화. snapshot에는 암호문만 있으므로 복원본에서 쓰려면 키 파일을 따로 옮긴다. 키가 없거나 손상되면 목록에 "해독 불가", 실행은 `secret_unreadable` | `tests/secrets.rs`, `vault::tests` |
| OS credential store | headless 서버가 기본 대상이라 OS keyring 대신 파일 키 + 권한 제한을 쓴다(데스크톱 keyring 연동은 범위 밖, DEC 기록) | — |
| 모델 셸 도구 환경 | 자격증명처럼 보이는 이름(`TOKEN`·`SECRET`·`PASSWORD`·`API_KEY`·`AUTH`·`CREDENTIAL` 등 포함, `SSH_AUTH_SOCK`·askpass)과 `GROVE_*`를 제거하고 `GROVE_SHELL=1`만 추가 | `tools::shell::tests::child_env_has_no_sensitive_vars` |
| 사용자 터미널 | 사용자가 직접 여는 터미널은 사용자 환경 그대로(`TERM`, `GROVE_TERMINAL=1`만 추가). 모델이 입력할 수 없다 | `tests/terminals.rs` |
| Git | `GIT_TERMINAL_PROMPT=0`, stdin 없음(자격증명 입력 대기 금지) | `tests/git.rs` |

### 감사 기록 (SEC-023)

`audit_log`(migration 15)는 이벤트와 달리 정리하지 않는다. 변경과 같은 transaction에서 행위자 토큰(owner·device·browser)·동작·대상·식별 정보만 남긴다: `tool_call.decided`·`tool_call.decision_blocked`·`tool_grant.revoked`·`setting.changed`(이전·새 값)·`device.created`·`device.revoked`·`secret.created|replaced|deleted`(label만). 비밀 값·토큰 원문·hash는 넣지 않고, 저장 전 `scrub`이 비밀처럼 보이는 key를 한 번 더 지운다. 조회 `GET /audit`(소유자만, seq cursor). 시험: `tests/audit.rs`, `audit::tests`.

### 도구 정책 (SEC-006, 007)

설정 `tools.mode`(ask|read_only, server·project·session), `tools.deny`(도구 이름 목록, server·project·session), `tools.allow`(server·project만). 가장 구체적인 값 하나가 아니라 **모든 범위를 합쳐** 판단한다.

1. `tools.deny`에 있으면 금지(`policy_denied`) — 읽기 도구 포함, 최우선
2. 어느 범위든 `read_only`면 Read·Conversation 외 금지(`read_only`) — allow보다 우선, 하위 범위의 `ask`로 풀 수 없음
3. `tools.allow`에 있으면 승인 없이 실행(대화 범위에서는 넓힐 수 없음)
4. 그 외 기본: 변경 도구는 승인 필요

승인 범위(SEC-009): `approve`=이번만(`approval_scope=once`), `approve_session`=이 대화에서 그 도구를 계속 허용(`session_tool_grants`, 이후 호출은 `approval_scope=session`), `tools.allow`로 건너뛴 호출은 `policy`. 대화 범위 허용은 그 대화에만 적용되고, 금지·읽기 전용이 우선하며, 위임(agent)에는 쓸 수 없다. `DELETE /sessions/{id}/tool-grants/{tool}`로 해제(멱등), 대화 삭제 시 함께 삭제. 화면은 버튼을 "이번만 승인"/"이 대화에서 계속 허용"으로 나누고 도구 결과에 범위를 표시한다. 시험: `tests/turns.rs::session_scoped_approval_is_limited_to_that_session_and_revocable`, e2e workspace 쓰기 도구 흐름.

판단은 계획 단계에서 확정된 정식 도구 이름으로 하고, 승인 시점에 다시 확인한다(대기 중 정책이 바뀌면 승인해도 실행하지 않고 409). 알 수 없는 도구 이름은 설정 저장 시 거부한다. 시험: `tests/turns.rs::tool_policy_deny_wins_and_read_only_cannot_be_loosened`, `policy_change_while_pending_blocks_approval`.

## 18. 공정 실행 (FAIR)

| 규칙 | 내용 | 시험 |
|---|---|---|
| 적용 지점 | 모델 호출 한 번 = 슬롯 하나. provider 호출 직전에 얻고 응답 직후 반환. 승인 대기·도구 실행·상태 조회·취소·승인은 큐를 거치지 않음 | `tests/fair.rs::approval_wait_does_not_hold_a_model_slot`, 포화 중 제어 요청 300ms 이내 |
| 소유자 key | 서버가 정함: API=`token:<인증 소유 주체>`(브라우저 세션은 부모 기기로 묶임), 예약=`schedule:<id>`, 자식 에이전트=부모 턴의 소유자. 클라이언트 입력 없음 | `turns.owner_key`(migration 17) |
| 접수 한도 | 설정 `runs.max_queued_per_owner`(16)·`runs.max_queued_total`(64)을 queued/running 기준으로 접수 transaction에서 검사, 넘치면 기록 없이 `429 queue_full`(retryable) | `tests/fair.rs` |
| 분배 | `runs.max_active`(4). 빈 슬롯은 실행 중 호출이 가장 적은 소유자 → 가장 오래전에 받은 소유자 → 도착 순. 혼자면 전부 사용, 선점 없음 | `fair::tests::newcomer_gets_next_slot_while_one_owner_floods`, FIFO 결함 주입 시 `tests/fair.rs` 실패 |
| 반환·취소 | Permit Drop으로 모든 경로에서 반환, 대기 중 취소는 큐에서 빠지고 모델을 부르지 않음, 배정과 취소가 겹치면 즉시 반환 | `fair::tests::cancel_storm_does_not_leak_slots` |
| 재시작 | 큐는 메모리에만. 재시작 시 queued/running 턴은 interrupted, 자동 재접수 없음 | `running_turn_interrupted_by_restart_is_not_rerun` |
| 표시 | 대기 중인 턴은 `queue{ahead, active, limit}`(다른 소유자 상세 없음), 대기 시작·끝에 `turn.updated` | `tests/fair.rs` |
| 미구현 | provider 계정별 한도(FAIR-006), 사용량 화면의 대기 표시, ARM64 실측 | — |

## 19. 실모델 시험 (opt-in, 경량 모델)

사용자 지시: 실제 모델이 필요한 시험은 가벼운 모델 위주로 한다. 과금·외부 계정 없이 로컬 OpenAI 호환 서버로 실행한다.

- 실행기: Ollama `v0.40.14`(고정)을 `.dev/ollama-v0.40.14/`에 풀고, 모델은 `.dev/ollama-models/`에 둔다. 시스템 서비스로 설치하지 않고, 필요할 때만 `127.0.0.1:11434`에서 사용자 권한으로 띄운다. Grove는 추론 엔진을 내장하지 않는다.
- 시험: `tests/real_model.rs`(#[ignore], `--ignored`로 실행), `web/e2e/real-model.spec.ts`(환경변수가 없으면 skipped로 표시). 작은 모델의 답은 흔들리므로 문장 대신 상태·도구 실행·이력 전달을 판정한다.
- 결과(2026-11-05, RTX 2060 SUPER): `qwen2.5:3b`는 대화·이력·쓰기 승인 대기·브라우저 첫 대화가 안정적으로 통과한다. `read` 도구 시험은 첫 5회가 모두 통과했지만, 이후 표본까지 합치면 **12회 중 6회 실패**(약 50%)다. 첫 결과는 표본이 작아 운이 좋았던 것으로 본다. 실패는 모델 품질 문제다: `grep`의 `pattern` 인자를 섞거나, 디렉터리·없는 파일을 지정하고, 정확한 오류를 받고도 재시도하지 않는다. `read` schema 변경(배치 `files`) 전후 A/B에서 실패율이 같아(예전 schema 4회 중 2회 실패) 제품 회귀가 아님을 확인했다. `qwen2.5:1.5b`도 같은 유형으로 실패한다. 도구 품질 비교에는 더 큰 모델이나 반복 횟수를 정한 평가(EVAL)가 필요하다.
- 실모델로 드러나 고친 계약 결함:
  1. `read.offset`만 1부터 받아 다른 도구(0부터)와 어긋났다. 이제 0도 받고 첫 줄로 처리한다.
  2. `read.limit`가 상한을 넘으면 거부했다. 이제 5000줄로 줄이고 `limit_clamped`·`next_offset`을 알린다.
  3. 선택 인자의 명시적 `null`을 형식 오류로 거부했다. 이제 생략과 같게 보고, 필수 인자의 `null`은 "필수 인자 없음"으로 알린다.
  셋 다 `tools::fs::tests::read_ranges_binary_and_errors`에 고정했다.

## 20. 서버 설치 CLI 백엔드 (claude_code·codex_cli)

사용자 지시: 기존 paseodog처럼 서버에 설치된 Codex·Claude Code를 쓰고, 시험은 저가형 모델(`gpt-6-luna`, `haiku`)로 한다.

| 규칙 | 내용 | 시험 |
|---|---|---|
| 프로필 | protocol `claude_code`(model 예: `haiku`)·`codex_cli`(예: `gpt-6-luna`), base_url·API 키 없음. CLI 인증은 CLI가 자기 설정에서 처리하고 Grove는 CLI 자격증명 파일을 읽지 않는다 | `web/e2e/cli-profile.spec.ts` |
| **권한 강제** | 사용자 CLI 설정(이 서버의 claude는 `bypassPermissions`)과 무관하게 읽기 전용. claude: `--permission-mode default --tools Read,Glob,Grep --setting-sources "" --strict-mcp-config`(사용자 hook·MCP 미사용). codex: `-c sandbox_mode="read-only" -c approval_policy="never"`. resume에도 같은 강제 | `provider::cli::tests::read_only_flags_are_always_forced`, 실시험에서 쓰기 요청 시 파일 미생성 |
| 도구 | CLI 내부 도구는 Grove `tool_calls`가 아니라 표시 전용 `cli_activity` note(거부된 도구 포함). Grove가 다시 실행하지 않음. Grove 도구 목록은 보내지 않음 | `events_map_text_usage_activity_and_session` |
| 연속성 | `cli_sessions(session_id, profile_id) → native_id`(migration 18). 세션이 있으면 resume하고 마지막 요청만 보냄, 없으면 user/assistant 텍스트를 함께 보냄. 문맥 없는 호출(제목·요약)은 고유 임시 디렉터리에서 세션을 남기지 않음(claude `--no-session-persistence`, codex `--ephemeral`) | `tests/real_cli.rs` |
| 취소·timeout | 새 process group, future drop 시 group 종료, 프로필 timeout | 실시험 취소 후 잔여 프로세스 없음 |
| 환경 | `GROVE_*`만 제거(CLI는 HOME·자기 설정이 필요). codex는 사용자 전역 지침(`~/.codex/AGENTS.md`)을 읽는다(사용자 설정이므로 유지) | — |
| DB | `model_profiles.protocol` CHECK 제거(migration 19, 표 재구성). 허용 값은 `validate_profile`. 재구성 migration은 `-- grove:rebuild` 표식으로 외래 키 검사를 transaction 밖에서 끄고, 끝나면 `foreign_key_check` 후 다시 켠다 | `store::tests::profile_table_rebuild_keeps_data_and_foreign_keys` |
| 쓰기 작업 | CLI 백엔드로 파일 변경이 필요하면 Grove 도구 루프가 있는 HTTP provider 프로필을 쓴다(승인 경로 유지). CLI 쓰기 허용은 Grove 승인과 연결하는 방법이 생길 때까지 열지 않는다 | — |

실시험(2026-11-05): `claude_code:haiku`, `codex_cli:gpt-6-luna` 각각 서버 2개(읽기·쓰기 거부·resume, 취소)와 브라우저 1개 통과.

### 공식 인증 지원 범위와 경로 결정 (DEC-010·011)

공식 문서 확인 기준: 2026-11-11. 아래는 제품 통합 경로의 기술 결정이며 약관 동의를 대신하지 않는다.

| 경로 | 공식 범위·제한 | Grove 결정 |
|---|---|---|
| Claude 구독 OAuth 직접 사용 | [Legal and compliance](https://code.claude.com/docs/en/legal-and-compliance)는 제3자 앱의 Claude.ai 로그인 제공·구독 자격증명 중계·수집·저장을 허용하지 않는다. SDK 사용 제품도 API 키 또는 지원 cloud provider 경로를 사용한다 | Grove 자체 Claude 구독 OAuth client나 CLI credential 파일 복사·추출을 구현하지 않는다 |
| 미수정 Claude Code | 같은 문서의 “Can customers offer Claude Code in their products?”는 미수정 배포 binary·사용자 자신의 인증과 직접 과금·해당 Commercial Terms 준수 조건을 명시한다. [공식 non-interactive CLI](https://code.claude.com/docs/en/headless)는 `claude -p`를 제공한다. `--bare`는 구독 OAuth를 읽지 않으므로 구독 경로에 임의로 추가하지 않는다 | 기존 `claude_code` 외부 프로세스 어댑터를 유지한다. 사용자가 공식 CLI에서 직접 로그인하고 CLI가 갱신·저장을 담당한다. 공개·다중 사용자 호스팅의 약관 적용 여부를 개인 self-hosted 사용과 동일하다고 간주하지 않는다 |
| Codex CLI | [Authentication](https://developers.openai.com/codex/auth)은 ChatGPT 구독·API 키 로그인을 제공한다. [Non-interactive mode](https://developers.openai.com/codex/noninteractive)는 `codex exec`의 기존 CLI 인증 재사용과 자동화의 API 키 기본 사용을 설명한다. 공개·비신뢰 실행 환경에 계정 credential을 노출하지 않는다 | 기존 `codex_cli` 외부 프로세스 어댑터를 유지하고 인증 파일을 가져오지 않는다. API 키 경로는 별도 사용량 과금이다 |
| OpenAI 직접 Sign in with ChatGPT | [Overview](https://developers.openai.com/siwc/token-sharing-open-source)는 open-source·locally hosted 앱을 다루며 유료·원격 호스팅 앱은 별도 문의 경로를 제시한다. [Registration and sign-in](https://developers.openai.com/siwc/token-sharing-open-source/sign-in)은 `dynamic_agent_client` 초기 등록, host별 영속 ID, 발급 client ID, PKCE·state·nonce와 서명 검증된 ID token, 별도 plan-use scope를 요구한다 | 직접 연동이 무조건 금지라고 판단하지 않는다. 다만 기존 CLI 로그인 성공을 이 별도 흐름의 구현·지원 검증으로 세지 않는다. 직접 계정 관리는 AUTH-002~009에서 해당 계약으로 구현·검증할 별도 범위다 |

비용·의존성: 현재 CLI 어댑터는 선택한 공식 CLI 프로세스만 필요하고 새 Node/Python SDK 런타임을 Grove에 추가하지 않는다. CLI 사용량은 사용자의 해당 계정·플랜 한도 및 추가 사용 정책을 따른다. HTTP API 키는 구독과 별도인 provider의 사용량 과금 경로다. 구독 사용이 무제한·무과금이라고 약속하지 않는다. 직접 OAuth·SDK 도입 전 별도 보안·지원 검증이 필요하며, 이 결정으로 실제 로그인·유료 추론 시험을 수행한 것은 아니다.

### 오류 정규화와 재시도 (MODEL-015·016)

- 분류(`provider::classify`): `auth_failed`(401·403), `rate_limited`(429), `timeout`(408·504), `provider_unavailable`(5xx), `context_too_long`(400·413·422 중 context 초과로 보이는 오류 code·본문), `model_not_found`(404, 또는 400·422 중 모델 미지원), `bad_request`, `redirect_blocked`.
- 재시도: 모델 호출 한 번 안에서, 응답 조각이 아직 하나도 나가지 않았고 재시도 가능한 오류일 때만 최대 2번. 대기는 `Retry-After`(초, 30초 넘으면 포기) 또는 0.5초·1초 지수 backoff + jitter. 대기 중 취소하면 다시 보내지 않는다. CLI 백엔드는 재시도하지 않는다.
- 시험: `provider::error_tests`, `tests/turns.rs::provider_errors_are_normalized_and_retried_only_when_safe`, `cancel_during_retry_wait_stops_retrying`.

### provider별 capability (ADAPTER-008)

통과 = 실제 시험 통과, fixture = 계약 fixture만, 미지원 = 의도적으로 막음, 미검증 = 시험 없음.

| capability | openai(HTTP) | OpenAI 호환 로컬(Ollama) | anthropic | gemini | claude_code | codex_cli |
|---|---|---|---|---|---|---|
| 인증 | 미검증(실계정 없음) | 통과(키 없음) | 미검증 | 미검증 | 통과(CLI 로그인) | 통과(CLI 로그인) |
| 텍스트 stream | fixture | 통과 | fixture | fixture | 통과(줄 단위) | 통과(item 단위) |
| 대화 이력 | fixture | 통과 | fixture | fixture | 통과(resume) | 통과(resume) |
| Grove 도구 루프(승인) | fixture | 통과(read·write 승인 대기) | fixture | fixture | 미지원(CLI 내부 도구) | 미지원(CLI 내부 도구) |
| 읽기 전용 강제 | — | — | — | — | 통과 | 통과 |
| 취소 | fixture | 미검증 | fixture | fixture | 통과 | 통과 |
| 사용량 | fixture | 통과 | fixture | fixture | 통과 | 통과 |
| 이미지 | fixture(실제 HTTP 요청) | 미검증 | fixture(요청 매핑) | fixture(요청 매핑) | 미지원(명시 오류) | 미지원(명시 오류) |
| PDF 내용 | 미지원(파일 정보만) | 미지원(파일 정보만) | 미지원(파일 정보만) | 미지원(파일 정보만) | 미지원 | 미지원 |

live 시험: `tests/real_model.rs`(OpenAI 호환), `tests/real_cli.rs`(CLI), `web/e2e/real-model.spec.ts`·`cli-profile.spec.ts`. 모두 opt-in이고, 시험이 만든 프로필은 끝날 때 지운다. 남기면 공유 시험 서버의 기본 프로필(목록 첫 항목)이 바뀌어 다른 시험이 실제 모델을 부른다(2026-11-05 실제 발생, 수정).

## 21. 실행 중 추가 메시지 (RUN-007·008, UI-021)

한 대화에는 진행 중 턴이 하나뿐이다(일반 전송은 409). 실행 중에 보낸 글은 `followups`(대화당 20개)에 넣고 종류별로 처리한다(`src/followups.rs`).

| 종류 | 반영 시점 | 실행이 completed로 끝나면 | failed·cancelled·interrupted로 끝나면 |
|---|---|---|---|
| queue | 다음 턴 | 들어온 순서로 하나를 새 턴으로 시작 | 멈춘 채 남김(사용자가 시작·삭제) |
| steer | 같은 턴의 다음 모델 호출 직전 | 반영 경계 없이 끝났으면 queue로 바꿈 | queue로 바꾸고 멈춤 |
| interrupt | 지금 턴을 취소하고 곧바로 | (해당 없음) | cancelled면 맨 앞에서 바로 시작 |

- steer 반영 경계: 그 턴의 도구 호출이 모두 종료 상태일 때만 user 메시지로 넣는다. 도구 호출과 결과 사이에 끼우면 모델 입력의 짝이 깨지므로 승인 대기·도구 실행 중이면 다음 경계로 미룬다. 반영(메시지 추가)과 항목 삭제는 같은 transaction이라 잃거나 두 번 넣지 않는다. 메시지 출처는 `source.kind = "steer"`.
- 보낼 때 실행 중 턴이 없으면(그 사이 끝남) 종류와 관계없이 바로 새 턴으로 시작한다. 입력을 대기열에 묻어 두지 않는다.
- 실패한 흐름은 자동으로 이어 가지 않는다. 자동 시작이 막히면(결과 불명 작업 검토 필요 등) 이유를 항목의 `last_error`에 남긴다.
- interrupt 재전송(같은 Idempotency-Key)은 아직 시작되지 않은 interrupt 항목이 있을 때만 취소하므로, 이미 새로 시작한 턴을 다시 취소하지 않는다.
- 다음 항목 결정(`after_turn`)은 턴 실행 루프 종료·대기/승인 대기 취소 경로에서 부르며, 현재 DB 상태만 보고 결정하므로 여러 번 불려도 결과가 같다.

## 22. 질문 도구와 사용자 대기 상태 (RUN-013·014, UI-016)

- 모델은 `ask_user`(question, options ≤8·label 고유, multi_select, allow_free_text 기본 true)로 묻는다. 인자는 계획 단계에서 검증하고 잘못된 질문은 기다리지 않고 failed로 모델에 돌려준다.
- 영속 상태: 질문 호출은 `tool_calls.status = awaiting_input`(migration 21), 승인 요청은 `pending_approval`. 턴 상태는 둘 다 '사용자 대기'(`awaiting_approval`)이고, 대화·최근·봇 목록은 질문만 기다리면 `awaiting_input`(답변 대기)으로 보인다.
  - 결정: 턴 상태 값을 늘리면 진행 중 상태 목록(10개 파일 33곳)과 `turns` 표 재생성이 필요하다. 무엇을 기다리는지는 호출 상태가 이미 영속 구분하므로 턴은 공통 사용자 대기로 두고 조회에서 구분한다.
- 답변 `POST /tool-calls/{id}/answer`: 화면에 보인 revision만, 선택지 안의 label만(단일 선택은 1개), 직접 입력은 허용된 질문만(10000자), 빈 답 거절. 답하면 succeeded(질문·선택·입력), 닫으면 cancelled(모델은 사용자가 답하지 않았음을 안다). 같은 Idempotency-Key 재전송은 같은 결과이고 턴을 두 번 재개하지 않는다.
- 질문에는 만료가 없다(사람이 답할 때까지 대기). 턴 취소·종료 시 함께 cancelled. 사람이 없는 예약 실행(`on_approval=fail`)은 질문이 나오면 `input_required`로 실패한다.
- 답을 기다리는 동안 steer는 반영하지 않는다(도구 호출과 결과 사이에 user 메시지를 끼우지 않음, §21).

## 23. 휴지통과 저장 공간 정리(DB-013·014·018·019)

- 대화는 자동 삭제하지 않는다. 기존 archive와 제목 확인 후 영구 삭제 계약을 유지한다.
- 파일 삭제는 `data_dir/trash/<id>/payload`로 이동하고 `origin.json`에 format=2, 프로젝트·원래 상대 경로·삭제 시각·상태를 기록한다. 원래 파일명이 origin.json/payload여도 충돌하지 않는다. 이전 원래 파일명 형식도 읽는다.
- 삭제·복원·영구 삭제는 인증 주체 범위의 `Idempotency-Key`가 필수다. 부작용 전에 결과 불명 receipt를 commit하고, 완료 결과·file.changed 이벤트를 한 transaction에 기록한다. 같은 키는 저장된 결과를 반환한다. 중간 종료/최종 DB 기록 실패는 결과 불명으로 남기며 자동 재실행하지 않는다.
- 복원은 같은 이름의 대상을 덮어쓰지 않는다. 다른 파일 시스템은 소유한 staging에 복사한 뒤 덮어쓰기 없는 rename으로 공개한다. Unix 폴더는 복사 중 0700으로 보호하고 완료 시 원래 권한을 적용한다. 복사·원본 제거 중 실패하면 원본과 휴지통 확인이 필요한 상태로 보존한다.
- `storage.trash_retention_days`와 `storage.task_log_retention_days`는 서버 설정(0=무기한, 1~3650일)이다. 완료·실패·취소·timeout 작업 로그만 기간 정리하고 실행 중/unknown 로그는 보존한다. DB에 없는 작업의 로그는 orphan으로 정리한다.
- GC는 10분 주기, 파일 변경과 직렬화하며 겹치면 다음 주기로 유예한다. 변경 blob은 정규 경로의 참조 없는 파일만 1시간 유예 후 삭제하며 파일 도구 실행 중에는 보존한다. 누락 blob은 변경의 stored를 해제하고 이벤트를 발행해 undo가 거부되게 한다.
- 변경 blob 저장은 현재 확보한 정상 원문을 atomic_write로 교체해 같은 hash 경로의 손상도 복구하고 유예 시각을 갱신한다. 조회는 소문자 SHA-256 key·실제 폴더/일반 파일·최대 16MiB를 확인하고, 읽기를 16MiB+1에서 멈춘 뒤 hash를 대조한다. symlink와 Unix hardlink/FIFO는 보관 성공으로 처리하지 않는다. GC는 크기 초과 blob도 stored=false로 표시한다.
- 변경 blob의 소유한 `.sha.grove-UUID.tmp` staging도 정상 prefix 폴더·정확한 이름·1시간 유예 후에만 정리한다. 첨부와 atomic_write staging 이름 판별 helper를 공유하며, 참조 blob·새 staging·잘못된 이름/경로·한글 파일명·symlink 대상은 보존한다. 저장 도구가 running인 동안은 기존 GC 유예를 유지한다.
- 한 호출은 blob 500개, 변경 500행, 로그 파일 250개+metadata 250행, 휴지통 목록 검사+하위 항목 처리 500개, 첨부 파일 250개+metadata 250행(총 최대 2500개 검사) 이내다. 열린 iterator/행 cursor로 이어간다. 큰 휴지통은 purging 상태를 먼저 기록하고 하위 항목을 나눠 삭제한다. 재시작 후 purging 항목을 재개하며 symlink 대상은 따라가지 않는다. 결과 불명 receipt에 연결된 항목은 자동 정리하지 않는다.
- 자동 영구 삭제는 payload 정리 후 `trash_gc`(migration 35)에 ID·프로젝트·상대 경로·origin hash를 먼저 commit한다. 이후 origin과 빈 항목 폴더만 제거하고 완료 이벤트와 journal 해제를 같은 transaction에서 확정한다. DB 실패·metadata 제거 직후 중단·폴더 제거 후 중단은 journal에서 재개하며 완료 이벤트는 한 번만 기록한다. 보존 기간을 0으로 바꿔도 원문 삭제가 끝난 journal은 마무리한다.
- journal 복구는 한 호출에 최대 250행을 rowid cursor로 검사하고 그 수만큼 휴지통 하위 항목 처리 예산을 줄인다. 결과 불명 receipt·바뀐 origin·새 하위 파일·symlink는 journal과 내용을 보존하며 일반 purging scan에서도 재귀 삭제하지 않는다. 사용자가 경로를 확인한 명시적 영구 삭제는 완료 receipt·이벤트·journal 해제를 한 transaction에 기록한다.
- 목록의 폴더·건너뛴 항목도 검사 예산에 포함한다. `origin.json`은 최대 256KiB만 읽고 GC 삭제 stack은 디렉터리 64단계까지만 연다. 깊이 초과 시 남은 원문과 metadata를 needs_review로 보존하고 다른 항목을 계속 처리한다. 상태 전환 뒤 이벤트 저장이 실패해도 빈 stack을 삭제 완료로 처리하지 않으며 재시작 후 자동 삭제를 재개하지 않는다. 사용자 원문은 보존 정책에 따라 유지하며, 위 한도는 자동 유지보수 한 호출의 작업량·버퍼·열린 iterator에 적용한다.
- 이벤트·완료 receipt는 각각 최대 2000행씩 정리한다. 결과 불명 receipt는 시간만으로 삭제하지 않는다. 목록에는 중단된 항목을 needs_review, 자동 정리 중인 항목을 purging으로 표시하고 복원을 비활성화한다. 네트워크 응답을 잃은 화면은 사용자가 같은 키로 결과를 확인하게 한다.
- 파일 탐색기의 저장·폴더 생성·이름 변경·복제도 인증 주체 범위의 Idempotency-Key와 부작용 전 결과 불명 접수를 사용한다. 접수 전 정상 충돌을 거부하고 실행 직전 원문·경로를 다시 확인한다. 완료 receipt와 file.changed를 한 transaction에서 확정하며, 중간 종료/최종 기록 실패는 원문·대상·결과 불명을 보존하고 같은 키로 재실행하지 않는다. 접수 전/실행 시 프로젝트 root를 대조하며 GC·휴지통·undo/redo와 같은 mutation 잠금을 쓴다.
- 이름 변경은 기존 덮어쓰기 방지 rename을 재사용한다. 복제는 대상 부모의 전용 `.grove-copy-UUID` 폴더(Unix 0700) 안에서 마친 뒤 같은 rename으로 공개한다. 생성에 성공한 자기 staging만 정리하며, 중단 staging은 결과 불명 receipt의 상대 경로로 남기고 자동 삭제하지 않는다. 화면은 본문·키를 함께 유지해 같은 요청 결과 확인·명시적 닫기를 제공하고, 미확정 동안 새 파일 작업과 편집을 잠근다.
- 파일 탐색기 복구 검증: 네 동작×5개 실패 지점(20개 경우: 접수 SQL/실제 COMMIT·완료 SQL/실제 COMMIT·이벤트), 동시 동일 키·다른 입력 충돌·키 누락·재시작·중단 복제 원문 보존을 확인했다. 접수 실패에도 파일을 쓰고 200을 반환하던 결함을 먼저 재현한 뒤 수정했다. 최신 관련 Rust 통합 48개(`api` 19·`file_changes` 2·`files` 6·`storage` 21), 복제 충돌/다른 staging 보존 단위 1개, 웹 타입/빌드, 실제 Chrome 13개(새 파일 복구 6·변경 이력/undo 4·휴지통 1·기존 파일/도구 흐름 2), Windows x64/Linux ARM64 교차 빌드와 격리 Wine의 파일 작업 4개가 통과했다. Chrome은 서버 도착 전/처리 후 실제 transport abort·최종 receipt 실패·동일 이벤트 루프 이중 저장을 확인했다. 실제 Windows/ARM64 기기 실행은 별도 미검증이다.
- undo/redo는 일반 충돌을 먼저 거부한 뒤 결과 불명 receipt를 부작용 전에 commit한다. 완료 receipt·변경 상태·이벤트는 같은 transaction에서 확정한다. 접수 SQL/실제 COMMIT 실패는 파일을 바꾸지 않으며, 접수 후 기록 실패는 결과 불명으로 보존하고 같은 키로 재실행하지 않는다. 화면은 동기 실행 guard와 같은 키 결과 확인·명시적 닫기를 제공하고 미확정 동안 새 적용을 잠근다. `tests/file_changes.rs`의 두 동작×5개 실패 지점(10개 경우)·재시작과 실제 Chrome의 전송 전/처리 후 transport abort·완료 receipt 실패·이중 클릭을 확인했다. 관련 Rust 통합 41개와 최신 storage/file_changes 23개, 웹 타입/빌드·Chrome 6개, Windows x64/Linux ARM64 교차 빌드가 통과했다. 격리 Wine에서도 일반 undo/redo와 두 동작×5개 실패 지점(실제 COMMIT 포함), 파일 도구의 네 실패 지점이 통과했다. 실제 Windows/ARM64 기기 실행은 별도 미검증이다.
- 파일 도구의 blob metadata·변경 이력·이벤트·실제 COMMIT 실패는 파일과 저장된 blob을 보존하고 도구 결과·변경 이력·blob metadata·이벤트를 함께 롤백한다. 재시작은 running을 unknown으로 바꾸고 접수 재전송/재승인으로 자동 재실행하지 않는다. 새 고아 blob은 1시간 유예하며 파일 도구 running 중에는 정리하지 않고, 이후 고아만 정리해 기존 참조 원문과 사용자 파일을 유지한다(`tests/storage.rs::failed_file_change_transaction_preserves_files_and_recovers_without_reexecution`, 네 실패 지점 통과).
- blob 복구 검증: 변경 blob 단위 3개와 관련 Rust 통합 43개(`storage` 20·`attachments` 15·`file_changes` 1·`task_logs` 7) 통과. 손상 blob 재사용의 실패를 재현한 후 정상 원문 복구를 확인했고, 상한 초과 원문의 읽기/undo 거부·중단 staging 정리·원본/metadata 보존을 확인했다. 변경 검토/undo/redo와 휴지통 Chrome E2E 3개, Windows x64·Linux ARM64 교차 빌드, 격리 Wine의 blob 2개+완료 journal 5개 통합 시험도 통과했다. 실제 Windows/ARM64 기기 실행은 별도 미검증이다.
- 완료 journal 검증: Rust 통합 72개(`api` 19·`attachments` 15·`files` 4·`projects` 5·`storage` 18·`task_logs` 7·`task_start` 4), store/storage 단위 7개, 실제 Chrome 휴지통 2개 통과. Windows x64·Linux ARM64 교차 빌드와 격리 Wine의 새 복구 시험 5개(intent/완료 DB 실패·중단 파일 상태·250행 cursor·34→35 이관)도 통과했다. symlink 보존은 Unix 시험에서 확인했고 실제 Windows/ARM64 기기는 별도 미검증이다.
- 검증: `tests/storage.rs`, `tests/files.rs`, `tests/projects.rs`, `tests/api.rs`, `web/e2e/{trash,changes}.spec.ts`. Linux 교차 파일 시스템은 실제 `/dev/shm`과 일반 임시 디렉터리 사이에서 시험한다. Linux ARM64는 교차 빌드만 확인했다. Windows x64는 교차 빌드와 Wine에서 삭제·복원·영구 삭제·동일 키 재전송·충돌 거부를 확인했다. 실제 Windows OS 검증은 PC·QA 항목에서 별도다.

## 24. 첨부 원문과 메시지 참조(DB-013·014·019)

- `POST /projects/{id}/attachments`는 `{name,data_base64}`와 `Idempotency-Key`를 받는다. 파일당 4MiB, JSON 본문 6MiB(서버 전체 요청 상한 8MiB), 파일명은 경로·제어 문자 없이 255바이트 이하다. MIME은 확장자 대신 원문으로 분류하며 HTML/SVG는 text/plain으로 취급한다.
- 원문은 `data_dir/attachments/blobs/<sha 앞 2자>/<sha>`에 atomic_write로 저장한다. DB에는 프로젝트·업로더(root 기기 ID)·이름·MIME·크기·SHA-256·저장 key·stored·시각을 둔다. 원문 중복은 같은 파일을 공유하고 업로드 항목의 ID는 별개다. migration 32는 이미지 metadata, 33은 대기열 첨부 metadata·FK 참조를 추가한다.
- 미전송 첨부의 metadata·원문은 업로더만 조회·삭제할 수 있다. 업로드 파일명은 공용 SSE 이벤트에 노출하지 않는다. 메시지나 실행 대기열에 연결한 첨부는 같은 서버의 인증된 기기에 공유한다. 원문 응답은 attachment·sandbox CSP·nosniff·no-store를 적용하며 인증을 URL에 싣지 않는다.
- 메시지 저장·턴 접수의 `attachments`는 같은 프로젝트의 ID 배열이다(최대 8개, 원문 합계 8MiB). 파일 존재·크기·SHA-256을 검증한 후 메시지·모델 입력·FK 참조·이벤트·receipt를 같은 transaction에서 기록한다. 실패하면 메시지 seq도 롤백한다. 참조가 있는 첨부 삭제는 409다. 메시지 영구 삭제는 FK 참조를 해제하며 분기 의존성은 기존 삭제 guard를 유지한다.
- 화면 content는 입력한 글과 첨부 metadata를 보존한다. 모델 입력에는 파일명·ID·크기·hash와 텍스트 최대 8192자 발췌·생략 문자 수를 저장한다. 원문은 별도로 보존하며 턴 재시도도 첨부 ID를 유지한다. 일반 바이너리/PDF는 내용 미포함을 모델·UI에 명시한다.
- PNG/JPEG/GIF/WebP는 업로드 시 실제 디코딩을 검증한다. 각 변 8192px·1600만 픽셀을 제한하고 decoder max_alloc=128MiB를 설정한다(codec의 보조 할당까지 포함한 프로세스 RSS 상한은 아니다). 모델용 이미지는 EXIF 방향 보정·최대 1024px(작으면 확대하지 않음)·흰 배경 알파 합성·첫 프레임·JPEG quality 80이다. 원문은 바꾸지 않는다. DB 모델 입력에는 ID·hash·전송 MIME·치수만 저장하고 실제 요청 직전에 원문 hash를 재검증해 메모리에서 만든다. 요청당 이미지 32개·인코딩 합계 8MiB 제한이며 누락·손상·상한 초과는 조용히 생략하지 않고 오류로 끝낸다. context 추정은 이미지당 4096 token의 보수적 추정값이며 실측과 구분한다.
- OpenAI Chat의 image_url data URL, Anthropic의 base64 image source, Gemini의 inlineData로 보낸다. 공식 표현은 [OpenAI Chat](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create), [Anthropic Vision](https://platform.claude.com/docs/en/build-with-claude/vision), [Gemini image](https://ai.google.dev/gemini-api/docs/image-understanding)를 따른다. CLI 프로필은 이미지 지원 전까지 명시 오류로 거절하며, HTTP 어댑터도 실제 외부 모델의 시각 이해 품질을 검증한 것으로 취급하지 않는다.
- followup은 queue/steer/interrupt 모두 첨부를 받는다. 대기열 FK 참조는 GC·명시 삭제에서 보존하고, 메시지 생성·참조 이전·대기열 삭제는 같은 transaction/savepoint다. 원문 누락·시작 실패는 큐와 참조를 유지하고 last_error로 알린다. 손상된 steer도 메시지 없이 오류가 있는 queue로 남겨 재업로드/수동 재개가 가능하다.
- Composer는 파일 선택·드롭·붙여넣기, 파일별 업로드 중/실패/동일 키 재시도, 선택 제거, 원문 미리보기·다운로드를 제공한다. 업로드 미완료 시 전송을 막고 응답을 잃은 전송도 같은 내용·첨부·옵션이면 같은 키로 재확인한다. 완료한 첨부 ID·표시 metadata만 기기 내 초안에 보존하며 원문/인증은 localStorage에 넣지 않는다. 서버 초안은 글만 공유한다. 미리보기는 인증된 rawGet 후 허용된 이미지/텍스트만 표시하고 Blob URL은 닫기·교체·unmount에서 해제한다. 미참조 선택 제거는 서버 원문을 즉시 지우지 않고 기존 24시간 유예 정리를 따른다.
- 고아 원문·정확한 `.sha.grove-UUID.tmp` staging만 1시간 후 정리하며 알 수 없는 이름·symlink 대상은 건드리지 않는다. 미참조 metadata는 24시간 후 만료하고 참조가 있으면 기간과 무관하게 보존한다. 파일 누락·크기 불일치는 stored=false와 이벤트로 알리고, 동일 hash 원문 재업로드는 기존 metadata의 stored도 복구한다. 원문 읽기는 크기 제한과 hash를 재검증한다.
- GC는 업로드·휴지통 변경과 직렬화한다. 첨부 파일 250개와 metadata 250행만 검사해 다음 호출로 이어가며, 재시작 후 디스크·DB 상태에서 다시 시작한다. 원문 생성 후 DB 실패로 남은 파일과 메시지 참조 삽입 중 실패를 격리 테스트에서 주입한다(`tests/attachments.rs`).
- 현재 CLI snapshot은 SQLite만 포함하며 첨부 원문을 복사하지 않는다. 첨부 bundle 백업·복원은 BOT-015-E/TRANSFER-003의 미완료 범위다.
- 검증: 첨부 HTTP/복구 15개, 이미지 포함 압축 후 원문/참조 보존, JPEG 방향·GIF 첫 프레임·WebP 단위 2개, 관련 턴 33·컨텍스트 7·followup 5·제목 2와 기존 lib 86개, 웹 타입/빌드·Vitest 28개, 데스크톱 첨부 E2E 3개·모바일 첨부 E2E 1개 통과. 응답 유실은 실제 서버 처리 후 transport abort로 재현한다. Windows x64/ARM64 Linux 교차 빌드를 확인했다. 이전 Wine에서 4MiB·중복 원문·참조 보호를 검증했고 이미지 변경본도 격리 Wine에서 PNG 디코딩·작은 이미지 확대 방지·이미지 단독 메시지·모델 입력 ID/치수·원문 바이트 보존을 확인했다. 실제 Windows/Android 기기·ARM64 실행 및 외부 유료 모델 이미지 이해는 미검증이다.

## 25. 작업 로그 metadata와 보관 실패(DB-013·014·019)

- migration 34의 `task_logs(task_id, stream)`는 `tasks`를 FK로 참조한다. 프로젝트·세션 소유권은 작업 관계에서 얻고 stream별 참조 수는 1이다. 상대 `storage_key`·저장 크기·SHA-256·`writing/ready/error/missing/expired` 상태·오류 코드·검사 시각을 저장한다. 중복 상태 boolean은 두지 않는다.
- 작업/로그 metadata를 먼저 commit하고 원문 파일 두 개를 확보한 뒤 프로세스를 시작한다. 생성 실패는 실행하지 않은 failed 작업과 보관 오류 note로 확정한다. Unix는 디렉터리 0700·파일 0600, `create_new`로 기존 파일을 덮어쓰지 않는다. 파일 준비·요약·조회는 blocking 실행 경로다.
- 각 stream은 8MiB까지 저장하고 초과분도 pipe에서 계속 비워 전체 출력 바이트를 센다. 저장한 prefix의 hash만 기록한다. read/write/flush/sync 실패는 metadata와 결과 note에 따로 남기며 실행 exit code와 혼동하지 않는다. pump timeout은 handle을 취소하고 보관 실패로 남긴다.
- 작업 종료 상태·로그 metadata·결과 note·이벤트를 같은 transaction에 기록한다. 최종 commit 실패 시 원문을 지우지 않으며 기존 running/writing 기록을 보존한다. 재시작은 작업을 unknown으로 바꾸고 자동 재실행하지 않는다. 이전 schema/중단 로그의 첫 검사에서는 현재 바이트의 크기·hash를 채우며 작업 unknown 상태는 유지한다.
- `/tasks/{id}/output`은 완료 원문의 크기·hash를 확인하고 조각을 반환한다. 누락·손상·보관 실패·만료는 `410 task_log_unavailable`과 상태/원인을 반환한다. 손상 원문과 기존 fingerprint는 보존한다. 요약 tail은 최대 4KiB이며 symlink/비정규 파일을 읽지 않는다. 화면은 조회 오류를 빈 출력과 구분하고 스트림 변경 시 이전 응답이 새 선택을 덮어쓰지 않게 한다.
- GC는 파일 250개와 metadata 250행 이내로 이어가며 이전/중단 원문 hash 계산은 호출당 최대 32MiB다. ready 로그의 주기 검사는 누락·종류·크기를 확인하고, 동일 크기 손상은 출력 조회의 hash 검증에서 확인한다. 실행 중/unknown 작업은 보존 기간 삭제 대상이 아니다. 만료해도 metadata·hash는 남긴다. 서버 파일 로그의 회전·상한은 §26을 따른다.
- 검증: `tests/task_logs.rs` 7개(생성 실패·fingerprint/동일 크기 손상·누락/만료·최종 commit 실패/재시작·schema 33→34·hash 예산/cursor·symlink), pump 단위 2개(`/dev/full` 쓰기 실패 후 drain, 8MiB prefix hash), 관련 tasks 8·task_wait 3·storage 12·api 19·store 단위 3개 통과. 웹 타입/빌드와 새 로그 오류/기존 작업 시작·취소 Chrome E2E 2개 통과. Windows x64·Linux ARM64 교차 빌드, 격리 Wine에서 cmd 실행·SHA-256 metadata/출력 조회·손상 거부를 확인했다. 실제 Windows·ARM64 실행은 별도 미검증이다.
- 직접 사용자 작업 시작은 결과 불명 receipt·작업 ID·로그 metadata·task.changed를 한 transaction에 먼저 commit한 뒤 프로세스를 시작한다. 동일 키 경합은 저장된 작업 ID만 돌려주고 실행하지 않는다. 완료 receipt 저장 실패는 작업 ID가 있는 `409 result_unknown`을 유지하며, 정리·재시작·재전송에서도 실행하지 않는다. 접수 commit 후 실행 전 중단은 재시작 시 unknown으로 복구한다. 접수 transaction에서 사전 검증한 프로젝트 root를 대조하며 바뀌었으면 `409 project_changed`로 작업·로그·이벤트 생성 전에 거부한다. 접수 후에는 기존 프로젝트 실행 guard가 root 변경을 막는다. 이 경계는 `tasks::tests::acceptance_rejects_a_changed_project_root_without_records`에서 거부/정상 기록을 확인했다.
- TasksPanel은 접수 중 동기 guard로 이중 submit을 막고 명령 편집을 잠근다. 네트워크/서버 오류·result_unknown은 같은 명령/키를 유지해 사용자가 결과를 확인한다. 결과 불명을 닫고 다른 명령을 입력할 때는 입력을 비우며 기존 작업을 취소하지 않는다. 세션 전환은 패널 상태를 분리한다.
- 접수 검증: `tests/task_start.rs` 4개와 관련 tasks·task_wait·task_logs·storage·api를 합친 Rust 통합 53개, 실제 Chrome에서 서버 도착 전/처리 후 응답 유실·동일 이벤트 루프 이중 submit·최종 receipt UPDATE 실패 3개와 기존 로그 조회/작업 시작·취소 2개, 웹 타입/빌드 통과. 기존 화면의 이중 submit 결함을 실패로 재현한 후 같은 시나리오의 통과를 확인했다(EXEC-005). Windows x64·Linux ARM64 교차 빌드와 격리 Wine의 cmd 작업·같은 ID 재전송·최종 receipt 실패/결과 불명·원문 파일 1회 쓰기도 확인했다. 실제 Windows OS 실행은 별도 미검증이다.

## 26. 서버 파일 로그와 유지보수 자원(DB-019)

- `grove serve --log-file <path>`는 현재 파일과 `.1`~`.3` 보관본을 각 2MiB 이내로 유지한다(합계 최대 8MiB). `tracing`의 기본 formatter를 사용하되 내부 문자열 버퍼에 적재하기 전에 이벤트를 16KiB 이내로 제한한다. 초과 표식을 남기고 UTF-8 경계를 보존한다. 파일에는 ANSI escape를 쓰지 않으며 시작·종료·시작 실패를 기록한다.
- 일반 파일만 사용하고 Unix는 symlink·hardlink·특수 파일을 거부한다. 신규 로그 폴더는 0700, 생성·append 파일은 0600이다. `.lock` 파일의 OS 잠금을 서버 수명 동안 유지하며 이벤트 전체를 직렬화한다. 회전 전에 handle을 닫아 Windows에서도 같은 경로를 교체한다. 위험한 보관 경로는 파일 이동 전에 모두 검사한다.
- 이전 대용량 로그는 각 파일의 끝부분만 최대 2MiB 복사한다. `.grove-tail.tmp` 고정 slot에 `[grove-log-tail:v1]` header와 tail을 쓰고 sync 후 교체한다. 생성부터 0600이며 각 staging도 최대 2MiB다. 중단 파일은 일반 파일·header·크기와 Unix 소유자/권한을 확인한 후에만 재사용한다. 대용량 정리 중 다른 내용·종류·권한의 staging을 발견하면 보존하고 시작을 거부한다. 각 로그 slot에 staging 하나만 두어 반복 중단 시 새 임시 파일이 계속 늘지 않게 한다. 복사·교체 실패 시 기존 로그 원문을 유지한다.
- 새 관리 CLI의 `process` 시작은 기존 `version --json`의 `features: ["file_log_rotation_v1"]`를 확인해 `--log-file`을 전달한다. 시작 전에 파일 준비 오류를 보고하고, 이미 응답하는 서버가 있으면 PID·로그를 바꾸지 않는다. 기능 표식이 없는 이전 release는 기존 stdout/stderr append 방식으로 실행한다. 옵션 없는 foreground와 systemd는 stderr를 유지한다. 기존 CLI로 기동한 서버는 새 관리 CLI로 정상 재시작해야 파일 회전이 적용된다.
- 자원 회귀: 파일 정리 관련 Rust 통합 72개(`api` 19·`attachments` 15·`cli` 6·`files` 4·`logging` 3·`projects` 5·`storage` 13·`task_logs` 7), logging 7·storage 4·update 4 단위 시험과 Chrome 휴지통 2개 통과. 큰 metadata와 깊은 stack은 실패를 재현한 뒤 수정했고, 빈 폴더를 포함한 scan 예산·cursor도 확인했다. Windows x64·Linux ARM64 교차 빌드, 격리 Wine의 1GiB tail 정규화·중단 staging·writer 잠금·5회 시작/종료·보관본 교체·8MiB 상한·다른 staging 보존을 확인했다. 실제 Windows/ARM64 실행과 프로세스 전체 RSS 상한은 이 검증의 범위 밖이다.
- `scripts/test_update.py`는 격리한 실제 A/B/C/D 실행 파일로 새 설치·이전 append 로그에서 새 회전 로그로 전환·변경 없음·활성 작업 유예·고장 버전 snapshot 복구·중복 시작/PID 보존을 검증한다. 임시 소스 경로가 달라도 고정 target/build-dir의 의존성 cache를 사용하고 offline 빌드한다. 운영 서비스·데이터를 사용하지 않는다.

## 11. 결정 기록

| ID | 결정 | 근거 |
|---|---|---|
| DEC-008 | 웹: React 19 + React Router 7 framework 모드(`ssr:false`) + Vite. 공용 UI·분할 pane 상태(`web/app/state/layout.ts`, 서버 검증 `workspace.rs`)·PWA(정적 산출물 + service worker) 경계로 확정 | 정적 SPA 빌드·CSP 해시·SW 등록·분할 복원 e2e(`web/e2e/workspace.spec.ts`), 모바일 단일 pane e2e |
| DEC-009 | 서버: Axum 0.8 + Tokio + tower-http(limit·fs·set-header). SQLite는 rusqlite(`bundled`, 쓰기 연결 1개 직렬화), 타입 생성은 ts-rs | 단일 정적 실행 파일, Windows/ARM64는 bundled SQLite로 시스템 의존 없음. 동시성은 DB 단일 연결 + blocking 스레드로 단순화(시험: 동시 커밋 직렬화, idempotency 경쟁) |
| DEC-014 | 구 wire 비호환·일괄 전환, 새 제품 내부 호환은 §10 | `tests/api.rs::protocol_mismatch_blocks_mutations_but_not_reads`, e2e protocol 배너 |

## 9. Deviation log

| ID | 날짜 | 이탈 | 승인 |
|---|---|---|---|
| DEV-001 | 2026-11-05 | 각 단계 끝의 사용자 sign-off gate에서 멈추지 않고 다음 단계로 진행. 단계 산출물은 디스크에 남겨 사후 검토 가능 | 사용자 지시("모든 todolist가 완료될 때까지 멈춤없이 진행") |
| DEV-002 | 2026-11-05 | 단위별 독립 적대적 reviewer 서브에이전트 2개 대신 같은 세션의 별도 검토 패스 + 자동 시험으로 대체 | Solo 오케스트레이션 모드(위임은 사용자 명시 요청 시에만) |
| DEV-003 | 2026-11-05 | `templates/settings.json` deny 설치 생략. fan-out 루프가 없고, 컴파일러가 저렴해 루프 안에서 실행(Step 4 흡수) | 키트 README Step 4 흡수 규칙 + DEV-002 |
| DEV-004 | 2026-11-05 | 재설계 이전이므로 bakeoff 대신 설계 문서 적대적 검토(키트 README "If you're redesigning") | 키트 규칙 |
| DEV-006 | 2026-11-05 | RULEBOOK 수정안을 사람 승인 대기열에 올리지 않고, 기능 묶음 사이(구현·시험 완료 후)에 §15~§17로 직접 추가. 기존 규칙을 완화하지 않고 새 정책만 추가했으며 각 항목에 고정 시험을 명시. 사후 검토 필요 | DEV-001(gate에서 멈추지 않음) 연장. 키트 상시 규칙 1과 다름 |
| DEV-005 | 2026-11-05 | judge를 구·신 공통 외부 인터페이스로 만들 수 없음(구 wire 비호환, DEC-014). 원본 동작에서 도출한 FLOW 시나리오 판정기를 신규 제품에 실행하고, 의도적 결함 주입으로 판정기를 검증 | 키트 README Step 6 재설계 규칙 |
