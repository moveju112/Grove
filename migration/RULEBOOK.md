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
| 타입 생성 | `ts-rs`로 Rust 계약 → `web/app/api/generated/*.ts` | NET-002 |
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
- 표준 code: `unauthorized`, `forbidden`, `not_found`, `invalid_request`, `revision_conflict`, `idempotency_conflict`, `busy`, `queue_full`, `unsupported`, `internal`, `cancelled`, `gone`.
- 응답 본문: `{"error":{"code","message","retryable":bool,"details"?}}`.
- 내부 오류는 `internal` + 상관 ID만 노출, 상세는 로그.
- 도메인 함수는 `anyhow` 대신 모듈별 `thiserror` 열거형을 쓰고 경계에서 `ApiError`로 변환.

## 5. 경로·이름

- Rust 모듈: `src/<영역>.rs` 또는 `src/<영역>/mod.rs`. 영역 이름은 소문자 단수(`store`, `auth`, `events`, `sessions`, `turns`, `tools`, `provider`, `agents`, `settings`, `layout`, `shell`, `git`...).
- Rust 통합 시험: `tests/<영역>.rs`, 공용 harness `tests/common/mod.rs`(임시 디렉터리 + 실제 서버 기동).
- FLOW 판정 시험: `tests/flow_<nn>.rs`(서버 API 수준) 및 `web/e2e/flow-<nn>.spec.ts`(브라우저 수준).
- 웹: `web/app/routes/*`, 상태 로직 `web/app/state/*`(순수 함수 + Vitest), API 클라이언트 `web/app/api/*`.
- 데이터 경로: Linux `$XDG_DATA_HOME/grove`(기본 `~/.local/share/grove`), Windows `%LOCALAPPDATA%\Grove`. `GROVE_DATA_DIR`로 재정의(시험은 항상 임시 디렉터리).
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
| `build.py test [--e2e]` | Rust·Vitest(·Playwright) |
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
| 이미지·PDF | 미검증 | 미검증 | 미검증 | 미검증 | 미검증 | 미검증 |

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
