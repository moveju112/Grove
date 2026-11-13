<!-- grove-handoff:v1
{"state":"ready","remaining":[],"blockers":[],"integration_checks":[]}
-->

# 35 — 큰 도구 결과 보관·범위 재조회

- 상태: 소유 구현·연결·선택 Rust/Vitest/typecheck·전용 브라우저 흐름 완료. blocker 없음.
- worktree: `<세션 worktree 루트>/b02-35-tool-outputs`
- branch: `parallel/b02-tool-outputs`
- 고정 기준: `11e51d6efaf0b10a6f0c2c682da7bb1db5738955`. 시작 시 HEAD·branch·clean 확인, `a453f18` 포함 확인. merge/rebase 없음.
- 정본: `<원본 저장소>/work/ENTRY.md`, `<원본 저장소>/work/COMMON.md`, `<원본 저장소>/work/35.md`.

## 제공 동작·계약

`CTX-012`의 큰 결과 보관 → 모델 발췌/참조 → 실제 재조회 → 복구 흐름을 연결했다.

| 항목 | 구현·검증 근거 |
|---|---|
| 원본·identity | `tool_calls.result`, 화면용 `messages.content`, provider call/result 짝과 `is_error`는 그대로 유지. 영속 call ID로만 조회 |
| 모델 표현 | 16 KiB 초과 결과는 `messages.model_input`에 별도 참조. UTF-8 발췌 최대 2048바이트, 전체 저장 표현의 크기·SHA-256·후속 조회 인자·`complete:false` 포함 |
| 실제 조회 | registry의 `tool_output_read`를 기존 모델 도구 경로와 직접 `tool-requests` 경로에서 실행. 실제 provider 요청에서 제한된 조회 결과까지 확인 |
| 범위·상한 | 기본 offset 0, limit 4096바이트. limit 1~4096, call ID 1~128바이트. offset은 UTF-8 경계. `end_offset`·`next_offset`으로 유한하게 이어 읽기. escape 팽창까지 기존 64 KiB 출력 상한 아래 |
| 가시성 | 계획·실행 양쪽에서 현재 대화와 실제 상속한 조상의 fork 시점 이전 비-rewound tool 메시지만 허용. 다른 대화·프로젝트·미상속·미래 결과·메시지 없는 조상 직접 호출 차단 |
| 기존 권한 | 기존 인증, tool policy, read_only, 실행 직전 권한 재검사, 활성 session/project/worktree 실행 root 경로 유지. 새 도구는 `Effect::Conversation` |
| 복구 | DB commit 뒤 파일 사본을 만든다. 파일 누락·변조·쓰기 실패·재시작·DB snapshot 복구에도 DB 결과로 조회·재생성. 원래 성공/실패/cancelled/unknown 상태·결과 보존, 원래 실행 재시도 없음 |
| 오류 | 원문 누락·파싱 불가를 빈 성공으로 대체하지 않는다. 원래 실패 결과를 성공 결과로 바꾸지 않고 조회 응답에 원본 `status`·`is_error` 포함 |
| 재귀 방지 | 조회 도구 자체의 결과에는 offload 참조를 만들지 않는다. 조회 결과를 다시 읽더라도 응답 범위는 동일한 상한 적용 |
| legacy | call identity가 있는 기존 큰 tool 메시지도 history에서 같은 참조로 변환. DB 원문 수정 없이 기존 100 KiB 잘림 전에 연결 |
| 브라우저 | 로컬 fixture의 실제 셸 결과에서 화면 원문과 모델 참조를 구분. 모델의 실제 재조회, reload 뒤 호출/모델 요청 수 불변과 셸 실행 표식 1회를 확인 |

문자열 결과는 문자열 그대로, 나머지는 기존 `provider::tool_content_string`의 compact JSON UTF-8 표현을 조회한다. offset은 줄·문자 수나 JSON 내부 필드 위치가 아니라 이 표현의 바이트 위치다. 요청 offset이 범위 밖/문자 중간이거나 limit이 다음 문자를 담지 못하면 명시적으로 실패한다. 원래 도구가 이미 버린 출력은 복구하지 않는다는 안내를 발췌·조회 모두에 넣었다.

파일 위치는 `data_dir/tool-outputs/<sha256(call_id)>.txt`다. 입력 경로는 받지 않는다. capability 디렉터리, 전용 디렉터리 확인, 임시 새 파일과 rename을 쓰며 Unix 디렉터리/파일은 각각 0700/0600이다. 디렉터리·사본 symlink 시험에서 외부 파일을 읽거나 덮어쓰지 않았다. 파일은 조회의 정본으로 신뢰하지 않고 DB에서 다시 만든다. 따라서 파일 I/O 실패만으로 DB 조회가 실패하지는 않으며 `copy:"unavailable"`로 구분한다. 최종 실행 결과의 사본 저장 실패는 본문/경로 없이 `output_copy_unavailable` 경고만 기록한다.

원문 읽기 오류 코드는 `output_unavailable`/`output_unreadable`, 비가시 ID는 존재 여부를 구분하지 않는 `not_found`, 아직 종료되지 않은 원본은 `output_not_ready`다. 인자·범위 오류는 기존 failed tool-result 경로를 사용한다. 조회 응답의 도구 이름 표시는 128바이트로 제한하지만 DB 이름과 메시지 identity는 바꾸지 않는다.

## 소유 파일·연결 지점

| 경로 | 변경 |
|---|---|
| `src/tool_outputs.rs` | 신규 모듈, 상수, spec/identity plan, 가시성, 모델 표현, 사본 보관·범위 조회, 단위 시험 |
| `src/approvals.rs` | `create_call`의 새 도구 identity 계획, `append_tool_message`의 model_input, `spawn_execute`의 새 도구 dispatch와 DB commit 후 사본 연결만 |
| `src/history.rs` | tool 메시지의 큰 원문을 bounded 참조로 연결. 기존 잘림 안전망·호출 짝·오류 상태 유지 |
| `src/tools/mod.rs` | 새 도구 spec와 plan 등록만 |
| `src/lib.rs` | `pub mod tool_outputs` 선언만 |
| `tests/tool_outputs.rs` | 전용 통합 시험 9개 |
| `web/e2e/tool-outputs.spec.ts` | 전용 실제 브라우저 시나리오 1개 |
| `work/RESULT-35.md` | 이 구조화 인계 |

public export는 `tool_outputs::{NAME, INLINE_BYTES, EXCERPT_BYTES, MAX_READ_BYTES}`다. 연결 함수 `spec`, `plan`, `model_input`, `store_copy`, `execute`는 crate 내부 공개다. 새 HTTP route·DB schema·웹 API/공통 UI·dependency 변경이나 미연결 지점은 없다. hooks/cwd/runner/fallback 분기는 수정하지 않았다. TODO 체크·다른 checkout·runtime 설정·workspace 관리·위임·merge/push/deploy는 하지 않았다.

## 실행한 검사

공용 환경은 `source <원본 저장소>/.envrc.dev`를 먼저 적용했다. Rust·E2E는 전체 명령을 `flock /home/ubuntu/.cache/grove-rust-check.lock`으로 직렬화했다.

이 기준의 `scripts/build.py`는 `env()`에서 DEV를 worktree의 `.dev`로 덮어쓴다. 첫 실행에서 rustup이 로컬 툴체인을 자동 설치한 사실이 로그에 있다. task가 만든 worktree `.dev`만 제거했고, 이후에는 파일 수정·추가 설치 없이 실행기의 DEV만 프로세스 안에서 공용 경로로 지정했다. 사용한 실행기 호출은 다음과 같다.

```bash
source <원본 저장소>/.envrc.dev
flock /home/ubuntu/.cache/grove-rust-check.lock python3 -c 'from scripts import build; build.DEV = "<원본 저장소>/.dev"; build.main()' test --rust tool_outputs
flock /home/ubuntu/.cache/grove-rust-check.lock python3 -c 'from scripts import build; build.DEV = "<원본 저장소>/.dev"; build.main()' test --lib --filter tool_outputs
python3 -c 'from scripts import build; build.DEV = "<원본 저장소>/.dev"; build.main()' test --vitest app/components/approvals/projection.test.ts app/state/events.test.ts --typecheck
flock /home/ubuntu/.cache/grove-rust-check.lock python3 -c 'from scripts import build; build.DEV = "<원본 저장소>/.dev"; build.main()' test --e2e e2e/tool-outputs.spec.ts
```

| 실제 입력·결과 | 실행기 wall / CPU |
|---|---|
| `--rust tool_outputs`: 최종 9/9 통과 | 20.09s / 8.0s |
| `--lib --filter tool_outputs`: 2/2 통과, 다른 186개 미선택 | 57.63s / 69.07s |
| `--rust model_input_pages`: 3/3 통과 | 아래 실패했던 통합 실행에 포함, 별도 시간 없음 |
| `--rust tool_batches`: 3/3 통과 | 138.4s / 216.79s |
| typecheck 통과 | 17.35s / 12.71s |
| Vitest 지정 2파일: 11/11 통과 | 9.3s / 2.35s |
| E2E용 debug 서버 빌드 통과 | 66.03s / 82.85s |
| E2E용 웹 빌드 통과 | 4.02s / 4.88s |
| desktop `e2e/tool-outputs.spec.ts`: 1/1 통과 | 4.03s / 3.97s |

첫 명령은 `python3 scripts/build.py test --rust tool_outputs --rust model_input_pages --rust tool_batches`였다. 반복 옵션 중 마지막 값만 적용돼 실제로는 tool_batches 3개만 실행됐다. 새 도구 검사가 실행된 것으로 간주하지 않았다.

그다음 공용 DEV로 `test --rust tool_outputs model_input_pages`를 실행했다. model_input_pages 3개 통과, 당시 tool_outputs 7개 중 6개 통과·1개 실패로 명령은 exit 101이었다(151.25s wall / 215.15s CPU). 실패는 `assertion failed: !tool["content"].as_str().unwrap().contains("OUTPUT-END")`다. 끝 표식이 원문 출력뿐 아니라 셸 command 필드에도 있어 발췌에 포함된 것이 원인이었다. fixture를 `cat output.txt`로 바꾸고 출력 파일에만 표식을 두어 수정했다. 제품 동작은 이 실패 때문에 바꾸지 않았다. 전용 보안/legacy 시험을 추가한 뒤 최종 9개를 다시 실행해 모두 통과했다.

검사 로그(각 경로의 stdout/stderr):

- `<실행 로그>/shell_cb46c00a.stdout`, `<실행 로그>/shell_cb46c00a.stderr`: 최초 실제 tool_batches와 자동 설치.
- `<실행 로그>/shell_5df30490.stdout`, `<실행 로그>/shell_5df30490.stderr`: model_input_pages 통과와 수정 전 fixture 실패.
- `<실행 로그>/shell_beb21c16.stdout`, `<실행 로그>/shell_beb21c16.stderr`: 최종 전용 통합 9개·단위 2개.
- `<실행 로그>/shell_a648105b.stdout`, `<실행 로그>/shell_a648105b.stderr`: typecheck·Vitest.
- `<실행 로그>/shell_7c2df63e.stdout`, `<실행 로그>/shell_7c2df63e.stderr`: debug/web 빌드·실제 브라우저.

최종 제품 모듈과 전용 시험은 최종 Rust·브라우저 검사 후 바꾸지 않았다. typecheck/Vitest의 웹 입력도 그대로다. 이전 통과한 model_input_pages/tool_batches 이후 Rust 추가 변경은 큰 결과의 표시 이름 상한과 전용 모듈 단위 시험이며, 이 회귀들의 작은 tool 결과·페이지 처리·실행 순서 입력은 바뀌지 않아 통과 근거를 재사용했다. 그 뒤 추가한 파일은 이 RESULT뿐이다.

## 남은 조건·통합

소유 범위의 실행 가능한 미완료와 blocker는 없다. `CTX-012`의 참조 제공·제한된 실제 재조회·권한·복구·원래 결과 보존을 위 검사로 확인했으며, TODO 반영은 통합 담당 소유다.

전체 인수·release·다른 플랫폼/실기기는 미선택이다. E2E 빌드의 기존 React Router v8 future-flag 및 500 kB 초과 chunk 경고는 남겼고 공통 UI/빌드 설정은 건드리지 않았다. 테스트는 격리된 임시 데이터·loopback 모델 fixture만 사용했으며 실제 모델·계정·외부 서비스는 호출하지 않았다. 임의 파일 다운로드 UI나 사본 retention/GC를 추가하지 않았다. 화면의 기존 20,000자 출력 미리보기 제한은 그대로이며 DB·messages API 원문은 보존된다.

통합 시 이 고정 기준의 변경만 합치고, 29/31/33 등과 합쳐진 candidate에서 필요한 공통 경계 인수를 선정하면 된다. 전용 재현 진입점은 위 `--rust tool_outputs` 및 `--e2e e2e/tool-outputs.spec.ts`다. 여기서 통합·push·배포·workspace 정리를 수행하지 않는다.
