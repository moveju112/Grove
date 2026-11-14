# 구현과 검증

## main 단일 작업 폴더와 세션 조정

- **MUST** 모든 세션은 `/data/project/paseodog_opus`의 `main`에서 수정한다. 사용자가 예외를 명시하지 않으면 기능별 브랜치·별도 worktree에서 구현하거나 이를 배포 원본으로 사용하지 않는다.
  - 기존 worktree의 변경은 버리거나 덮어쓰지 않는다. 해당 변경을 보존하고 소유 세션과 조정해 main에 통합한 뒤 편집을 재개한다. 이를 위해 임의로 checkout·reset·stash하거나 다른 세션을 강제 중단하지 않는다.
  - 검증·빌드용 소스 스냅샷은 별도 구현 장소가 아니다. 그 안에서 소스를 고치지 않는다.
- **MUST** 공유 작업 폴더의 조정 담당은 한 세션으로 고정하고, 각 세션은 첫 편집 전에 세션 ID·작업 범위·소유 파일·현재 상태를 같은 공유 상태에 등록한다.
  - 상태는 `수정 중`, `완료`, `차단`으로 구분한다. 후속 수정이 남았거나 부분 변경이 미완성이면 완료로 등록하지 않는다.
  - 소유 파일을 늘리거나 완료 후 편집을 재개할 때도 먼저 등록한다. 다른 세션이 소유한 파일은 소유권 인계를 확인하기 전에는 수정하지 않는다.
  - 공유 상태·잠금 자동화가 없다면 조정 담당의 단일 공유 기록과 명시적인 편집 허가로 직렬화한다. 각자 채팅에서 완료했다고 말하는 것만으로 다른 세션의 확인을 대신하지 않는다.
- **MUST** `git status`, 파일 mtime, 잠시 변경이 없었던 시간으로 작업 완료·편집 중단을 추정하지 않는다.
  - 미커밋 변경도 완료된 작업일 수 있다. 반대로 Git diff가 없어도 편집 예정·실행 중인 쓰기가 있을 수 있다.
  - 응답이 없거나 연결이 끊긴 세션의 소유권을 자동 해제하지 않는다. 인계 또는 사용자 확인 전에는 해당 작업을 미확정으로 취급한다.
- **MUST** 최종 컴파일·패키징은 [DEPLOY.md](DEPLOY.md)의 빌드 잠금 절차를 따른다. 수정 중의 최소 검사는 계속 허용하되 격리된 데이터·출력 경로를 사용하고 이를 확정 배포 검증으로 보고하지 않는다.

- **MUST** 시간·ID·경로 처리는 프로젝트 공용 구현을 재사용한다.
  - why: 시험용 시계, RFC3339, Windows 경로 정규화가 호출부마다 달라지면 경계 검사가 깨진다.
  - ✅ `app.clock.now()`, `util::fmt_time`, `util::new_id`, `util::canonical`. `evidence: src/util.rs`.
- **MUST** blocking I/O와 SQLite 접근은 기존 blocking 경로로 처리한다.
  - why: 웹·스트림·취소 처리가 사용하는 비동기 실행 스레드를 점유하지 않는다.
  - ✅ `Db::call`은 `spawn_blocking` 안에서 연결 잠금을 획득한다. `evidence: src/store.rs`.
- **MUST** 프로젝트 파일 작업은 `ProjectFs`의 디렉터리 기준 경계와 원자적 발행을 유지한다.
  - why: 문자열 경로 검사만으로는 symlink 교체와 검사 후 사용 경쟁을 막을 수 없다.
  - ✅ `ProjectFs::open`, `read`, `atomic_write`. `evidence: src/project_fs.rs:20`, `evidence: src/project_fs.rs:99`.
- **MUST** CLI 에이전트의 신규 실행과 대화 재개 모두 읽기 전용 정책을 유지한다.
  - why: Grove의 승인 경계를 외부 CLI 설정·hook·MCP로 우회해서는 안 된다.
  - ✅ Codex의 `sandbox_mode="read-only"`와 Claude Code의 `Read,Glob,Grep` 제한. `evidence: src/provider/cli.rs:90`.

## 스타일

현지 파일의 Rust·TypeScript·Python 작성 방식을 우선한다.
식별자는 기존 영문 API 이름을 따르고, 설명 주석은 주변 파일처럼 한국어를 사용한다.
관련 없는 포맷 변경과 의존성 업그레이드는 기능 변경에 섞지 않는다.

## 검증 범위

- **MUST** 수정 중에는 최소 영향 검사를 하고, 관련 기능이 모이면 확정된 입력으로 통합 검증한다.
  - why: 수정 중인 공유 작업 트리의 빌드 결과를 확정 배포 근거로 오해하지 않게 한다.
  - ✅ `scripts/build.py test --rust pairing access`로 관련 대상을 묶고 최종 후보에서 권한·이벤트·복구 경계를 확인한다. `evidence: scripts/build.py`.
- **MUST** 검증 근거는 관련 소스·시험·설정·fixture가 유지되는 동안 재사용하고, 실패하거나 무효화된 검사만 다시 실행한다.
  - why: 무조건적인 전체 재검사와 오래된 성공 근거 재사용을 모두 피한다.
  - ✅ 선택 검사와 매번 격리된 E2E 서버 데이터를 사용한다. `evidence: scripts/build.py`, `evidence: web/e2e/global-setup.ts`.
- **MUST** 미실행·누락 의존성·timeout·결과 불명은 성공 검사와 구분해 보고한다.
  - why: 일부 성공이나 접수만으로 사용자 흐름 전체의 성공을 주장할 수 없다.
  - ✅ 선택 검사는 미선택 검사를 실행하지 않았다고 출력한다. `evidence: scripts/build.py`.

여러 대상을 지정할 때 `--rust`, `--vitest`, `--e2e`는 각각 한 번만 쓰고 뒤에 대상들을 나열한다.
E2E는 실제 서버와 빌드된 웹앱을 사용한다. API mock만으로 인증·복구·전송 경계를 검증했다고 하지 않는다.
계약 변경 시 생성·drift 검사는 [RESPONSE_KEYS.md](RESPONSE_KEYS.md)를 따른다.
