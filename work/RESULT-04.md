# b01 / 04 — 프로젝트 이미지 read 인계

## 식별·상태

- 작업: `TOOL-012`.
- Worktree: `<세션 worktree 루트>/b01-04-image-read`.
- Branch: `parallel/b01-image-read`.
- 공통 기준 SHA: `c186b31ab62734c9f91803cf7848b639ad9871fb`.
- 진입 시 Git 상태는 clean이며 `git merge-base HEAD <기준 SHA>`가 기준 SHA와 일치했다.
- 상태: 소유 범위 구현 종료, 공통 연결·실행 검증 대기. 제품 기능 완료가 아니다.
- 세션 상태 조회는 런타임 오류 `session: cross-session control is unavailable in this runtime`로 확인하지 못했다. 다른 세션의 변경을 인수하지 않았다.
- push·merge·배포·서비스 조작·의존성 설치는 하지 않았다. `TODO.md`도 변경하지 않았다.

## 소유 변경

| 파일 | 변경 |
| --- | --- |
| `src/tools/image_read.rs` | capability 기반 단일 이미지 계획·읽기, 기존 이미지 변환 재사용, bytes와 표시 metadata 분리 |
| `src/attachments.rs` | `model_image`만 `pub(crate)`로 공개. 구현·호출자·hydrate·API·저장·승인 계약은 그대로 |
| `tests/image_read.rs` | 실제 임시 프로젝트 파일을 사용하는 회귀 시험. 모듈 등록 후 실행 가능 |
| `work/RESULT-04.md` | 이 인계 |

## Public API·입출력

`tools::image_read`는 아직 모듈 트리에 등록되지 않았다.

- `plan(args: &Value, root: &Path) -> ToolResult<Planned>`: 비어 있지 않은 단일 `path`를 요구한다. `files` 배치는 받지 않는다. 기존 `fs::plan_read(..., "read")`를 사용하며 `precondition`은 기존 읽기와 같이 `None`이다. registry의 기존 schema 검증을 대체하지 않는다.
- `execute(planned: &Planned, root: &Path) -> ToolResult<ImageRead>`: 원래 인자가 아닌 계획된 경로만 사용한다. 기존 `fs::plan_read`가 만든 단일 파일 계획도 받는다.
- `ImageRead::metadata(&self) -> &Value`: 표시·로그·이벤트에 사용할 JSON.
- `ImageRead::model_bytes(&self) -> &[u8]`: 모델 입력용 JPEG bytes. base64 변환은 provider 요청 직전의 호출자 책임이다.
- `ImageRead::into_parts(self) -> (Value, Vec<u8>)`: metadata와 JPEG의 소유권을 분리해 전달한다.
- `ImageRead`에는 `Serialize` 구현이 없다. `Debug`도 metadata와 JPEG 길이만 출력하고 원문·JPEG bytes·base64를 출력하지 않는다.

Metadata 구조:

```text
{
  path: 프로젝트 상대 경로,
  mime: 원문 image/png | image/jpeg | image/gif | image/webp,
  size: 원문 bytes 수,
  sha256: 실제 읽은 원문 SHA-256,
  image: {
    width, height: 방향 보정 후 원문 크기,
    model_width, model_height: 모델용 JPEG 크기,
    model_mime: "image/jpeg",
    frame: 0
  }
}
```

확장자 대신 기존 `attachments::sniff`를 사용한다. 기존 `attachments::model_image`를 그대로 호출하므로 8192 해상도·1600만 픽셀·128MiB 디코더 할당 제한, 방향 보정, 최대 1024px·확대 없음, 흰 배경 합성, GIF 첫 프레임, quality 80 JPEG 표현을 복제 없이 공유한다.

## 오류·권한·파일 교체 계약

- 읽기 전용 프로젝트 내부 파일만 대상이다. 업로드·DB 기록·원본 변경·외부 요청은 없다.
- 실행 직전 `fs::resolve`로 경계를 재검사하고, 실제 읽기는 `fs::read_project` → `ProjectFs::read/open_file`을 사용한다. 경로 검사 뒤 ambient `File::open`으로 재개방하는 우회는 없다.
- 원문 입력 상한은 기존 첨부와 동일한 `attachments::MAX_FILE_BYTES`인 4MiB다. capability 경로가 최대 상한+1 byte만 읽고 초과를 거절한다.
- 계획 후 일반 파일이 프로젝트 내부의 다른 일반 파일로 바뀌면 기존 `read` 정책대로 실행 시점 내용을 읽는다. metadata hash도 그 bytes의 hash다. 계획 시점 snapshot이나 hash 고정은 하지 않는다.
- 프로젝트 밖 경로·symlink 교체는 기존 resolve/capability 정책으로 거절한다. special file은 기존 nonblocking open과 파일 종류 검사로 거절한다.
- `invalid_arguments`: 단일 path가 없거나 잘못된 계획·배치 입력.
- `outside_project`, `invalid_path`, `project_unavailable`: 기존 경로·프로젝트 경계 오류를 그대로 전달.
- `read_failed`: 기존 `read_project`의 I/O 계약 그대로다. 없는 파일·디렉터리·권한 실패·special file·4MiB 초과는 모두 이 code로 감싼 원인을 전달한다. `fs::read`의 세분화된 오류 code와 차이가 있으므로 통합 시 사용자 표시 정책을 확인해야 한다.
- `unsupported_image`: PNG/JPEG/GIF/WebP로 sniff되지 않는 원문.
- `invalid_request`: 지원 형식의 손상·과도한 해상도/픽셀 등 기존 `model_image` 오류 code·message를 유지.
- 이미지로 감지된 파일이 실행 시점에 손상·미지원 내용으로 바뀌면 실패해야 하며 hex 성공으로 조용히 전환하지 않는다.

## 검증 근거

| 실제 실행 명령·입력 | 결과 |
| --- | --- |
| `git diff --check` | 통과. 실행 시점 소유 코드 변경의 whitespace 검사 |
| `/home/ubuntu/.rustup/toolchains/1.93.0-x86_64-unknown-linux-gnu/bin/rustfmt --edition 2024 --check src/tools/image_read.rs tests/image_read.rs` | 첫 실행은 포맷 차이로 exit 1. 제시된 차이를 수정한 후 동일 명령 exit 0 |
| `python3 scripts/build.py test --rust image_read attachments --dry-run` | exit 0. `cargo test --test image_read --test attachments` 선택만 확인. 시험을 실행한 결과가 아님 |

실행하지 않은 검사:

- Rust 컴파일·단위·integration·provider fixture·서버·브라우저 검사는 `COMMON.md`의 독립 단계 자원 계약에 따라 실행하지 않았다. 별도 crate·가짜 실행기·의존성 설치로 우회하지 않았다.
- `src/tools/mod.rs`를 수정하지 않았으므로 신규 모듈은 라이브러리 컴파일 그래프 밖이다. 신규 integration target은 `grove::tools::image_read`를 import하므로 등록 전에는 컴파일되지 않는다. 기존 검사에서 신규 코드가 검증됐다고 주장하지 않는다.
- 새 파일의 rustfmt 통과는 구문·포맷 근거일 뿐 타입 검사나 동작 검증 근거가 아니다.
- 기존 첨부 회귀와 세 provider fixture 검증은 이번 변경에서 재실행하지 않았다.
- Windows의 파일 교체·권한 동작은 미검증이다. symlink·FIFO 시험은 `cfg(unix)`다.

작성한 시험은 metadata·JPEG 분리, PNG resize·투명 배경·원본 보존, 네 형식·확장자 독립·확대 없음, JPEG 방향 보정, GIF 첫 프레임, 손상·미지원 형식, 8192 해상도·1600만 픽셀 제한, 4MiB 초과, 잘못된 인자·없는 파일·디렉터리, 프로젝트 밖 경로, 내부 파일 교체, 계획 후 파일·부모 symlink 탈출, FIFO 교체를 다룬다. 이 시험들은 아직 실행되지 않았다.

## 공통 연결과 남은 위험

1. `src/tools/mod.rs`에 `pub mod image_read;`를 등록한다. 별도 이미지 도구를 추가하는 대신 기존 `read`의 읽기 전용 권한 경계를 유지한다.
2. `src/tools/fs.rs`의 단일·배치 read에서 지원 이미지 감지를 연결한다. 단일 파일의 `Planned`를 `image_read::execute`에 전달할 수 있다. 배치는 파일별 오류 격리·순서·출력 및 이미지 총량 한도를 유지해야 한다. 이미지 bytes를 JSON 배열·hex·base64 텍스트로 반환하지 않는다.
3. `tools::execute`와 runner의 현재 결과형은 `ToolResult<Value>`다. 신규 `ImageRead`를 metadata JSON만으로 낮추면 이미지가 유실된다. 별도 typed 이미지 전달 경로를 공통 실행 결과에 연결해야 한다.
4. 현재 `provider::ChatMsg::Tool`은 텍스트 전용이다. provider 표현을 확장하거나 기존 이미지 입력 경로를 적절히 연결하되 tool-call/result 짝·이미지 순서·provider별 형식과 모델 vision capability·CLI의 `unsupported_image`를 보존한다.
5. `attachments::hydrate`는 DB에 존재하는 첨부 ID·참조·hash를 검증한다. 프로젝트 경로·임의 ID를 업로드 첨부 ID처럼 넣으면 안 된다. 기존 첨부 소유권/API/저장 계약을 바꾸거나 가짜 참조로 우회하지 않는다.
6. 현재 모듈은 bytes만 반환하며 영속화·재시작/재시도 replay를 제공하지 않는다. 공통 연결에서 이미지 문맥의 기존 개수·8MiB 총량 제한, 저장된 metadata와 모델 bytes의 일치, 파일 변경·권한 철회 후 재시도 정책을 명확히 유지해야 한다. 유료/외부 provider 호출은 이번 단계에서 하지 않았다.
7. 통합 후 호스트 승인 빌드 환경을 적용하고 `python3 scripts/build.py test --rust image_read attachments`와 `python3 scripts/build.py test --lib --filter attachments::image_tests`를 실행한다. 이어 실제 프로젝트 `read` 호출에서 OpenAI/Anthropic/Gemini 요청까지의 fixture 검증, 텍스트 로그에 이미지 원문이 없는지, 권한 밖 파일 거부·실패·취소·재시도 흐름을 검증한다. 기존 첨부 provider 표현 시험만으로 프로젝트 이미지 연결을 통과 처리하지 않는다.

## TODO 판정·종료

`TOOL-012`의 독립 구현 범위인 bounded 프로젝트 읽기와 기존 metadata·resize·JPEG 변환 재사용은 코드로 제공했다.
그러나 실제 `read` → runner → 모델 입력은 미연결이고 실행 시험도 미완료이므로 TODO 완료 후보로 확정하지 않는다.
통합 담당이 연결·필수 회귀·provider fixture를 마친 뒤 전체 요구를 판단하고 `TODO.md`를 갱신해야 한다.
소유 범위 구현을 막는 blocker는 없으며, 남은 blocker는 의도적으로 유보한 공통 연결과 실행 검증이다.
이 파일과 관련 코드·시험만 로컬 커밋한 뒤 편집을 종료한다.
