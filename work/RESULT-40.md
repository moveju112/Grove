<!-- grove-handoff:v1
{"state":"ready","remaining":[],"blockers":[],"integration_checks":["통합 candidate에서 공유 grove-rust-check.lock을 사용해 python3 scripts/build.py test --rust deferred_tools tool_batches turns model_capabilities model_fallback http_provider_roundtrip context --e2e e2e/deferred-tools.spec.ts"]}
-->

# 40 — CTX-013 완료 인계

- 상태: 소유 구현·실제 연결·선택 검사·배정된 실제 브라우저 인수 완료. 실행 가능한 잔여 및 blocker 없음.
- Worktree: `<세션 worktree 루트>/b02-40-deferred-tools`
- Branch: `parallel/b02-deferred-tools`
- 고정 기준: `f4a4a702bcd342e159efe8801d429ad181391651`. 시작 HEAD가 정확히 일치했고 `43a51d0055a41fe889692fdb04a5e5b204eebf89` 포함을 확인했다.
- 정본: `<원본 저장소>/work/ENTRY.md`, `<원본 저장소>/work/COMMON.md`, `<원본 저장소>/work/40.md`.
- TODO 체크, 다른 checkout 수정, 위임, merge/rebase, push/배포, 실행 설정·workspace 조작은 하지 않았다.

## 제공 동작과 계약

`load_tool({"names":["write","list"]})`은 현재 내장 registry의 schema만 읽는다. 다른 도구, 프로세스, 파일 변경, 원격 MCP 조회·연결을 실행하지 않는다. 이름은 trim 후 정확한 registry 이름으로 검증하고 중복을 제거해 이름순으로 고정한다. 임의 schema·경로·명령·추가 속성은 받지 않는다.

새 tools-enabled HTTP 턴의 접수 definition에 `deferred_tools` version 1을 고정한다. 초기 전체 schema 대신 `edit`, `load_tool`, `read`의 최대 3개 schema만 보낸다. 파일 읽기·정확한 편집은 기존 기본 경로와 호환되도록 eager로 유지하며, 나머지는 loader 설명의 제한된 이름·요약 목록에서 발견한다. 현재 정책으로 금지된 eager 도구는 제외한다.

- 로딩 인자: 1~8개 이름, 정규화된 이름당 최대 64 bytes. 중복 제거 전에도 8개를 넘으면 오류다.
- 로딩 결과: `tools`의 registry 원문 schema·설명, 이름순 `selected`, `selection:"replace"`, `executed:false`. 턴 호출은 `applies_to:"next_model_request"`, 독립 API 호출은 `"schema_only"`다.
- 선택은 누적하지 않고 마지막 성공한 로딩 호출로 교체한다. 원래 모델 호출 순서인 `tool_calls.rowid`로 결정하므로 병렬 로딩의 완료 시각에 좌우되지 않는다.
- 다음 실제 `load_step`은 같은 턴·대화의 성공한 로딩 호출 target만 읽어 선택을 복원한다. 실패·취소·unknown 호출은 선택 근거가 아니다. 추가 상태 저장·migration·복구 실행기가 없다.
- 전체 모델 schema 수는 최대 11개(선택 8 + eager 2 + loader 1), catalog는 최대 64개, 설명은 도구당 96자다. registry가 catalog 한도를 넘으면 명시적으로 거부한다. loader 자체가 정책상 제공 불가능하면 현재 제공 가능한 schema의 결정적인 최대 11개만 보낸다.
- 조회 성공은 도구 허가나 실행이 아니다. `tools::plan`의 실제 schema·대상·precondition 검증과 기존 approvals의 allow/deny/read_only·명시적 승인·실행 직전 재검사를 그대로 사용한다.
- 알 수 없는 이름은 `unsupported_tool`, 잘못된 인자·조회 개수는 `invalid_arguments`, 금지된 요청 schema는 기존 `policy_denied`/`read_only`, 제공 불가능한 MCP 등은 `unsupported_tool`, 결과 byte 한도 초과는 `output_limit`로 반환한다.
- MCP 노출 여부는 기존 enabled + ready 로컬 기록만 조회한다. 도구별 현재 정책 및 snapshot의 `limits.allowed_tools`를 모델 목록과 schema 조회 모두에 반영한다.
- tools=false는 schema·catalog를 보내지 않고 로딩도 실행하지 않는다. CLI는 기존 capability 접수 거부와 Grove schema 미전송 경계를 유지한다.
- fallback의 실제 후보 capability 검사와 native provider 변환·모델별 서명 격리를 바꾸지 않았다. 같은 registry·정책·선택 집합이면 입력 도구 순서·schema·loader 설명이 동일하다.
- 새 HTTP 턴의 context 검사는 기존 사용량·출력/입력 reserve에 실제 system, loader catalog, 선택 schema의 문자 기반 추정을 더한다. fallback의 기존 오류와 검사도 유지한다. 정확한 tokenizer 계산이나 실제 cache hit·속도 개선을 주장하지 않는다.
- 이미 접수된 version 없는 legacy 턴은 기존 전체 registry schema 계약을 유지하며 새 loader는 추가하지 않는다. 새 턴·다른 대화는 이전 턴의 선택을 자동 상속하지 않는다.

## 소유 변경과 연결

| 경로 | 변경 |
|---|---|
| `src/deferred_tools.rs` | `spec`, `plan`, `snapshot`, `definitions`, `model_tools`, `execute_tool` 및 유한 한도. 현재 registry와 기존 정책을 재사용한다. |
| `src/tools/mod.rs` | loader spec 등록 1줄, loader plan dispatch 1줄만 추가했다. 기존 schema·검증·실행 분기는 그대로다. |
| `src/lib.rs` | `pub mod deferred_tools` 선언 1줄. |
| `src/runner.rs` | `tool_defs`/`load_step` 모델 도구 선택·context 입력 계산 및 접수 definition marker만 변경했다. |
| `src/approvals.rs` | `spawn_execute`의 전용 schema 조회 dispatch 5줄만 추가했다. |
| `tests/deferred_tools.rs` | 전용 Rust 인수 14개. |
| `web/e2e/deferred-tools.spec.ts` | 실제 서버·브라우저 인수 3개. 기존 UI를 그대로 사용한다. |
| `work/RESULT-40.md` | 이 인계. |

미연결 지점은 없다. 설정 등록·새 dependency는 필요하지 않았다. role policy(34), 결과/reference 저장·append/receipt(35), MCP OAuth(36), skills API 호출의 capability 인자 관련 별도 변경(43), runner 실행·hook lifecycle, 공유 UI/store/migration은 수정하지 않았다. `load_step`의 기존 `skills::api::model_instructions(...)` 호출 줄도 그대로다.

## 실제 검증과 근거

모든 실행은 이 worktree에서 원본 `<원본 저장소>/.envrc.dev`를 source했다. 옛 실행기는 파일을 수정하지 않고 Python 프로세스 안에서만 다음과 같이 사용했다.

```bash
source <원본 저장소>/.envrc.dev
flock /home/ubuntu/.cache/grove-rust-check.lock python3 -c \
  'import sys; sys.path.insert(0,"scripts"); import build; build.DEV="<원본 저장소>/.dev"; build.main(["test","--rust","deferred_tools"])'
```

Rust/E2E는 각 전체 명령이 같은 잠금을 유지했다. 여러 Rust target은 하나의 `--rust` 뒤에 함께 지정했다. 기존 실행을 취소하거나 환경을 바꾸지 않았다. `web/node_modules`만 COMMON의 승인된 기존 공유 경로로 symlink했으며 toolchain 설치·복사·build 파일 수정은 없다. 실행기 기본 jobs=2와 cache 설정을 유지했다.

### 전용 Rust

최초 위 명령은 14개 중 12개 통과, 2개 실패(exit 101)였다. 이를 전체 통과로 취급하지 않았다.

| 실패 | 원인·수정 |
|---|---|
| CLI 시험 | 기존 CLI capability가 `tools:true` 접수를 `unsupported`로 거절했다. 시험을 접수 거부 + tools-off 로딩 거부 계약으로 수정했다. CLI를 실제 실행하지 않는다. |
| native 시험 | Anthropic fixture base에 `/v1`을 두 번 붙여 HTTP 404였다. adapter의 기존 `/v1/messages` 계약에 맞춰 fixture base만 수정했다. |

두 시험만 다음 명령으로 재실행해 각각 1개 통과했다. 최초 통과한 나머지 12개의 실행 동작·제품 입력은 바뀌지 않았다. Unix shell 응답 유실 시험의 `cfg(unix)` 표시만 보완했고 이 Linux 실행에는 영향이 없다.

```bash
source <원본 저장소>/.envrc.dev
flock /home/ubuntu/.cache/grove-rust-check.lock python3 - <<'PY'
import sys
sys.path.insert(0, "scripts")
import build
build.DEV = "<원본 저장소>/.dev"
for name in (
    "cli_capability_and_tools_off_block_loading_while_legacy_turns_keep_their_list",
    "signed_native_loading_uses_the_next_request_and_does_not_leak_signatures_to_another_model",
):
    build.main(["test", "--rust", "deferred_tools", "--filter", name])
build.main(["test", "--rust", "tool_batches", "turns", "model_capabilities",
            "model_fallback", "http_provider_roundtrip", "context"])
PY
```

마지막 6개 기존 회귀 target도 모두 통과했다.

| Target | 통과 |
|---|---:|
| `context` | 12 |
| `http_provider_roundtrip` | 6 |
| `model_capabilities` | 4 |
| `model_fallback` | 13 |
| `tool_batches` | 3 |
| `turns` | 38 |

전용 14개는 최초 성공 12개와 수정 후 선택 성공 2개의 근거를 합쳐 인수했다. 수정 후 14개 전체를 한 번에 재실행했다고 주장하지 않는다.

검증한 CTX-013 동작은 초기 제한 목록, 실제 다음 요청의 정확한 registry schema, 정렬/중복 제거/교체/병렬 호출 순서, 잘못된 이름·인자·조회 한도, deny/read_only/미준비 MCP, tools-off/CLI, 승인 대상·call/result ID, 응답 유실 후 같은 승인 key 재전송, 실행 뒤 stream 유실, 취소·재시작 비재실행, 다른 대화/새 턴의 선택 격리, context 거부, fallback 허용/미지원 후보, native 로딩·서명 격리다.

### 웹 타입·단위

```bash
source <원본 저장소>/.envrc.dev
python3 -c 'import sys; sys.path.insert(0,"scripts"); import build; build.DEV="<원본 저장소>/.dev"; build.main(["test","--vitest","app/components/approvals/decision.test.ts","app/components/approvals/projection.test.ts","app/state/capabilities.test.ts","--typecheck"])'
```

최초 실행은 새 E2E의 배열 index nullable 타입 오류로 typecheck 실패(exit 2), Vitest 미실행이었다. 관측한 index에 non-null 표시를 적용한 뒤 같은 명령으로 typecheck와 Vitest 3파일·18개가 모두 통과했다. 그 후 웹 소스·spec은 변경하지 않았다.

### 배정된 실제 브라우저 인수

```bash
source <원본 저장소>/.envrc.dev
flock /home/ubuntu/.cache/grove-rust-check.lock python3 -c \
  'import sys; sys.path.insert(0,"scripts"); import build; build.DEV="<원본 저장소>/.dev"; build.main(["test","--e2e","e2e/deferred-tools.spec.ts"])'
```

debug 서버 빌드, 웹 빌드, Chrome desktop 3개 모두 통과(exit 0).

1. 브라우저에서 보내기 → 제한된 3개 schema 관측 → loader call/result → 실제 다음 요청의 write schema와 registry 원문 비교 → 파일 미생성 확인 → 기존 UI로 이번만 승인 → 실제 파일·결과 표시 → 같은 집합의 loader 재요청 순서 안정성 → 새로고침 비재실행.
2. read_only에서 쓰기 schema 제외·명시적 `read_only` 실패와 오류 표시, tools=false에서 목록 미전송.
3. 로딩 후 승인 대기를 브라우저에서 취소하고 재접속해도 파일 미생성·호출 취소 유지.

실제 유료 모델, 외부 MCP, 개인 데이터는 사용하지 않았다. 브라우저 시험의 파일·서버·모델 fixture는 전용 임시 데이터다.

### 실행기 시간·로그

잠금 대기를 검사 실행 시간으로 해석하거나 속도 개선으로 환산하지 않았다. 아래 값은 실행기가 제공한 값 그대로다.

| 실행 단계 | wall s | CPU s | exit |
|---|---:|---:|---:|
| 최초 전용 Rust(12 성공·2 실패) | 150.29 | 212.96 | 101 |
| 수정 CLI 선택 Rust | 33.69 | 4.17 | 0 |
| 수정 native 선택 Rust | 5.97 | 0.52 | 0 |
| 기존 Rust 6 target 회귀 | 43.76 | 53.79 | 0 |
| 최초 typecheck 실패 | 9.70 | 12.55 | 2 |
| 수정 후 typecheck | 8.02 | 12.67 | 0 |
| Vitest 18개 | 1.18 | 2.69 | 0 |
| E2E debug 서버 빌드 | 60.54 | 84.02 | 0 |
| E2E 웹 빌드 | 6.25 | 5.02 | 0 |
| E2E 3개 | 7.88 | 6.18 | 0 |

실행 로그(이 checkout 외부):

- 최초 Rust: `<실행 로그>/shell_f39ef213.stdout`, `<실행 로그>/shell_f39ef213.stderr`
- 수정 선택 및 기존 Rust 회귀: `<실행 로그>/shell_bf5c134f.stdout`, `<실행 로그>/shell_bf5c134f.stderr`
- 최초 타입 실패: `<실행 로그>/shell_2eb99c17.stdout`
- 수정 타입·Vitest: `<실행 로그>/shell_345e5ffe.stdout`
- 실제 E2E: `<실행 로그>/shell_c5e1114e.stdout`, `<실행 로그>/shell_c5e1114e.stderr`

웹 빌드는 기존 큰 bundle 경고와 React Router v8 future flag 경고를 출력했다. 관련 기능 실패는 아니며 공유 UI/build 설정은 변경하지 않았다. 전체 suite, release/패키징, 실기기 mobile, 실제 유료 provider/cache 성능은 미선택·미검증이다.

모든 성공 검사 뒤 제품 코드·시험은 변경하지 않았고 이 RESULT만 추가했다. `git diff --check`도 통과했다. 다른 개발 세션 목록 조회는 runtime의 `cross-session control is unavailable`로 불가능했지만, 시작 checkout은 clean이었고 이 작업 중 소유 밖 변경은 없었다. 세션 설정을 변경하지 않았다.

## 다음 통합 단계

메인은 위 선택 검사 근거를 관련 입력이 유지되는 동안 재사용하고, 통합 candidate에서 첫 JSON의 결합 검사로 공통 경계를 인수하면 된다. CTX-013 구현·실제 연결·배정 브라우저 범위의 미완료는 없다. TODO 체크와 merge·workspace 정리는 메인 소유다.
