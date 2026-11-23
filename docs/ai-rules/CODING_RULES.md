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
- **MUST** 일반 CLI 대화는 신규 실행과 재개 모두 서버 계정 권한을 쓴다. Codex `app-server`는 `danger-full-access`와 `never`, Claude Code는 `--dangerously-skip-permissions`와 `sandbox.enabled=false`를 사용한다.
  - why: 사용자가 요청한 Release·SSH·로컬 검사 작업을 CLI sandbox로 차단하지 않는다. CLI 자체 도구와 Grove의 승인형 도구 루프·`ProjectFs` API 경계는 별개다. OS·상위 실행 환경의 제한이나 관리 정책까지 해제하지는 않는다.
  - ✅ sandbox 실행용 bubblewrap·socat은 필요하지 않다. 취소는 변경 rollback이 아니며 중단 기록과 실제 파일을 확인한 뒤 계속한다. `evidence: src/provider/cli.rs`, `evidence: tests/real_cli.rs`.
- **MUST** 일반 CLI 대화의 전역·프로젝트 지침은 각 CLI의 기본 로더에 맡기고 Grove에서 중복 전달하지 않는다. CLI 없는 일반 대화에서는 Anthropic API가 `.claude/CLAUDE.md`와 `CLAUDE.md`를 실행 루트에서 읽는다. 프로젝트 밖 파일·개인 지침·import를 자동 수집하지 않고, 다른 API 모델·`grove exec`·내부 호출에도 자동 전달하지 않는다. 지침은 사용자 승인이나 도구 권한을 추가하지 않는다. `evidence: src/project_guidance.rs`, `evidence: src/runner.rs`.
  - ✅ 일반 대화의 스킬·장기 기억·hook·MCP도 외부 CLI의 원래 설정에 맡긴다. 스킬은 실제 CLI 목록을 조회해 `/이름`으로 호출한다. `evidence: src/provider/cli.rs`, `evidence: src/native_commands.rs`, `evidence: tests/native_integrations.rs`.
- **MUST** 예약 실행과 제목·요약·기억 등 내부 호출은 임시 작업 폴더에서 CLI 자체 도구·hook·MCP를 끄고 대화 세션을 남기지 않는다. 예약이 도구를 요청하면 Grove가 기존 허용 목록·승인 정책·토큰 한도로 판단하고 실행한다. `evidence: src/provider/cli.rs`, `evidence: src/runner.rs`.
- **MUST** Grove 일반 도구의 기본 모드는 `bypass`이며, `tools.mode`의 `ask`는 범위별로 선택할 수 있다. 모드를 바꿔도 명시적 deny, 보조 역할 제한, 위임의 별도 정책은 유지한다. `tools.full_access`는 기본으로 켜지며 `ask`에서 일반 도구를 포괄 허용한다. 모드와 별개로 `tools.full_access`가 켜지면 foreground·background 셸에 계정 환경변수를 상속하되 `GROVE_*`는 제외한다. 대기 중 전체 권한이 철회되면 자격증명 사용 계획을 실행하지 않는다. 파일 API의 `ProjectFs` 경계는 넓히지 않는다.
  - why: 일반 코딩·SSH·Release 작업은 반복 승인 없이 허용하면서, 서버 내부 설정이나 별도 승인 기능까지 포괄 허용으로 오인하지 않는다. 셸 자체는 프로젝트 밖·네트워크 접근이나 위험 명령을 차단하는 sandbox가 아니다.
  - ✅ 폐지한 `read_only` 값은 migration으로 상속 상태로 되돌린다. 나머지 저장 설정은 유지한다. 승인·제한 회귀 시험은 제한을 명시해 해당 정책을 검사한다. `evidence: src/settings.rs`, `evidence: src/approvals.rs`, `evidence: src/tools/shell.rs`, `evidence: src/tasks.rs`.

## 웹 UI 지속 작업

- **MUST** 오래 표시되는 상태는 정적 배경·테두리·아이콘을 기본으로 한다. 반복 모션이 필요하면 `transform`·`opacity`처럼 합성 단계에서 처리할 수 있는 속성을 우선하고, 프레임마다 React 상태 갱신·레이아웃·페인트가 발생하는 방식은 피한다. 무한 SVG `stroke-dashoffset`이나 크기·위치 애니메이션을 목록 행마다 두지 않는다. `will-change`도 모든 항목에 상시 적용하지 않는다.
  - ✅ 최근 목록은 정적 배경, 상단 원형 링은 호가 들어 있는 원 전체를 `transform`으로 회전시킨다. `evidence: web/app/components/workspace.stylex.ts`, `evidence: web/app/components/split-layout.stylex.ts`.
- **MUST** 숨겨진 브라우저 탭·영역·스크롤 밖 항목에서는 장식용 반복 작업을 멈춘다. 동시에 여러 영역에 표시되는 무거운 효과는 포커스된 영역에서만 움직이고, 나머지 표시 중인 영역과 `prefers-reduced-motion`에서는 같은 상태를 정적으로 전달한다. 종료·숨김·언마운트 시 해당 애니메이션·타이머·`requestAnimationFrame`을 정리한다. 화면 표시를 멈추더라도 서버 작업·상태 기록·완료 확인은 유지한다.
  - ✅ 덩굴은 활성 분할 영역에서만 움직이고, 포커스하지 않은 분할 영역은 정지 프레임을 사용한다. `evidence: web/app/components/session-activity/SessionActivityIndicator.tsx`.
- **MUST** 초 단위 표시처럼 갱신 주기가 같은 화면 타이머는 공유하고 마지막 구독자가 사라지면 멈춘다. 스트리밍처럼 빈번한 임시 갱신은 필요한 화면 범위에서 표시 주기에 맞춰 묶고 변경된 부분만 다시 그린다. 이 최적화로 최종 응답·상태 이벤트를 버리거나 순서를 바꾸지 않는다.
  - ✅ `evidence: web/app/state/secondTick.ts`, `evidence: web/app/state/store.ts`.
- **MUST** 지속 효과를 추가·변경하면 단일 화면뿐 아니라 여러 실행 세션·긴 목록과 숨김·포커스 전환·모션 줄이기에서 동작을 확인한다. 반복 작업이 생기는 변경이나 CPU 개선 작업은 Chromium DevTools Performance에서 해당 Grove 탭을 확인한 뒤, 같은 조건에서 초기 전환이 끝난 구간의 CPU·Script·Layout/Paint·합성 비용을 비교한다. 측정하지 못했으면 미측정으로 명시한다.

## 스타일

현지 파일의 Rust·TypeScript·Python 작성 방식을 우선한다.
식별자는 기존 영문 API 이름을 따르고, 설명 주석은 주변 파일처럼 한국어를 사용한다.
의존성 업그레이드는 기능 변경에 섞지 않는다.

## 검증 범위

- **MUST** 작업 범위의 테스트·검증이 실패하면 실패 보고만으로 끝내지 않는다. 원인을 확인하고 필요한 코드·시험·fixture·실행 환경을 바로잡은 뒤, 실패한 검사와 수정의 영향을 받는 검사를 다시 실행해 통과를 확인해야 완료다.
  - 실패를 감추기 위해 검사를 건너뛰거나 판정 기준을 낮추지 않는다. 시험이 현재 계약과 어긋났다면 근거를 확인하고 시험을 수정한다.
  - 외부 장애·권한·범위 밖 변경 때문에 정상화할 수 없으면 완료로 보고하지 않는다. 해결한 범위와 남은 실패 또는 미검증 범위, 필요한 조치를 구분해 알린다.
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
