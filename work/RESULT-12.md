# b02 / 12 — 프로젝트 이미지 read 모델 전달 인계

## 식별·상태

- 작업: `TOOL-012`, 04 이월의 실제 `read` → runner → provider 연결.
- Worktree: `/home/ubuntu/.local/share/paseodog/paseo/worktrees/0q796rug/b02-12-image-read-wire`.
- Branch: `parallel/b02-image-read-wire`.
- 공통 기준 SHA: `bc797b36cd0c09ce41eb675d7d152ce95ffa7ef1`. `git merge-base HEAD <기준 SHA>` 일치, 진입 시 clean.
- 상태: 소유 구현 종료, Rust 컴파일·관련 integration 검증 통과. 통합 담당의 웹 환경 검증·TODO 판정 대기.
- 세션 조회는 이전 진입에서 `session: cross-session control is unavailable in this runtime`로 확인 불가였다. 다른 세션 변경을 인수하지 않았다.
- push·merge·배포·서비스 조작·의존성 설치·TODO 변경은 하지 않았다.

## 소유 변경

| 파일 | 제공 동작 |
| --- | --- |
| `src/tools/image_read.rs` | 기존 read 결과의 이미지 감지·metadata 참조, hash 검증 후 typed 이미지 입력 복원, 배치·문맥 한도, 파일 교체 시 표본 유출 방지 단위 시험 |
| `src/tools/mod.rs` | 기존 `read` 실행 분기를 `image_read::read`에 연결 |
| `src/runner.rs` | `load_step`에서 업로드 첨부 복원 후 프로젝트 이미지 복원, 그 뒤 모델 capability 확인 |
| `tests/image_read.rs` | 기존 11개와 신규 5개, 실제 로컬 HTTP 세 provider·재시작·retry 포함 |
| `work/RESULT-12.md` | 이 인계 |

공통 provider serializer는 수정하지 않았다. 기존 `ChatMsg::User { images: Vec<ImageInput>, .. }`와 OpenAI `image_url`, Anthropic `image`, Gemini `inlineData` 생성 경로를 그대로 재사용한다. 스킬 지침 조립·업로드 첨부 저장/API/DB schema는 변경하지 않았다.

## Public API·입출력·영속화

- 기존 `plan`, `execute`, `ImageRead::{metadata, model_bytes, into_parts}` 계약은 유지한다.
- `image_read::read(args, planned, root) -> ToolResult<Value>`: registry의 `read` 전용 진입점. 텍스트·일반 binary는 기존 `fs::read` 결과를 유지한다. 이미지 signature는 확장자와 무관하게 기존 read 표본과 capability 파일의 최대 16바이트로 확인한다. 먼저 읽은 이미지 표본이 있으면 원문이 일반 텍스트로 교체돼도 hex 성공으로 되돌리지 않고 변환 오류를 반환한다. ASCII처럼 보이는 손상 GIF도 이미지 오류로 처리한다.
- 이미지 성공 결과는 기존 `path`, `mime`, `size`, 원문 `sha256`, `image` metadata에 `"model_input": "project_image"`를 추가한다. 이미지 원문·JPEG·hex·base64는 반환하지 않는다.
- 배치는 기존 파일 순서·동일 경로의 겹친 범위 병합·텍스트 출력 한도·파일별 오류 격리를 유지한다. 이미지 변환 오류는 해당 항목의 `error`로 반환한다. JSON escape로 혼합 배치가 history의 100KiB 문자열 절단 상한을 넘을 때에는 텍스트 항목을 `batch_output_limit`로 생략해 이미지 참조를 보존한다.
- 영속 데이터는 기존 tool result 저장 경로의 metadata뿐이다. 업로드 첨부 ID나 DB 참조를 만들지 않는다. 기존 tool-call/result 저장의 원자성·순서는 변경하지 않았다.
- `image_read::hydrate(messages: &mut Vec<ChatMsg>, root: &Path) -> ToolResult<()>`: runner가 업로드 첨부 `attachments::hydrate` 이후, provider 요청 구성 직전에 호출한다. 현재 세션 실행 root 안에서 capability 읽기를 다시 수행하고 원문 hash와 metadata 전체를 검증한다.
- 연속된 모든 tool result 뒤에 출처 `tool_call_id`·경로를 명시한 typed user 이미지 메시지를 추가한다. 따라서 여러 tool-call/result 짝 사이에 이미지 user 메시지가 끼지 않는다. 출처 텍스트는 untrusted file data로 표시한다.
- 정규화 JPEG만 기존 `ImageInput`으로 전달한다. base64는 위 요청 구성 시점의 메모리에만 존재하며 `ImageInput.data`의 기존 serde skip·redacted Debug를 재사용한다. synthetic `project-read:` ID는 내부 출처 표식이며 업로드 ID로 조회하지 않는다.
- 재시작·수동 turn retry·다음 모델 step마다 metadata에서 다시 복원한다. provider 내부 HTTP retry는 기존과 같이 이미 구성한 동일 요청을 재사용한다. 파일이나 경로가 사라지면 I/O/경계 오류, 원문이 바뀌면 디코딩 전에 `image_changed`로 실패한다.

## 제한·오류·권한

- 읽기 전용 기존 `read` 권한과 실행 시점 project boundary·capability I/O를 유지한다. symlink 탈출·special file은 기존 경로에서 거절한다.
- 원문 4MiB, 해상도·픽셀·할당 상한, 방향 보정·최대 1024px·확대 없음·투명 배경 흰색 합성·GIF 첫 프레임·quality 80 JPEG는 기존 `attachments::model_image`를 재사용한다.
- 단일 read 배치의 정규화 입력과 전체 모델 문맥에 base64 크기 기준 8MiB 한도를 적용한다. 문맥 32개 제한은 업로드 첨부와 프로젝트 이미지를 합산한다.
- 기존 변환·I/O 오류 code는 유지한다. 추가 오류는 `image_changed`, `invalid_image_reference`, `image_input_limit`이다. runner에서 code/message를 보존해 실패한 turn에 기록한다.
- `capabilities.images == false`인 모델은 `unsupported`로 다음 provider 요청 전에 실패한다. CLI의 기존 `unsupported_image` 계약도 유지한다. 미확인 capability는 기존 정책대로 false로 추측하지 않는다.
- 이미지 bytes/base64를 tool JSON·events·errors·Debug·추가 로그에 쓰지 않는다. 로컬 fixture 시험에서 messages/events/tool_calls의 원문·정규화 base64 부재와 attachments 행 0개를 검증했다.

## 실행 검증

호스트 공용 `.dev`를 복사하지 않고 `ln -s /data/project/paseodog_opus/.dev .dev`로 만든 task-owned symlink를 재사용했다. 빌드 호출마다 `source /data/project/paseodog_opus/.envrc.dev`를 적용했다. 검증 후 정확한 symlink 대상과 소유권을 확인해 이 링크만 제거했다. toolchain·node_modules 설치나 복사는 하지 않았다.

| 명령·입력 | 실제 결과 |
| --- | --- |
| 공용 Rust 1.93.0의 `rustfmt --edition 2024 src/tools/image_read.rs tests/image_read.rs` | 실행 완료. 자동으로 따라간 common harness의 포맷 변경은 diff 근거로 제거해 원본과 일치시켰다. 동작 변경 없음 |
| `CARGO_TARGET_DIR=/data/project/paseodog_opus/target python3 scripts/build.py test --rust image_read attachments http_provider_roundtrip tool_batches --lib --filter image --vitest app/state/capabilities.test.ts --typecheck` | 첫 실행 exit 101. 컴파일 완료, image 필터 library 3개·attachments 4개 통과. 새 provider fixture의 HTTP 400 기대 code가 `invalid_request`여서 실패; 실제 기존 계약 `bad_request`로 기대값만 수정. HTTP target은 필터로 0개, tool_batches·웹 검사는 앞 실패로 미실행 |
| `CARGO_TARGET_DIR=/data/project/paseodog_opus/target npm_config_offline=true python3 scripts/build.py test --rust image_read tool_batches http_provider_roundtrip attachments --typecheck --vitest app/state/capabilities.test.ts` | Rust 컴파일 및 integration 40개 통과: image_read 16, attachments 15, http_provider_roundtrip 6, tool_batches 3. 이어 typecheck exit 127: `sh: 1: react-router: not found`. Vitest는 실행기가 중단해 미실행 |
| `CARGO_TARGET_DIR=/data/project/paseodog_opus/target python3 scripts/build.py test --lib --filter tools::image_read::tests` | 최종 파일 교체 보완 후 컴파일·단위 1개 통과. 이미지 표본을 읽은 뒤 원문을 텍스트로 바꾸면 hex 성공이 아닌 `unsupported_image`를 반환 |
| `CARGO_TARGET_DIR=/data/project/paseodog_opus/target python3 scripts/build.py test --rust image_read tool_batches http_provider_roundtrip attachments` | 위 최종 소스와 원본 common harness로 컴파일·integration 40개 전부 재통과. 웹 의존성 실패는 재실행하지 않았고 여전히 미해결 |
| 공용 Rust 1.93.0의 `rustfmt --edition 2024 --config skip_children=true --check src/tools/image_read.rs tests/image_read.rs` | 최종 소유 Rust 파일만 검사, exit 0 |
| `git diff --check` | 통과 |

40개 통과에는 세 HTTP provider의 실제 `read` tool call → runner → JPEG image part 요청, 고의 HTTP 실패 뒤 서버 재시작·turn retry의 동일 이미지, 원문 변경 시 외부 호출 없는 `image_changed`, 미지원 모델의 이미지 전송 거부가 포함된다. 배치 순서·오류 격리·잘린 JSON·metadata 불일치·업로드와 합산한 문맥 한도·경계 재검사도 검증했다. 기존 첨부/승인·취소/서명된 provider 내용의 회귀도 통과했다.

첫 실행 로그: `/home/ubuntu/.local/share/paseodog/mixdog/data/shell-output/shell_0d8aace6.stdout`, `/home/ubuntu/.local/share/paseodog/mixdog/data/shell-output/shell_0d8aace6.stderr`.
웹 blocker 실행 로그: `/home/ubuntu/.local/share/paseodog/mixdog/data/shell-output/shell_3d3b6976.stdout`, `/home/ubuntu/.local/share/paseodog/mixdog/data/shell-output/shell_3d3b6976.stderr`.
최종 Rust 실행 로그: `/home/ubuntu/.local/share/paseodog/mixdog/data/shell-output/shell_0611a6b9.stdout`, `/home/ubuntu/.local/share/paseodog/mixdog/data/shell-output/shell_0611a6b9.stderr`.
Cargo 로그의 실제 산출물은 호스트 cache `/home/ubuntu/.cache/cargo-build/ae/5e402e02bdf0be/debug/deps/`였다.

## 남은 조건·통합

- `TOOL-012`: metadata·resize·typed provider 표현과 실제 read/runner 연결·영속 metadata·재시작/retry는 위 Rust fixture에서 확인했다. `TODO.md` 체크는 하지 않았으며 통합 담당이 전체 요구와 필수 검증을 최종 판단해야 한다.
- 코드 등록이나 provider 공통 연결은 추가로 필요하지 않다. 다른 작업 통합 시 runner의 첨부 복원 → 프로젝트 이미지 복원 → capability 확인 순서를 유지해야 한다.
- blocker: 웹 실행 환경에 `react-router`가 없어 typecheck 실패, 선택 Vitest 미실행. 승인된 의존성이 준비된 통합 환경에서 이 두 검사만 보충해야 한다. Rust 통과 결과를 웹 통과로 간주하지 않는다.
- E2E·전체 회귀·release·패키징은 COMMON의 통합 단계 범위로 실행하지 않았다. 유료/외부 provider·실제 모델 품질·Windows 파일 권한/교체 동작도 미검증이다. PDF·OCR(`TOOL-013`)은 제외했다.
- 원문 변경/권한 철회 후에는 조용히 새 bytes를 보내지 않고 명시적으로 실패한다. 변경된 프로젝트 파일을 다시 읽으려면 새 대화를 사용해야 한다.
- 관련 코드·시험·이 인계만 한국어 메시지로 로컬 커밋한 뒤 멈춘다.
