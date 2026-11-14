# 구현과 검증

## 구현

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

- **MUST** 검증 근거는 관련 소스·시험·설정·fixture가 유지되는 동안 재사용하고, 실패하거나 무효화된 검사만 다시 실행한다.
  - why: 무조건적인 전체 재검사와 오래된 성공 근거 재사용을 모두 피한다.
  - ✅ 선택 검사와 매번 격리된 E2E 서버 데이터를 사용한다. `evidence: scripts/build.py`, `evidence: web/e2e/global-setup.ts`.
- **MUST** 미실행·누락 의존성·timeout·결과 불명은 성공 검사와 구분해 보고한다.
  - why: 일부 성공이나 접수만으로 사용자 흐름 전체의 성공을 주장할 수 없다.
  - ✅ 선택 검사는 미선택 검사를 실행하지 않았다고 출력한다. `evidence: scripts/build.py`.

여러 대상을 지정할 때 `--rust`, `--vitest`, `--e2e`는 각각 한 번만 쓰고 뒤에 대상들을 나열한다.
E2E는 실제 서버와 빌드된 웹앱을 사용한다. API mock만으로 인증·복구·전송 경계를 검증했다고 하지 않는다.
계약 변경 시 생성·drift 검사는 [RESPONSE_KEYS.md](RESPONSE_KEYS.md)를 따른다.
