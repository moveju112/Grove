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
- **MUST** 외부 CLI의 신규 실행과 대화 재개 모두 sandbox·대화형 권한 확인 없이 서버 계정 권한으로 실행한다. Codex 일반 대화는 `app-server`의 `sandbox_mode="danger-full-access"`·`approval_policy="never"`와 thread/turn의 같은 권한 설정을 사용한다. 제목·요약용 `exec`는 `--dangerously-bypass-approvals-and-sandbox`, Claude Code는 `--dangerously-skip-permissions`와 `sandbox.enabled=false`를 사용한다. 프로젝트 밖 파일·네트워크·로컬 소켓을 Grove가 CLI 옵션으로 제한하지 않는다.
  - why: 사용자가 요청한 Release·SSH·로컬 검사 작업을 CLI sandbox로 차단하지 않는다. CLI 자체 도구와 Grove의 승인형 도구 루프·`ProjectFs` API 경계는 별개다. OS·상위 실행 환경의 제한이나 관리 정책까지 해제하지는 않는다.
  - ✅ sandbox 실행용 bubblewrap·socat은 필요하지 않다. 취소는 변경 rollback이 아니며 중단 기록과 실제 파일을 확인한 뒤 계속한다. `evidence: src/provider/cli.rs`, `evidence: tests/real_cli.rs`.
- **MUST** 일반 대화의 전역·프로젝트 지침은 각 외부 CLI의 기본 로더에 맡긴다. Grove는 `AGENTS.md`·`CLAUDE.md`를 직접 읽어 중복 주입하거나 전달 모드를 제공하지 않는다. API 모델과 `grove exec`에도 지침 파일을 자동 주입하지 않는다.
  - ✅ 일반 대화의 장기 기억·hook·MCP도 외부 CLI의 원래 설정에 맡기며 Grove의 별도 관리·주입·실행 경로는 제공하지 않는다. 제목·요약 같은 내부 호출만 사용자 hook·MCP·설정을 제외한다. `evidence: src/provider/cli.rs`, `evidence: tests/native_integrations.rs`.
- **MUST** `tools.full_access`는 기본으로 켜진 일반 도구의 포괄 허용이다. 별도 설정 없이 파일 수정·셸 실행은 자동 승인하고 foreground·background 셸에 계정 환경변수를 상속하되 `GROVE_*`는 제외한다. 서버·프로젝트에서 명시적으로 끄거나 지정한 deny·read_only와 PC 제어·위임의 별도 정책은 유지하며, 대기 중 전체 권한이 철회되면 자격증명 사용 계획을 실행하지 않는다. 파일 API의 `ProjectFs` 경계는 넓히지 않는다.
  - why: 일반 코딩·SSH·Release 작업은 반복 승인 없이 허용하면서, 서버 내부 설정이나 별도 승인 기능까지 포괄 허용으로 오인하지 않는다. 셸 자체는 프로젝트 밖·네트워크 접근이나 위험 명령을 차단하는 sandbox가 아니다.
  - ✅ 기본값은 전체 허용이며 저장된 제한 설정은 덮어쓰지 않는다. 승인·제한 회귀 시험은 제한을 명시해 해당 정책을 검사한다. `evidence: src/settings.rs`, `evidence: src/approvals.rs`, `evidence: src/tools/shell.rs`, `evidence: src/tasks.rs`.
- **MUST** Computer Use는 소유자가 켠 서버 PC만 대상으로 하며, 관찰도 포함해 각 요청을 이번만 승인한다. CLI의 기본 MCP·hook과 별개로 Grove는 턴 한정 Computer Use MCP를 추가하며, 이 내부 연결의 승인 경계를 바꾸지 않는다.
  - ✅ `src/computer/`, `tests/computer.rs`, 격리 Xvfb 검사 `python3 tests/fixtures/computer_x11.py /절대/경로/grove`.

## 스타일

현지 파일의 Rust·TypeScript·Python 작성 방식을 우선한다.
식별자는 기존 영문 API 이름을 따르고, 설명 주석은 주변 파일처럼 한국어를 사용한다.
의존성 업그레이드는 기능 변경에 섞지 않는다.

## 검증 범위

- **MUST** 검증 근거는 관련 소스·시험·설정·fixture와 실행 조건이 유지되는 동안 재사용하고, 실패하거나 무효화된 검사만 다시 실행한다. 의존성 잠금 파일·도구/runtime 버전·관련 환경변수가 바뀌면 영향받는 검사만 다시 실행한다.
  - why: 무조건적인 전체 재검사와 오래된 성공 근거 재사용을 모두 피한다.
  - 근거는 명령·대상·관련 소스 상태(commit·관련 미커밋 변경 등)·실행 조건·결과를 대화나 기존 실행 로그에 남긴다. 비밀값은 기록하지 않으며, 별도 기록 파일을 의무화하지 않는다.
  - ✅ 선택 검사와 매번 격리된 E2E 서버 데이터를 사용한다. `evidence: scripts/build.py`, `evidence: web/e2e/global-setup.ts`.
- **MUST** 화면 배치·조작 진입점을 바꾸면 390px 모바일 스크린샷을 직접 확인하고, 기본 화면 예산은 `web/e2e/empty-chat-layout.spec.ts`로 검사한다.
  - why: 기능 시험이 모두 통과해도 버튼이 늘어나고 입력창이 떠 있는 화면이 그대로 배포된 적이 있다.
  - ✅ 새 기능의 진입점은 기존 메뉴·도구 패널 안에 넣고, 시험은 `openTool`·`openProjectFiles`처럼 실제 깊이를 따라 연다. `evidence: web/e2e/helpers.ts`.
  - ❌ 시험이 편하도록 진입 버튼을 기본 화면에 꺼내 두거나 예산 시험의 상한을 올린다.
- **MUST** 입력창·버튼 어댑터·탐색 밀도 변경은 `web/e2e/chat-chrome.mobile.spec.ts`, 모바일 서랍·스와이프 변경은 `web/e2e/navigation-drawers.mobile.spec.ts`로 회귀 검사한다. 재현 조건과 세부 판정은 해당 시험에 유지한다.
  - why: 빈 화면 검사만 통과한 채 sticky 입력창 아래로 본문이 비치고, Astryx 내부 슬롯 때문에 짧은 목록 제목이 가운데로 돌아간 적이 있다.

여러 대상을 지정할 때 `--rust`, `--vitest`, `--e2e`는 각각 한 번만 쓰고 뒤에 대상들을 나열한다.
E2E는 실제 서버와 빌드된 웹앱을 사용한다. API mock만으로 인증·복구·전송 경계를 검증했다고 하지 않는다.
relay·암호화 다중화·모바일 복귀 변경은 `python3 scripts/build.py test --relay-e2e`로 배포 없이 검증한다.
이 명령은 새 임시 데이터의 데몬·정적 웹·Miniflare relay·네트워크 주입 프록시를 띄우고 이번 실행이 만든 스택만 정리한다.
수동 시험은 `python3 scripts/relay_stack.py up --state /절대/경로/stack.json`으로 시작하며, 같은 상태 파일의 `net --cut`, `net --delay 100`, `net --blackhole on`으로 장애를 주입하고 `down`으로 종료한다.
`GROVE_RELAY_STATE`로 지정한 외부 대상은 자동 생성·종료하지 않는다. 로컬 통과가 Cloudflare 실제 경로의 검증을 대신하지 않으며, 원격 리소스 생성·배포 승인은 별도로 필요하다.
계약 변경 시 생성·drift 검사는 [RESPONSE_KEYS.md](RESPONSE_KEYS.md)를 따른다.
