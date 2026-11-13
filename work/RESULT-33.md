# 33 — 명시적 첫 응답 전 HTTP fallback

## 식별·상태

- 배치/번호: b02 / 33.
- Worktree: `/home/ubuntu/.local/share/paseodog/paseo/worktrees/0q796rug/b02-33-model-fallback`.
- Branch: `parallel/b02-model-fallback`.
- 기준: `9942629c17891c5cad8cc5a7a62fee99e0379650` (현재 HEAD의 merge-base 확인).
- 상태: 구현 종료, 선택 서버·웹 단위 검증 통과. 브라우저 E2E는 작성·타입 검사만 했으며 COMMON에 따라 통합 단계 실행 대기다. 브라우저 사용자 흐름의 완료를 확정하지 않는다.
- ENTRY/README의 실제 worktree·branch 배정과 33번 문서가 일치했고 시작 Git 상태는 깨끗했다.

## 제공 동작·설정 계약

기본은 꺼짐이다. 기존 Owner 전용 `POST /api/v1/model-profiles`, `PUT /api/v1/model-profiles/:id`의 options에 다음을 저장한다. 기존 revision·idempotency·오류 응답·권한 계약을 그대로 사용한다.

```json
{
  "fallback": {
    "enabled": true,
    "destination_change_confirmed": true,
    "candidates": [
      { "profile_id": "existing-http-profile-id", "revision": 1 }
    ]
  }
}
```

- 명시적 순서 최대 4개다. 중복·자기 자신·누락·삭제·비활성·CLI·stale revision·알 수 없는 필드를 거절한다. 후보의 자체 fallback은 따라가지 않는다.
- UI는 후보의 protocol·endpoint·model·가격표를 보여 주고 전송 대상 변경 checkbox 확인 전 저장을 막는다. 순서 변경 시 확인을 해제한다. 후보 제거·추가로 순서를 구성하며 모두 제거하면 끈다.
- UI 편집 시작 시 source와 후보 목록의 revision을 고정한다. source 충돌이나 후보 변경 시 입력을 보존하고 오류를 표시한다. 최신 값을 자동 인수하거나 덮어쓰지 않는다.
- CLI는 UI와 API 모두 미지원이다. 실제 CLI·계정·외부 서비스는 호출하지 않았다.
- 접수 transaction에서 원래 선택, 실제 선택, 유한 후보의 ID·revision·이름·protocol·endpoint·model·secret 참조·가격표 및 첫 시도 기록을 `definition_snapshot.fallback`에 저장한다. secret 원문이나 provider 오류 본문은 fallback 기록에 넣지 않는다.
- 후보 사용 전 현재 존재·enabled·revision과 runtime credential 해독을 검사한다. 보수적으로 표시 이름 등 revision 변경도 재확인을 요구한다. 접수 후보를 최신 대상으로 조용히 교체하지 않는다.
- 동일 모델의 retry는 기존 `provider::stream`만 사용한다. 반환된 명시적 `rate_limited` HTTP 429 또는 `provider_unavailable` HTTP 5xx이며 step 0, 수신 text/reasoning/tool/activity 없음, 취소 없음인 경우에만 다음 후보로 진행한다. HTTP 504는 기존 `timeout` 분류라 제외된다.
- 취소·인증·입력·capability 오류, timeout·transport/stream 오류, 부분 응답, 성공 단계 및 도구 계획 이후에는 전환하지 않는다. DB에서도 step 0 및 tool_calls 부재를 확인한다.
- 전환 transaction은 `turns.profile_id`와 `definition.fallback.actual_profile_id`, 실패/선택 시도 기록, 비용 예산의 실제 후보 가격표, 별도 `model_fallback` 화면 note를 함께 갱신한다. 현재 실제 profile_id에 기존 active-use 프로필/secret 보호와 usage 집계가 적용된다.
- 실패한 provider의 개별 내부 retry 횟수·본문은 새로 수집하지 않는다. attempts는 provider별 선택 및 최종 오류의 기록이고, 현재 시도의 성공/중단 상태는 기존 turn status·step·usage로 확인한다.
- 다른 통화를 합치지 않는다. 원래/후보 가격표의 통화가 다르거나 비용 예산 아래 후보 가격표가 없으면 접수를 거절한다. 가격표는 접수 snapshot에 보존하고 비용 예산은 실제 선택 가격으로 평가한다.
- 기존 usage API의 프로필별 귀속은 실제 profile_id를 사용한다. 기존 usage 화면의 비용 집계는 원래 계약대로 현재 프로필 가격표 기준 추정이며, 과거 가격 snapshot 기준 집계로 바꾸지는 않았다.
- 후보마다 기존 capability 검사와 생성 옵션을 적용한다. fallback 요청은 기존 context usage 및 system/tool 추정량으로 입력 용량·출력 여유도 확인한다. 시간·token·비용 예산, FAIR, 취소 경계를 다시 거친다.
- provider의 기존 native 서명 필터를 그대로 사용한다. DB 복구를 변경하지 않았으며 재시작 시 interrupted/unknown의 자동 재호출 금지를 유지한다.

## 소유 변경·연결

| 경로 | 변경 |
|---|---|
| `src/model_fallback.rs` | 옵션/참조 검증, acceptance snapshot, 현재 후보 검증, 허용 오류 판정, 원자적 전환/기록, 모듈 단위 시험 |
| `src/models.rs` | fallback 옵션 및 현재 후보 참조 검증 분기만 |
| `src/lib.rs` | `pub mod model_fallback` 등록만 |
| `src/runner.rs` | 접수 snapshot, load_step의 후보/capability/input 검사, provider 오류 시 기록/전환 및 fragment 관찰만 |
| `tests/model_fallback.rs` | 격리 DB·로컬 HTTP fixture 통합 시험 13개 |
| `web/app/components/ProfileFallback.tsx` | 명시 순서/전송 확인 설정 UI |
| `web/app/components/ProfileFallback.test.ts` | 설정 payload·검증·기본 꺼짐·CLI 표시 단위 시험 3개 |
| `web/app/components/Settings.tsx` | Profiles의 import/프로필별 mount만 |
| `web/app/components/SessionView.tsx` | 별도 `model_fallback` note 표시 분기만 |
| `web/e2e/model-fallback.spec.ts` | 자체 loopback HTTP fixture 기반 설정 저장→전환→표시→reload 비재호출 시험 |
| `work/RESULT-33.md` | 이 인계 |

Public Rust 연결은 `validate`, `validate_references`, `snapshot`, `runtime`, `permitted`, `after_error`이며 모든 DB 변경은 기존 접수/전환 transaction 경계에 있다. `MAX_CANDIDATES`는 4다. 오류는 기존 ApiError 형식이며 stale 후보는 `fallback_changed`, 유효하지 않은 설정/통화는 invalid, CLI는 unsupported다.

웹 export는 `ProfileFallback({ profile: ModelProfile, profiles: ModelProfile[] })`, `fallbackOptions`, `fallbackPayload`다. 공통 API/store/generated 타입이나 dependency/migration 추가가 없다. 필수 mount·모듈 연결은 완료했으며 메인에서 추가할 라우트는 없다.

29의 hook·승인·tool dispatch 분기와 32의 compaction 표시 분기는 수정하지 않았다. `tests/model_switching.rs`, TODO, 공통 빌드/E2E 설정도 수정하지 않았다. microphone/STT/TTS/playback 및 관련 차단 코드는 건드리지 않았다.

## 실행 검증

공유 도구는 `/data/project/paseodog_opus/.envrc.dev`를 source했고, `web/node_modules`만 메인 경로로 symlink했다. 설치·복사·dependency 갱신은 하지 않았다.

이 기준의 `scripts/build.py::env`는 source한 환경을 worktree의 없는 `.dev`로 덮어쓰므로, 파일 변경 없이 같은 실행기의 DEV만 메인 도구 경로로 지정했다. 실제 Rust 실행은 아래와 같으며 공유 flock을 유지했다.

```bash
source /data/project/paseodog_opus/.envrc.dev
flock /home/ubuntu/.cache/grove-rust-check.lock python3 -c 'import runpy,sys; m=runpy.run_path("scripts/build.py"); m["env"].__globals__["DEV"]="/data/project/paseodog_opus/.dev"; sys.argv=["scripts/build.py","test","--rust","model_fallback","model_switching","http_provider_roundtrip","model_limits","model_capabilities","usage"]; m["main"](); sys.argv=["scripts/build.py","test","--lib","--filter","model_fallback"]; m["main"]()'
```

| 검사 | 입력·결과 |
|---|---|
| `--rust model_fallback` | 13 passed: 429/503 전환, 기본 off/동일 모델 retry, 유한 순서/순환 차단, forbidden status·부분 text/reasoning/tool/stream 오류, transport 실패·취소, 성공 도구 단계 뒤 비전환, 변경·삭제·비활성·secret 교체 후보 차단, 실제 프로필/secret 보호, 실제 startup interrupted 비재호출, 옵션/CLI 거절, capability/input/비용·통화, FAIR 재대기 취소, token/원래 deadline |
| `--rust model_switching` | 2 passed, 기존 endpoint·credential 및 승인 대기 보호 |
| `--rust http_provider_roundtrip` | 6 passed, HTTP provider 간 변환·native 서명 격리·provider 오류 credential 가림 |
| `--rust model_limits` | 3 passed, provider/account/보조 호출 FAIR |
| `--rust model_capabilities` | 4 passed, 접수/실행 capability 및 출력 상한 |
| `--rust usage` | 3 passed, 실제 귀속 집계·취소/재시작 timing |
| `--lib --filter model_fallback` | 2 passed, 나머지 library 시험 186개는 미선택 |
| `git diff --check` | 통과 |

웹 실제 실행:

```bash
source /data/project/paseodog_opus/.envrc.dev
python3 -c 'import runpy,sys; sys.argv=["scripts/build.py","test","--vitest","app/components/ProfileFallback.test.ts","--typecheck"]; m=runpy.run_path("scripts/build.py"); m["env"].__globals__["DEV"]="/data/project/paseodog_opus/.dev"; m["main"]()'
```

Typecheck(새 E2E 포함)와 Vitest 3개 모두 통과했다.

초기 실패도 보존한다:

- 첫 Rust 선택 실행(`model_fallback model_switching http_provider_roundtrip`)은 `ToolDef: serde::Serialize` 부재로 컴파일 실패했다. 입력 추정은 ToolDef 자체 직렬화 대신 기존 필드의 길이를 계산하도록 고쳤고 위 최종 Rust 선택 실행은 전부 통과했다.
- 첫 웹 실행은 typecheck 통과 후 `.test.tsx`가 기존 Vitest `app/**/*.test.ts` 수집 패턴 밖이라 `No test files found`로 실패했다. 시험을 `.test.ts`와 createElement로 옮긴 뒤 위 웹 검사가 통과했다.

실행 로그는 세션 shell 로그에 있고 별도 기록 파일을 저장소에 추가하지 않았다. 최종 통과 Rust 입력에는 위 컴파일 수정과 모든 13개 fallback 통합 시험이 포함됐다.

## TODO 요구별 인계·미검증

| ID | 구현 근거·남은 사항 |
|---|---|
| MODEL-019 | 명시 순서 저장→bounded retry 뒤 허용 오류 전환→실제 모델/이유 note→원래/실제 선택·시도 기록까지 서버와 UI를 연결했다. 서버 동작·usage 귀속·reload 없는 startup 복구는 로컬 통합 시험으로 검증했다. 브라우저 설정부터 표시/reload까지의 실행은 미검증이다. |
| MODEL-020 | 기본 off, 전송 대상·가격 확인, revision 고정/재검증, credential 보호, capability/input/예산/FAIR/취소 보존, 금지 오류 비전환을 구현했다. 기존 signature·active-use·usage 회귀도 통과했다. 실공급자 수용성/요금/실기기는 검증하지 않았다. |
| SETTINGS-004 fallback 부분 | Profiles에 fallback UI를 mount하고 기존 Owner/revision/idempotency API와 연결했다. 역할별 모델/context/disabled 등 SETTINGS-004 전체 완료를 주장하지 않는다. |

통합 단계에서 고정 포트 E2E를 직렬로 실행해야 한다:

```bash
python3 scripts/build.py test --e2e e2e/model-fallback.spec.ts
```

메인의 승인된 공유 빌드 환경을 적용해야 한다. COMMON의 독립 작업 E2E 금지에 따라 여기서는 실행하지 않았다. 전체 회귀·release·패키징·Windows·실계정·실모델·외부 서비스는 실행하지 않았다. 새로운 dependency나 서비스 조작 없이 검증 가능한 범위를 마쳤고, 미해결 제품 컴파일/선택 시험 실패는 없다. 브라우저 E2E 통합 검증이 남은 blocker다.

TODO 갱신·merge·push·deploy·다른 세션 접촉·위임·workspace 정리는 하지 않았다.
