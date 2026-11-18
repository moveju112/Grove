# 응답과 생성 계약

- **MUST** 오류는 `ApiError`의 표준 envelope를 사용하고 내부 상세는 상관 ID로 분리한다.
  - why: 웹·CLI·암호화 전송에서 같은 오류 분류와 복구 동작을 사용할 수 있어야 한다.
  - ✅ `{"error":{"code":"revision_conflict","message":"...","retryable":false,"details":{}}}`. `evidence: src/error.rs`.
- **MUST** optional 필드와 명시적인 `null`을 구분하고 같은 protocol의 추가 필드는 허용한다.
  - why: 필수 데이터 누락은 검출하면서 호환 가능한 확장은 막지 않는다.
  - ✅ `parseContract`의 object·union·ref 검사와 응답 값을 포함하지 않는 `ContractError`. `evidence: web/app/api/validation.ts`.
- **MUST** Rust 계약과 생성 TypeScript·runtime 검증 metadata를 함께 갱신한다.
  - why: 선언만 바꾸면 실행 시 검증기가 다른 계약을 검사한다.
  - ✅ `tests/ts_bindings.rs`가 두 산출물을 함께 생성·대조한다. `evidence: tests/ts_bindings.rs`.

## 갱신 경로

1. Rust 응답 타입을 변경하고 필요한 타입을 `tests/ts_bindings.rs`의 생성 목록에 등록한다.
2. `GROVE_UPDATE_BINDINGS=1 python3 scripts/build.py test --rust ts_bindings`로 두 산출물을 갱신한다.
3. 갱신 환경변수 없이 drift 검사와 영향받는 웹 타입·계약 검사를 수행한다.

계약 JSON 숫자는 안전한 정수 범위라는 생성기의 전제를 유지한다.
시간은 UTC RFC3339 문자열로 반환한다. `evidence: tests/ts_bindings.rs:9`, `evidence: src/util.rs`.
역할 모델 설정의 `kind: "model"`은 기존 프로필 ID 문자열·빈 문자열과 `ModelSelection` 객체(`profile_id`, `model`)를 받는다.
연결과 실제 모델은 같은 revision·transaction으로 저장하고, 실제 모델 지정은 공유 프로필을 변경하지 않는다.
