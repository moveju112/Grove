# API와 인증

- **MUST** 새 API는 기존 Origin·protocol·기능 협상 middleware를 통과시킨다.
  - why: 다른 전송 경로가 공통 보안 경계를 우회하지 않아야 한다.
  - ✅ `router`의 공통 layer와 `CAPABILITIES` 등록. `evidence: src/lib.rs:209`, `evidence: src/web.rs`.
- **MUST** 일반 인증 API에는 `Principal`, 소유자 관리에는 `Owner`를 적용한다. 공개 인증 진입점은 별도의 Origin·자격 검증을 유지한다.
  - why: 소유자·등록 기기·승인 전 브라우저는 서로 다른 권한이다.
  - ✅ CLI 계정 관리의 `Owner`와 페어링의 `auth::check_origin`. `evidence: src/agent_auth.rs:131`, `evidence: src/pairing.rs`.
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

- **MUST** 링크·비밀번호 확인은 등록 요청만 만들고, 확인 코드를 대조한 소유자 승인 뒤 기기 한 대에만 세션을 발급한다.
  - why: 같은 링크·비밀번호를 가진 다른 브라우저가 승인된 요청의 자격을 가져가면 안 된다.
  - ✅ 요청별 비밀, 단일 승인, 다른 요청 거절, 일회용 claim. `evidence: src/pairing.rs`, `evidence: tests/pairing.rs`.
- **MUST** 링크별 누적 5회 실패 잠금을 영속화하고 재시작·정답 입력으로 초기화하지 않는다.
  - why: 재시작이나 성공 요청을 끼워 넣어 시도 제한을 우회할 수 없어야 한다.
  - ✅ `failed_attempts`·`locked_at` 저장과 재발급 경로. `evidence: src/pairing.rs`, `evidence: tests/pairing.rs`.
- **MUST** CLI 로그인 비밀과 원문 출력을 DB·이벤트·로그에 복제하지 않는다.
  - why: 외부 CLI가 보관하는 자격의 사본과 비밀 유출 경로를 만들지 않는다.
  - ✅ 공식 challenge만 노출하고 종료 시 URL·코드를 제거한다. `evidence: src/agent_auth.rs:230`, `evidence: src/agent_auth.rs:321`.

응답은 [RESPONSE_KEYS.md](RESPONSE_KEYS.md), commit 경계는 [DB_RULES.md](DB_RULES.md)를 따른다.
