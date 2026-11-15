# 구현과 검증

## 구현

- **MUST** 시간·ID·경로 처리는 프로젝트 공용 구현을 재사용한다.
  - why: 시험용 시계, RFC3339, Windows 경로 정규화가 호출부마다 달라지면 경계 검사가 깨진다.
  - ✅ `app.clock.now()`, `util::fmt_time`, `util::new_id`, `util::canonical`. `evidence: src/util.rs`.
- **MUST** blocking I/O와 SQLite 접근은 기존 blocking 경로로 처리한다.
  - why: 웹·스트림·취소 처리가 사용하는 비동기 실행 스레드를 점유하지 않는다.
  - ✅ `Db::call`은 `spawn_blocking` 안에서 연결 잠금을 획득한다. `evidence: src/store.rs`.
- **MUST** 동일 자원의 조회 조건 변경은 범위가 명시된 cache와 `useQuery`의 `keepPreviousData`를 재사용한다. 기존 목록·입력·스크롤을 지우거나 cache key에 매 렌더 시각을 넣어 반복 조회하지 않는다. 다른 자원·프로젝트·인증 세대 사이에는 이전 내용을 넘기지 않는다. 읽기 재검증과 영속 mutation의 재시도는 구분한다.
  - ✅ `useQuery(..., { keepPreviousData: true, scope: resourceKey })`. `evidence: web/app/state/store.ts`, `evidence: web/app/components/RecentPanel.tsx`.
- **MUST** 프로젝트 파일 작업은 `ProjectFs`의 디렉터리 기준 경계와 원자적 발행을 유지한다.
  - why: 문자열 경로 검사만으로는 symlink 교체와 검사 후 사용 경쟁을 막을 수 없다.
  - ✅ `ProjectFs::open`, `read`, `atomic_write`. `evidence: src/project_fs.rs:20`, `evidence: src/project_fs.rs:99`.
- **MUST** CLI 에이전트의 신규 실행과 대화 재개 모두 읽기 전용 정책을 유지한다.
  - why: Grove의 승인 경계를 외부 CLI 설정·hook·MCP로 우회해서는 안 된다.
  - ✅ Codex의 `sandbox_mode="read-only"`와 Claude Code의 `Read,Glob,Grep` 제한. `evidence: src/provider/cli.rs:90`.

## 스타일

현지 파일의 Rust·TypeScript·Python 작성 방식을 우선한다.
식별자는 기존 영문 API 이름을 따르고, 설명 주석은 주변 파일처럼 한국어를 사용한다.
의존성 업그레이드는 기능 변경에 섞지 않는다.

## 검증 범위

- **MUST** 검증 근거는 관련 소스·시험·설정·fixture가 유지되는 동안 재사용하고, 실패하거나 무효화된 검사만 다시 실행한다.
  - why: 무조건적인 전체 재검사와 오래된 성공 근거 재사용을 모두 피한다.
  - ✅ 선택 검사와 매번 격리된 E2E 서버 데이터를 사용한다. `evidence: scripts/build.py`, `evidence: web/e2e/global-setup.ts`.
- **MUST** 화면 배치·조작 진입점을 바꾸면 390px 모바일 스크린샷을 직접 확인하고, 기본 화면 예산은 `web/e2e/empty-chat-layout.spec.ts`로 검사한다.
  - why: 기능 시험이 모두 통과해도 버튼이 늘어나고 입력창이 떠 있는 화면이 그대로 배포된 적이 있다.
  - ✅ 새 기능의 진입점은 기존 메뉴·도구 패널 안에 넣고, 시험은 `openTool`·`openProjectFiles`처럼 실제 깊이를 따라 연다. `evidence: web/e2e/helpers.ts`.
  - ❌ 시험이 편하도록 진입 버튼을 기본 화면에 꺼내 두거나 예산 시험의 상한을 올린다.
- **MUST** 입력창·버튼 어댑터·탐색 밀도를 바꾸면 빈 화면만으로 검증하지 않는다. `web/e2e/chat-chrome.mobile.spec.ts`로 긴 대화의 중간/끝 스크롤·축소 후 복원한 viewport·라이트/다크에서 하단과 좌우 여백의 실제 hit target이 입력 영역인지 확인한다. 짧고 긴 제목 12개의 높이·글자 크기·왼쪽 정렬·노출량도 함께 검사한다.
  - why: 빈 화면 검사만 통과한 채 sticky 입력창 아래로 본문이 비치고, Astryx 내부 슬롯 때문에 짧은 목록 제목이 가운데로 돌아간 적이 있다.
  - ✅ 중앙 본문의 양방향 스와이프와 입력·텍스트 선택·가로 스크롤 예외는 `web/e2e/navigation-drawers.mobile.spec.ts`로 실제 터치 이벤트를 검사한다.

여러 대상을 지정할 때 `--rust`, `--vitest`, `--e2e`는 각각 한 번만 쓰고 뒤에 대상들을 나열한다.
E2E는 실제 서버와 빌드된 웹앱을 사용한다. API mock만으로 인증·복구·전송 경계를 검증했다고 하지 않는다.
relay·암호화 다중화·모바일 복귀 변경은 `python3 scripts/build.py test --relay-e2e`로 배포 없이 검증한다.
이 명령은 새 임시 데이터의 데몬·정적 웹·Miniflare relay·네트워크 주입 프록시를 띄우고 이번 실행이 만든 스택만 정리한다.
수동 시험은 `python3 scripts/relay_stack.py up --state /절대/경로/stack.json`으로 시작하며, 같은 상태 파일의 `net --cut`, `net --delay 100`, `net --blackhole on`으로 장애를 주입하고 `down`으로 종료한다.
`GROVE_RELAY_STATE`로 지정한 외부 대상은 자동 생성·종료하지 않는다. 로컬 통과가 Cloudflare 실제 경로의 검증을 대신하지 않으며, 원격 리소스 생성·배포 승인은 별도로 필요하다.
계약 변경 시 생성·drift 검사는 [RESPONSE_KEYS.md](RESPONSE_KEYS.md)를 따른다.
