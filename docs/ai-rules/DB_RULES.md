# 영속성과 migration

DB schema의 정본은 `src/store.rs`의 `MIGRATIONS`다.
`migration/`은 설계·이전 문서 디렉터리이며 실행 SQL migration 디렉터리가 아니다.

- **MUST** 배포된 migration은 보존하고 새 항목을 끝에 추가한다.
  - why: 기존 설치와 신규 설치가 같은 schema에 도달해야 한다.
  - ✅ `MIGRATIONS` 순차 실행과 `PRAGMA user_version` 갱신. `evidence: src/store.rs`.
- **MUST** 상태·idempotency 결과·outbox 이벤트를 같은 transaction에서 commit한 뒤 성공을 응답한다.
  - why: 성공 응답만 있고 상태가 없거나 이벤트만 존재하는 반쪽 접수를 막는다.
  - ✅ `idem::run_redacted`의 mutation·이벤트·응답 저장 후 `tx.commit()`. `evidence: src/idem.rs`.
- **MUST** 이벤트 구독자 알림은 commit 이후에 수행한다.
  - why: 구독자가 아직 읽을 수 없는 이벤트를 받았다고 오해하지 않게 한다.
  - ✅ `App::notify_events`는 DB의 최신 seq를 읽는다. `evidence: src/lib.rs:190`.
- **MUST** 외부 부작용은 transaction으로 되돌릴 수 있다고 가정하지 않고 결과 유실은 결과 불명으로 남긴다.
  - why: 완료 기록이 없다고 셸·파일 작업을 재실행하면 중복 부작용이 생긴다.
  - ✅ 복구는 실행 중 도구를 `unknown`으로 남기고 자동 재실행하지 않는다. `evidence: src/runner.rs:365`.
- **MUST** 테이블 재구성은 기존 행·외래 키·등록 기기의 자격 보존을 검사한다.
  - why: schema가 열리는 것만으로 데이터가 보존됐다고 판단할 수 없다.
  - ✅ migration의 무결성 검사 및 기기 보존 시험. `evidence: src/store.rs`, `evidence: tests/integration/pairing.rs`.

DB 검사는 `tests/integration/common/mod.rs`처럼 소유권이 분명한 임시 데이터 디렉터리에서 수행한다.
실사용·공유 DB를 테스트 fixture로 reset하지 않는다.
업데이트의 DB 복구 조건은 [DEPLOY.md](DEPLOY.md)를 따른다.
