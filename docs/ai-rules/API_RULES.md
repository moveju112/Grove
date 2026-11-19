# API와 인증

- **MUST** 새 API는 기존 Origin·protocol·기능 협상 middleware를 통과시킨다.
  - why: 다른 전송 경로가 공통 보안 경계를 우회하지 않아야 한다.
  - ✅ `router`의 공통 layer와 `CAPABILITIES` 등록. `evidence: src/lib.rs:209`, `evidence: src/web.rs`.
- **MUST** 모든 등록 기기는 같은 관리 권한을 가지며, 인증 API는 `Principal`을 사용한다. 브라우저 로그인은 페어링만 지원하고, 서버 계정의 로컬 관리 자격은 브라우저·원격 암호화 연결에 전달하지 않는다.
  - ✅ 첫 기기는 서버 터미널의 `grove pairing create`로 등록한다. 페어링의 `auth::check_origin`과 쿠키·접근 자격 검사를 유지한다. `evidence: src/auth.rs`, `evidence: src/cli_pairing.rs`, `evidence: src/pairing.rs`.
- **MUST** 인증된 영속 mutation은 기존 idempotency 경로로 처리하고 자원별 revision 계약을 적용한다.
  - why: 재전송으로 중복 부작용이 생기거나 동시 수정이 유실되면 안 된다.
  - ✅ `idem::run`·`run_redacted`와 설정의 `expected_revision`. `evidence: src/idem.rs`, `evidence: src/settings.rs:874`.
- **MUST** 일회성 비밀은 저장된 재전송 응답·목록·감사·이벤트에서 원문을 제외한다.
  - why: idempotency 저장소가 장기 비밀 저장소가 되어서는 안 된다.
  - ✅ 발급의 `run_redacted(..., &["code"], ...)`. `evidence: src/pairing.rs`.
- **MUST** 서버 pin·전송 실패를 다른 서버나 평문 전송으로 자동 대체하지 않는다.
  - why: 연결 복구가 다른 신뢰 경계로 자격을 보내는 동작이 되어서는 안 된다.
  - ✅ `validateConnection`, pin 검증, 인증 세대 검사. `evidence: web/app/api/transport.ts`, `evidence: web/app/api/client.ts`.

## 페어링과 CLI 계정

- **MUST** 링크·비밀번호 확인은 등록 요청만 만들고, 등록 기기나 서버 터미널에서 확인 코드를 대조해 승인하면 기기 한 대만 등록한다.
  - why: 같은 링크·비밀번호를 가진 다른 브라우저가 승인된 요청의 자격을 가져가면 안 된다.
  - ✅ 요청별 비밀, 단일 승인, 다른 요청 거절, 일회용 claim. `evidence: src/pairing.rs`, `evidence: tests/pairing.rs`.
- **MUST** 링크 발급·재발급은 인증된 기기 또는 로컬 CLI라도 서버 발급 비밀번호를 매번 확인한다. 미설정 상태는 발급을 차단한다. 새 기기에는 별도 링크 비밀번호만 전달한다.
  - ✅ 서버 터미널에서 `grove pairing set-password` 실행 후 데몬을 재시작한다. 기본과 다른 데이터 디렉터리를 쓰면 동일한 `--data-dir`을 지정한다. 서버에는 salt를 둔 PBKDF2 검증값만 저장하고 발급 암호는 API 응답·감사·이벤트·요청 재전송 기록에 남기지 않는다. `evidence: src/pairing/issuance.rs`, `evidence: src/pairing.rs`, `evidence: tests/pairing.rs`.
  - 발급 단계의 보호다. 기존 링크와 기기에는 소급 적용되지 않는다. 서버 OS 계정 권한(같은 권한으로 셸을 실행하는 기기 포함)은 별도 신뢰 경계다.
- **MUST** 링크별 누적 5회 실패 잠금을 영속화하고 재시작·정답 입력으로 초기화하지 않는다.
  - why: 재시작이나 성공 요청을 끼워 넣어 시도 제한을 우회할 수 없어야 한다.
  - ✅ `failed_attempts`·`locked_at` 저장과 재발급 경로. `evidence: src/pairing.rs`, `evidence: tests/pairing.rs`.
- **MUST** CLI 로그인 비밀과 원문 출력을 DB·이벤트·로그에 복제하지 않는다.
  - why: 외부 CLI가 보관하는 자격의 사본과 비밀 유출 경로를 만들지 않는다.
  - ✅ 공식 challenge만 노출하고 종료 시 URL·코드를 제거한다. `evidence: src/agent_auth.rs:230`, `evidence: src/agent_auth.rs:321`.

응답은 [RESPONSE_KEYS.md](RESPONSE_KEYS.md), commit 경계는 [DB_RULES.md](DB_RULES.md)를 따른다.
