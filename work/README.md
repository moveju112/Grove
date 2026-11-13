# 병렬 개발: 선정 → 독립 구현 → 일괄 통합

## 사용법
사용자는 메인 세션에 “남은 거 10개 뽑아줘”라고 요청한다.
통합 담당은 이 대화에 고정되지 않는다. 원본 프로젝트에서 다른 세션을 열고 `work/INTEGRATE.md`로 같은 역할을 수행할 수 있다.
통합 담당이 현재 변경·TODO·의존성을 확인하고 기준 커밋, 겹치지 않는 기능, worktree, 작업 문서와 시작 프롬프트를 준비한다.
수동 운영에서는 사용자가 각 워크스페이스에서 `work/START.md`의 공통 프롬프트를 보낸다. 현재는 사용자가 자동 순환을 승인했으므로 통합 담당이 준비된 workspace의 기능 세션도 시작한다.
`work/ENTRY.md`가 실제 Git top-level 경로와 브랜치를 대조해 번호 문서를 자동 선택한다. 사용자가 번호를 바꿔 붙여넣을 필요가 없다.
각 담당은 구현을 끝내면 자기 worktree의 `work/RESULT-NN.md`에 인계 내용을 남기고 종료한다.
일부 또는 전체 작업이 종료되면 사용자는 메인 세션에 `work/START.md`의 통합 프롬프트를 보낸다. 완료된 작업만 통합하고 나머지는 계속 진행한다.
통합 담당이 직접 인계 파일과 Git 상태를 읽으므로 사용자에게 결과 복사·실시간 중계를 요구하지 않는다.
관리·검증 전용 에이전트를 추가로 띄울 필요는 없다. 원본 프로젝트의 메인 세션 하나가 통합을 맡는다. 사용자가 부르는 “00 메인 세션”도 가능하며, 기존 00 원본 설정 기능 worktree와는 구분한다.
초기 배치는 06을 제외한 00~09, 총 9개 기능 담당이었다. 운영 목표는 활성 10개이며, 정리 직후 같은 흐름에서 목표 수까지 다음 번호로 보충한다. 다음 최초 번호는 10이며 기존 번호는 재사용하지 않는다.
통합·검증·TODO 반영 후 종료된 작업의 worktree와 Paseo 워크스페이스를 정리하고 다음 작업을 자동 준비한다. 세부 절차는 `work/INTEGRATE.md`가 정본이다.

## b01 고정 기준
- 기준 SHA: `c186b31ab62734c9f91803cf7848b639ad9871fb`.
- 원본 프로젝트: `/data/project/paseodog_opus`.
- 지시 문서: `/data/project/paseodog_opus/work/COMMON.md`와 번호별 문서.
- 이 문서는 원본 프로젝트에만 있으므로 기능 세션은 위 절대 경로로 읽는다. 원본 프로젝트는 편집하지 않는다.
- 소스 공통 파일에는 준비용 가짜 구현을 넣지 않았다. 미연결 모듈은 제품 기능 완료가 아니라 통합 대기다.
- 03은 parser 의존성이 없는 assistant 이름·사진 표시로 변경했다. 코드 구조 분석은 이번 배치 밖이다.
- 기존 개발 세션에서 같은 기능의 연속 개발을 동시에 재개하지 않는다.
- 사용자 결정으로 06 작업은 취소됐고 빈 워크스페이스도 제거했다. 재생성·재배정·통합하지 않는다. 다음 배치는 원본 `TODO.md`의 최신 제외 결정을 따른다.

## 준비 완료된 워크스페이스
b02 기준 SHA: `bc797b36cd0c09ce41eb675d7d152ce95ffa7ef1`. 지시 문서는 `/data/project/paseodog_opus/work/COMMON.md`와 번호별 문서다.

| 번호 | 브랜치 | worktree 절대 경로 | workspace ID | 기능 |
|---|---|---|---|---|
| 27 | parallel/b02-pwa-recovery | /home/ubuntu/.local/share/paseodog/paseo/worktrees/0q796rug/b02-27-pwa-recovery | `wks_9a7c204337ac8249` | PWA 호환·오프라인·다중 탭 복구 (14 이월, `551f551` 기준) |
| 30 | parallel/b02-navigation-context | /home/ubuntu/.local/share/paseodog/paseo/worktrees/0q796rug/b02-30-navigation-context | `wks_73d51bb0a7f9b465` | 호스트·프로젝트·세션 현재 위치와 탐색 (`551f551` 기준) |
| 34 | parallel/b02-agent-policy | /home/ubuntu/.local/share/paseodog/paseo/worktrees/0q796rug/b02-34-agent-policy | `wks_145becb7b1464f70` | 역할별 위임 허용 정책 (`a340d2bccd7860d8452a5513b59c7f8ac215178c` 기준, branch/HEAD/clean 확인, 미시작) |
| 35 | parallel/b02-tool-outputs | /home/ubuntu/.local/share/paseodog/paseo/worktrees/0q796rug/b02-35-tool-outputs | `wks_242996cfa36e0a48` | 큰 도구 결과 파일 보관·범위 조회 (`11e51d6efaf0b10a6f0c2c682da7bb1db5738955` 기준, branch/HEAD/clean 확인, 미시작) |
| 36 | parallel/b02-mcp-oauth | /home/ubuntu/.local/share/paseodog/paseo/worktrees/0q796rug/b02-36-mcp-oauth | `wks_912a0803920b11fa` | HTTP MCP OAuth 연결·명시적 갱신 (`11e51d6efaf0b10a6f0c2c682da7bb1db5738955` 기준, branch/HEAD/clean 확인, 미시작) |
| 37 | parallel/b02-settings-links | /home/ubuntu/.local/share/paseodog/paseo/worktrees/0q796rug/b02-37-settings-links | `wks_c1844db43036c46f` | 비동기 설정 직접 링크·pane 경계 (`292cf1aff5305b4c039613dfd4266f416cef5f03` 기준, branch/HEAD/clean 확인, 미시작) |
| 38 | parallel/b02-local-models | /home/ubuntu/.local/share/paseodog/paseo/worktrees/0q796rug/b02-38-local-models | `wks_97add2973aa8639a` | 선택적 로컬 HTTP 모델 연결·상태·목록 (`eb841bb51dfde92a714f48189d02b0f568ad23c0` 기준, branch/HEAD/clean 확인, 미시작) |
| 39 | parallel/b02-definition-updates | /home/ubuntu/.local/share/paseodog/paseo/worktrees/0q796rug/b02-39-definition-updates | `wks_10afe7eb9a765704` | 기본 정의 수정본 보존·비교·선택 적용 (`eb841bb51dfde92a714f48189d02b0f568ad23c0` 기준, branch/HEAD/clean 확인, 미시작) |
| 40 | parallel/b02-deferred-tools | /home/ubuntu/.local/share/paseodog/paseo/worktrees/0q796rug/b02-40-deferred-tools | `wks_bd0e6e72588493d4` | 도구 schema 지연 로딩·모델 입력 안정성 (`f4a4a702bcd342e159efe8801d429ad181391651` 기준, branch/HEAD/clean 확인, 미시작) |
| 41 | parallel/b02-agent-overview | /home/ubuntu/.local/share/paseodog/paseo/worktrees/0q796rug/b02-41-agent-overview | `wks_720a531310d51814` | 기본 역할·모델 상속·지침·실행 규칙 개요 (`f4a4a702bcd342e159efe8801d429ad181391651` 기준, branch/HEAD/clean 확인, 미시작) |

공통 연결: route/module 등록(25·28·29·33), 독립 migration(28·29), Settings의 서로 다른 mount(25·33). 27은 PWA/auth·작업 차단, 28 스킬, 29 hook, 30 위치 안내다. Workspace 생성 버튼은 22, 위치 mount는 30 소유다. `approvals.rs`의 hook 분기는 29, 일반 shell cwd 계획은 31로 분리한다. `SessionView`의 compaction 분기는 32, fallback 표시 분기는 33이다. `runner`의 hook 호출은 29, 모델 접수/오류 전환은 33 소유다.

자동 순환 예약은 메인 세션 대상 `5848102f`(3분, 만료·횟수 제한 없음) 하나다. 20개 증설은 취소됐고 목표는 활성 기능 workspace 10개다. 31~33은 23·24·26 정리의 세 자리, 34는 28 정리의 한 자리 보충이며 증설이 아니다. 21·25의 제공자 오류는 기존 세션에 1회 재개 요청을 접수했으며 재실패를 자동 반복하지 않는다. 관리 메타데이터 쓰기는 직렬화하고 진행 중 세션은 건드리지 않는다. 34는 backlog 3개 이상인 동안 신규 시작하지 않으며, 생성 시 개발 fast=false 명시·반환 확인이 필요하다.

## 명시적 후속 요청 우선순위
신규 기능보다 verified idle continuation을 우선하며, 기존 기능 running/initializing 총 4개를 넘겨 시작하지 않는다. 이 요청은 provider 시스템 오류 retry가 아니므로 retry count를 초기화하지 않는다.

| 번호 | 분류·접수 | 남은 일·다음 조건 |
|---|---|---|
| 21 | blocked · `d369ef8` 부분 통합·지원 형식 인수 완료 | 공유 환경 복구 후 typecheck·Vitest 12개·E2E 4개 및 통합 인수 통과, Rust 23개 근거 재사용. inline TOML parser 승인/재사용 parser 제공이 해제 조건이며 RESOURCE-018은 미완료. 같은 blocker로 재개하지 않음 |
| 22 | ready · `30a5f785` 후속 통합·인수 완료 | 원래 담당이 native modal Tab 이탈을 재현·수정, 기능 E2E 8개 통과. 통합 공통 경계 포함 E2E 16개·Rust 4개·타입 통과. 27의 향후 PWA 결합은 27 담당의 남은 인수로 보존 |
| 27 | needs-continuation · 기존 세션 후속 접수、실행 중 | 22 `e28dbdf`를 27 branch의 `8da340d`에 동기화한 뒤 기존 세션 `dd2a07fa-fd60-4bfe-ab70-0d3ded54d983`에 한 번 접수。개발 fast=false 명시·재조회 확인。최신 원본 COMMON·27 소유 범위·유효 근거 보존과 structured handoff를 전달했으며 실제 구현·검증 완료는 미확인 |
| 31 | ready · `997c061` 후속 통합·Linux 인수 완료 | 기존 Rust 42개·웹 근거 보존, 기능 E2E 14개 통과. 통합 Rust 8개·타입·E2E 5개 및 29 hook 결합 인수 완료. Windows/macOS 실측은 SETTINGS-011에 유지 |
| 33 | ready · `2127559` 통합·현재 공통 경계 인수 완료 | 기능 Rust 33·웹 단위 3·브라우저 1개 근거 보존. 현재 hook/runner·compaction 공존 인수도 통과. MODEL-019/020 완료, SETTINGS-004 역할별 나머지는 유지 |
| 29 | ready · `e8695cb` 통합·지원 범위 인수 완료 | 기능 E2E 7개와 통합 hook/cwd/fallback 인수 통과. 일반 API가 없는 zsh를 먼저 거절하는 통합 시험 충돌은 격리 DB의 과거 설정 fixture로 분리했다. 미지원 이벤트·플랫폼은 RESOURCE-016/017 및 이월에 보존 |
| 25 | ready · `f9df069` 통합·인수 완료 | 기능 update-settings E2E 4개 및 통합 검사 통과. SETTINGS-016 완료; 정책 저장과 실제 자동 설치를 구분. 기존 오류 retry count=1은 재사용하지 않음 |

## 현재 통합 인수
- 22·28·30의 기존 유효 Rust 35개·웹 단위 114개 근거는 재사용했다. 28의 스킬 관리/선택 E2E 3개와 30의 위치/부모 탐색·pane focus·반응형 회귀 7개가 실제 통합 서버에서 통과했다.
- 공통 workspace E2E는 서로 다른 27개 통과, 설정 직접 링크 1개 실패다. protocol 차단 시험은 이미 비활성화된 버튼 클릭을 기다리는 낡은 기대를 비활성 상태·키보드 전송 차단·초안 보존으로 수정해 통과했다. 수정 중 `frames`를 함수로 잘못 호출한 TypeError도 있었으며 그 호출을 제거하고 typecheck·영향 시험을 통과했다. 성공한 기존 시험은 반복하지 않았다.
- 근거는 `/home/ubuntu/.local/share/paseodog/mixdog/data/shell-output/shell_2d71780d.stdout`, `/home/ubuntu/.local/share/paseodog/mixdog/data/shell-output/shell_1ec03650.stdout`, `/home/ubuntu/.local/share/paseodog/mixdog/data/shell-output/shell_3cdb03b6.stdout`, `/home/ubuntu/.local/share/paseodog/mixdog/data/shell-output/shell_3bf22535.stdout`와 같은 절대 경로의 stderr 로그다. 총 38개 선택 E2E 중 서로 다른 37개 통과·1개 실패이며, 마지막 미실행 1개는 별도 실행해 통과했다. 전체 선택 명령의 성공으로 바꾸지 않는다.
- 미해결 설정 직접 링크는 `SETTINGS-021`을 다시 열었다. Settings/ScopedSettings는 이번 22·28·30 통합 diff에서 바뀌지 않았지만 원인·통합 인과는 미확정이다. 관련 없는 스킬 인수·정리는 진행하고, 30의 전체 UI 통합 완료 판단은 이 공통 경계 조사와 함께 보존한다. 22의 focus 실패는 아래 후속 인수에서 해소됐다.
- 후속 묶음 22·32는 `442e020` 입력에서 Rust compaction_details 4개·typecheck·E2E 16개가 통과했다. 생성 dialog 넓은/좁은 화면·응답 유실, 압축 상세·원문 이동, sidebar·프로젝트 복구·responsive 공통 경계를 인수했다. 코드 변경 없는 기존 기능 검사 근거는 재사용했다. 로그: `/home/ubuntu/.local/share/paseodog/mixdog/data/shell-output/shell_70163db4.stdout`와 `/home/ubuntu/.local/share/paseodog/mixdog/data/shell-output/shell_70163db4.stderr`. 이전 focus 실패는 해소됐고 설정 직접 링크 실패는 별개로 유지한다. 22·32의 코드·RESULT·TODO는 원본에 보존했으며 정리 전 정확한 workspace·종료·clean·ancestry를 대조했다.
- 이어 완료된 31은 `291ec83` 통합 입력에서 exec_cwd Rust 8개·typecheck·exec-cwd/exec-settings E2E 5개가 통과했다. 기능 workspace의 유효 Rust 42개·Vitest 3개·브라우저 14개 근거를 재사용했다. 로그: `/home/ubuntu/.local/share/paseodog/mixdog/data/shell-output/shell_8c76a313.stdout`와 `/home/ubuntu/.local/share/paseodog/mixdog/data/shell-output/shell_8c76a313.stderr`. Windows/macOS 미검증으로 SETTINGS-011은 체크하지 않고, 29 통합 시 일반 cwd와 hook 계획 분리 인수도 보존한다.
- 22·32·31 정리의 빈자리는 35·36·37로 보충해 기능 workspace 총 10개를 유지했다. 34~37은 준비 상태이며 신규 시작 없이 기존 후속·인수를 우선한다. 설정 직접 링크 실패의 수정 소유는 `work/37.md`에 배정했고 실제 수정 전까지 SETTINGS-021은 미완료다. 25·29·33 후속과 진행 중 27의 최종 통합 인수는 남아 있다.
- 21·33의 `bf635ad4` 통합 입력에서 fallback Rust 13개·typecheck·model-fallback/compaction-details/source-settings E2E 8개가 통과했다. source 조회의 기존 Rust 23개·단위 12개와 fallback 기능 Rust 33개·단위 3개 근거는 재사용했다. 현재 runner 도구/예산 경계와 32 compaction 표시 공존을 인수했으며 29 hook은 아직 실행 중이라 향후 결합 검사를 남긴다. 로그: `/home/ubuntu/.local/share/paseodog/mixdog/data/shell-output/shell_e44c8e15.stdout` 및 `/home/ubuntu/.local/share/paseodog/mixdog/data/shell-output/shell_e44c8e15.stderr`. 21은 승인 blocker를 TODO·이월에 보존하고 반복 재개하지 않는다. 별도 throughput 담당이 새 검증 실행기·AGENTS/INTEGRATE/COMMON 계약을 소유하므로 인계 전 해당 경계는 편집하지 않는다.
- 25·29 통합 `58a79e3`의 첫 검사에서 migration 7개·exec_cwd 8개는 통과했고 hook 1개는 실패했다. 일반 셸 설정 API가 없는 zsh를 거절하는 31 계약과 과거 시험의 설정 성공 기대가 충돌했다. 제품 검증을 낮추지 않고 격리 DB에 이전 환경의 zsh 설정을 준비해 hook 자체 미지원 차단을 보존했다. 실패 로그는 `/home/ubuntu/.local/share/paseodog/mixdog/data/shell-output/shell_07c12ec3.stdout` 및 `/home/ubuntu/.local/share/paseodog/mixdog/data/shell-output/shell_07c12ec3.stderr`; 당시 남은 Rust targets·typecheck·E2E는 미실행이었다.
- 인수한 고정 candidate 실행기·시험·AGENTS/COMMON/INTEGRATE delta는 소스와 5개 파일이 바이트 단위 일치했고 `48afb71`에 반영했다. 인계의 동일 입력 unittest 10개 통과 근거를 재사용했다. 원본 규칙 변경 구간을 실제 읽었고 기존 heartbeat `5848102f`의 매 진입 INTEGRATE 재로딩 계약을 유지했다. 새 heartbeat·기능 세션은 만들지 않았다.
- 수정 candidate `43a51d0055a41fe889692fdb04a5e5b204eebf89`를 새 실행기로 독립 clone 검증했다. hook_execution 10·model_fallback 13·update_settings 5, typecheck, hook-execution/exec-cwd/model-fallback/update-settings E2E 10개 통과. migration 7·cwd 8과 기능 웹 단위 근거는 재사용했다. 완료 직후 원본 clean·정확한 HEAD에서 `reusable=true`, 원래 returncode 0을 확인했다. job `/home/ubuntu/.cache/grove-validation/validation-e_dw7k40/state.json`과 `output.log`를 보존한다. 이후 문서만 바뀌면 자동 reusable 판정과 별개로 관련 제품 입력 불변을 대조한다. 실제 Rust·브라우저 경로 적용은 완료했으며 처리량 개선률은 측정하지 않았다.
- 21·33과 25·29 정리의 네 자리는 38~41로 보충해 기능 workspace 10개를 유지했다. 이번 인계 적용 중에는 명시 요청대로 새 heartbeat·기능 세션을 만들지 않았다. 27의 PWA 후속과 30/37의 설정 직접 링크 인수는 별도 대기이며 미완료 TODO를 유지한다.

## 완료·정리 이력
통합 담당은 정리 전에 통합 SHA·검증·보존 근거를 기록하고, 서비스 결과 확인 후 정리 상태를 갱신한다.
새 작업을 준비하면 보충 번호를 기록한다. 재실행 시 이미 보충한 자리를 중복 생성하지 않는다.
06의 사용자 취소는 보충 대상 완료로 세지 않는다. 아래 정리 대상은 `53f634b`에 코드·인계·TODO와 통합 연결이 보존돼 있다. 02의 실제 원격 호스팅·TLS 검증은 미실행이며 `WEB-003`은 미완료로 유지한다.
00·01·04·07·08은 사용자 요청으로 남은 작업을 `master`에서 이어 하도록 정리했다. 브랜치 코드·RESULT는 통합 SHA에 보존돼 있고, 각 RESULT의 미연결·미검증 항목과 해당 TODO `[ ]`는 그대로 남는다. 08은 `31585a2`에서 도구 목록·승인 화면에 연결했지만 HTML 본문 추출이 미지원이라 `INTEGRATION-002`는 미완료다.

| 번호 | 작업 브랜치·tip | 통합 SHA | RESULT 경로·검증 근거 | workspace ID·절대 경로 | 정리 상태 | 보충 번호 |
|---|---|---|---|---|---|---|
| 25 | `parallel/b02-update-settings` · `f9df06987637afc8c6c8b74e702a0ae489cedf8e` | `502ef6c` | `work/RESULT-25.md`; 기능 Rust/단위/E2E와 고정 candidate 43a51d0의 Rust 28/타입/E2E 10 통과. 실제 자동 설치는 비목표로 보존 | `wks_9ec8fd34396cf19a` · `/home/ubuntu/.local/share/paseodog/paseo/worktrees/0q796rug/b02-25-update-settings` | workspace·종료 세션 archive, 디렉터리·Git 등록·활성 목록 제거 확인; 브랜치 유지 | 40 |
| 29 | `parallel/b02-hook-execution` · `e8695cbeaba3ce56d48af7633c546c508c6c0a31` | `502ef6c` | `work/RESULT-29.md`; 지원 범위 인수·migration 7·cwd 8 및 고정 candidate 검사 통과. 실패/수정과 미지원 범위는 TODO·이월·로그 보존 | `wks_31bb4a6cdc6ff8bc` · `/home/ubuntu/.local/share/paseodog/paseo/worktrees/0q796rug/b02-29-hook-execution` | workspace·종료 세션 archive, 디렉터리·Git 등록·활성 목록 제거 확인; 브랜치 유지 | 41 |
| 21 | `parallel/b02-source-skills-hooks` · `d369ef87845d36f391b4e747c90f6c09b31ed409` | `339f516` | `work/RESULT-21.md`; Rust 23·단위 12·기능 E2E 4 및 통합 관련 E2E 통과. TOML parser 승인 blocker는 RESOURCE-018·이월에 보존 | `wks_ee49ecc425d4a36e` · `/home/ubuntu/.local/share/paseodog/paseo/worktrees/0q796rug/b02-21-source-skills-hooks` | workspace·종료 세션 2개 archive, 디렉터리·Git 등록·활성 목록 제거 확인, 브랜치 유지 | 38 |
| 33 | `parallel/b02-model-fallback` · `21275590c0fae74ce1dacb61803085ecb166a639` | `339f516` | `work/RESULT-33.md`; 기능 Rust 33·단위 3·E2E 1 및 통합 Rust 13/타입/관련 E2E 8 통과; 향후 hook 결합 보존 | `wks_e0883b94183c3f2a` · `/home/ubuntu/.local/share/paseodog/paseo/worktrees/0q796rug/b02-33-model-fallback` | workspace·종료 세션 archive, 디렉터리·Git 등록·활성 목록 제거 확인, 브랜치 유지 | 39 |
| 31 | `parallel/b02-exec-cwd` · `997c061f5c51ebda94b7a419b3db278222e2959d` | `b95dad4` | `work/RESULT-31.md`; Linux Rust 42·단위 3·기능 E2E 14·통합 Rust 8/타입/E2E 5 통과. 플랫폼·hook 결합은 SETTINGS-011과 이월에 보존 | `wks_fe83bf0ff80fb523` · `/home/ubuntu/.local/share/paseodog/paseo/worktrees/0q796rug/b02-31-exec-cwd` | workspace·종료 세션 archive, 디렉터리·Git 등록·활성 목록 제거 확인; 브랜치 유지 | 37 |
| 22 | `parallel/b02-create-entry` · `30a5f785cc8628e4b24759837fc49a8cbecae5c2` | `a453f18` | `work/RESULT-22.md`; dialog 후속 단위 35·기능 E2E 8·통합 선택 E2E 16·타입 통과, 기존 Rust 근거 재사용 | `wks_e30bd8e9163a7bb1` · `/home/ubuntu/.local/share/paseodog/paseo/worktrees/0q796rug/b02-22-create-entry` | workspace·종료 세션 archive, 디렉터리·Git 등록·활성 목록 제거 확인; 브랜치 유지 | 35 |
| 32 | `parallel/b02-compaction-details` · `00e06429dc728baa940581f3cfc1bb20828f2836` | `a453f18` | `work/RESULT-32.md`; Rust 신규 4·기존 15·단위 14·기능 E2E 3·통합 E2E 16·타입 통과 | `wks_101ba29980186bf0` · `/home/ubuntu/.local/share/paseodog/paseo/worktrees/0q796rug/b02-32-compaction-details` | workspace·종료 세션 archive, 디렉터리·Git 등록·활성 목록 제거 확인; 브랜치 유지 | 36 |
| 28 | `parallel/b02-skill-management` · `9383ff0fd7d405606d2fe72fd4e6412bdc779eb2` | `07bbd7b` | `work/RESULT-28.md`; Rust 관리 11·skills 17·store 7·웹 단위/타입 및 스킬 관리/선택 E2E 3개 통과. 별도 설정 직접 링크 실패는 SETTINGS-021로 보존 | `wks_e343b3a56e3a22d6` · `/home/ubuntu/.local/share/paseodog/paseo/worktrees/0q796rug/b02-28-skill-management` | workspace·종료 세션 archive, 디렉터리·Git 등록 제거 확인; 브랜치 유지 | 34 |
| 02 | `parallel/b01-web-base` · `7de966564c3d426f2a90e6157c5874157318b137` | `53f634b` | `work/RESULT-02.md`; 서버 2개, base/worker/Pages 단위 52개, 루트·하위 경로 E2E 4개 및 기존 PWA 회귀 통과 | `wks_e675c092ea9c3feb` · `/home/ubuntu/.local/share/paseodog/paseo/worktrees/0q796rug/b01-02-web-base` | workspace·종료 세션 archive, 디렉터리·Git 등록 제거 확인; 브랜치 유지 | 미배정 |
| 03 | `parallel/b01-assistant-identity` · `df94a3056ab58759c488aaecc198f4b7a79f0c14` | `53f634b` | `work/RESULT-03.md`; 단위 50개, identity E2E 3개 및 기존 봇 회귀 통과 | `wks_df7a705fd9c77bdb` · `/home/ubuntu/.local/share/paseodog/paseo/worktrees/0q796rug/b01-03-assistant-identity` | workspace·종료 세션 archive, 디렉터리·Git 등록 제거 확인; 브랜치 유지 | 미배정 |
| 05 | `parallel/b01-usage-ui` · `fd1e3bf4fbd754b2fe6bd963f049042cf9d9e17f` | `53f634b` | `work/RESULT-05.md`; 단위 7개, 사용량 E2E 3개 통과 | `wks_4eb1e336ad21d6c9` · `/home/ubuntu/.local/share/paseodog/paseo/worktrees/0q796rug/b01-05-usage-ui` | workspace·종료 세션 archive, 디렉터리·Git 등록 제거 확인; 브랜치 유지 | 미배정 |
| 09 | `parallel/b01-approval-ui` · `ab5413d2ed6fcd1e543d992bbc7872818d5d9546` | `53f634b` | `work/RESULT-09.md`; 단위 27개, 승인 E2E 4개 및 workspace 회귀 통과 | `wks_424ce685e3fd8e91` · `/home/ubuntu/.local/share/paseodog/paseo/worktrees/0q796rug/b01-09-approval-ui` | workspace·종료 세션 archive, 디렉터리·Git 등록 제거 확인; 브랜치 유지 | 미배정 |
| 00 | `parallel/b01-source-settings` · `241ff11b293eb581ac929717f394b16ca82d02e7` | `53f634b` | `work/RESULT-00.md`; 원본 설정 시험 10개·화면 단위 5개 통과, 화면 연결은 남음 | `wks_91d76c31ae4ecfea` · `/home/ubuntu/.local/share/paseodog/paseo/worktrees/0q796rug/b01-00-source-settings` | 남은 작업 `master` 이관 후 archive; 브랜치 유지 | 미배정 |
| 01 | `parallel/b01-skills` · `44734ca2000a41f95a452735d76663ff286c49fb` | `53f634b` | `work/RESULT-01.md`; 스킬 시험 12개·화면 단위 7개 통과, 모델 경로 연결은 남음 | `wks_16d610705b66acbc` · `/home/ubuntu/.local/share/paseodog/paseo/worktrees/0q796rug/b01-01-skills` | 남은 작업 `master` 이관 후 archive; 브랜치 유지 | 미배정 |
| 04 | `parallel/b01-image-read` · `787b4f14f1334fc91feebea7552a721dcaecd627` | `53f634b` | `work/RESULT-04.md`; 이미지 읽기 11개·첨부 15개 통과, 모델 경로 연결은 남음 | `wks_4d1f2e6439fd1201` · `/home/ubuntu/.local/share/paseodog/paseo/worktrees/0q796rug/b01-04-image-read` | 남은 작업 `master` 이관 후 archive; 브랜치 유지 | 미배정 |
| 07 | `parallel/b01-linux-service` · `37b55bfbe34121592feecf62d015680d29fa09eb` | `53f634b` | `work/RESULT-07.md`; `scripts/test_user_service.py` 통과, 실제 서비스 검증은 남음 | `wks_9b5efc61967806b7` · `/home/ubuntu/.local/share/paseodog/paseo/worktrees/0q796rug/b01-07-linux-service` | 남은 작업 `master` 이관 후 archive; 브랜치 유지 | 미배정 |
| 08 | `parallel/b01-web-fetch` · `840c51ac51c140a64c6994fd10a7e612193302cf` | `31585a2` | `work/RESULT-08.md`; web_fetch 28개·승인 화면 20개 통과, HTML 본문 추출·실제 네트워크 검증은 남음 | `wks_b3a27f07ded8d599` · `/home/ubuntu/.local/share/paseodog/paseo/worktrees/0q796rug/b01-08-web-fetch` | 남은 작업 `master` 이관 후 archive; 브랜치 유지 | 미배정 |
| 18 | `parallel/b02-terminal-input` · `e341ad1d348c9142a1a1ff14cc3713255cc65e53` | `fc0de9b` | `work/RESULT-18.md`; 단위 27개·typecheck, 터미널 입력·캡처·기존 모바일 E2E 7개 통과(모바일 사이드바 열기·보조키 접근성 이름 기대값 통합 수정) | `wks_d50b41aa00282a33` · `/home/ubuntu/.local/share/paseodog/paseo/worktrees/0q796rug/b02-18-terminal-input` | workspace·종료 세션 archive, 디렉터리 제거 확인; 브랜치 유지 | 20 |
| 10 | `parallel/b02-source-settings-wire` · `3c5b307` | `4cb228c` | `work/RESULT-10.md`; `source_settings` Rust·단위·`source-settings` E2E 통과 | `wks_b997271e9d51ba39` | archive·디렉터리 제거 확인; 브랜치 유지 | 21 |
| 13 | `parallel/b02-sidebar-status` · `0c07593` | `4cb228c` | `work/RESULT-13.md`; lib 4개·단위·`sidebar-status`·workspace·최근 탐색 E2E 통과(strict 타입 오류 통합 수정, workspace E2E locator 범위 축소) | `wks_b6450d7ae495aae8` | archive·디렉터리 제거 확인; 브랜치 유지 | 22 |
| 15 | `parallel/b02-turn-timing` · `3b6be6f` | `4cb228c` | `work/RESULT-15.md`; 단위·`turn-timing` E2E(시계 ±5분·재시작) 통과(탭 버튼 이름 locator 통합 수정) | `wks_16baa50b76c83e71` | archive·디렉터리 제거 확인; 브랜치 유지 | 23 |
| 16 | `parallel/b02-first-start` · `90aa51f` | `4cb228c` | `work/RESULT-16.md`; `first_start` 9개·기존 `cli`·`api` 27개 통과 | `wks_3e03fb86d3452409` | archive·디렉터리 제거 확인; 브랜치 유지 | 24 |
| 17 | `parallel/b02-hooks-config` · `3188cf5` | `4cb228c` | `work/RESULT-17.md`; `hooks` 5개·단위 5개·`hooks` E2E 4개 통과 | `wks_d3b07706e87b88fc` | archive·디렉터리 제거 확인; 브랜치 유지 | 25 |
| 19 | `parallel/b02-git-stash` · `b40e805` | `4cb228c` | `work/RESULT-19.md`; `git_stash` 9개·`git`·`git_receipts`·단위 4개·`git-stash`·`git-recovery` E2E 통과 | `wks_69960bfc3714a13f` | archive·디렉터리 제거 확인; 브랜치 유지 | 26 |
| 11 | `parallel/b02-skills-wire` · `b171653` | `af0ad28` | `work/RESULT-11.md`; skills 17개·store 7개·화면 단위 7개·타입·스킬 E2E 2개 통과. hook migration 뒤에 skill migration 추가, Composer mount 보존 | `wks_98d3177f6bbf5a31` · `/home/ubuntu/.local/share/paseodog/paseo/worktrees/0q796rug/b02-11-skills-wire` | workspace·종료 세션 archive·디렉터리 제거 확인; 브랜치 유지 | 27 |
| 12 | `parallel/b02-image-read-wire` · `b575b5d` | `af0ad28` | `work/RESULT-12.md`; image_read 16개·attachments 15개·HTTP 6개·tool_batches 3개·웹 capability·타입 통과. runner 첨부→프로젝트 이미지 복원과 스킬 지침 조립 양쪽 보존 | `wks_13f52f7f5562939c` · `/home/ubuntu/.local/share/paseodog/paseo/worktrees/0q796rug/b02-12-image-read-wire` | workspace·종료 세션 archive·디렉터리 제거 확인; 브랜치 유지 | 28 |
| 14 | `parallel/b02-pwa-lifecycle` · `4577b43` | `af0ad28` | `work/RESULT-14.md`; lifecycle 12개·API 18개·PWA/연결/응답 유실/승인 포함 E2E 22개 및 루트·`/grove/` 배포 E2E 4개 통과. 공통 변경 요청 경계 누락을 실패 시험으로 재현 후 수정 | `wks_043964eeb7dd683e` · `/home/ubuntu/.local/share/paseodog/paseo/worktrees/0q796rug/b02-14-pwa-lifecycle` | workspace·종료 세션 archive·디렉터리 제거 확인; 브랜치 유지 | 29 |
| 20 | `parallel/b02-external-editor` · `1b1e438` | `af0ad28` | `work/RESULT-20.md`; 격리 7환경을 실행하는 Rust driver·타입 계약 2개, 웹 단위 4개·타입·외부 편집기 E2E 4개 통과. 실제 GUI·Windows/macOS 미검증 | `wks_7abac678efb30e9a` · `/home/ubuntu/.local/share/paseodog/paseo/worktrees/0q796rug/b02-20-external-editor` | workspace·종료 세션 archive·디렉터리 제거 확인; 브랜치 유지 | 30 |
| 23 | `parallel/b02-tab-close` · `a8cfe5c` | `b59d9f7` | `work/RESULT-23.md`; 신규 Rust 7개·기존 회귀、tab/context/browser 종료 E2E 9개 통과 | `wks_2953ff0df5ee7bb2` · `/home/ubuntu/.local/share/paseodog/paseo/worktrees/0q796rug/b02-23-tab-close` | workspace·종료 세션 archive·디렉터리 제거 확인; 브랜치 유지 | 31 |
| 24 | `parallel/b02-exec-settings` · `93a61c0` | `b59d9f7` | `work/RESULT-24.md`; exec_settings 4개·settings/tasks 회귀·단위 3개·타입·E2E 3개 통과。fieldset 자체 기대만 제거하고 radio 비활성 검사 유지 | `wks_4a12061aaef2c918` · `/home/ubuntu/.local/share/paseodog/paseo/worktrees/0q796rug/b02-24-exec-settings` | workspace·종료 세션 archive·디렉터리 제거 확인; 브랜치 유지 | 32 |
| 26 | `parallel/b02-browser-caps` · `7fb45ba` | `b59d9f7` | `work/RESULT-26.md`; 신규 단위 11개·알림 회귀·타입·빌드·Chromium E2E 4개 통과 | `wks_9d9878d624297a99` · `/home/ubuntu/.local/share/paseodog/paseo/worktrees/0q796rug/b02-26-browser-caps` | workspace·종료 세션 archive·디렉터리 제거 확인; 브랜치 유지 | 33 |

b01 정리 뒤 활성 0개 → 목표 10개로 보충: 10~19 (`bc797b3`). 00·01·04 이월은 10·11·12로 배정했다.

## 이월 작업
정리된 작업의 남은 연결·검증이다. 다음 보충에서 우선 배정 후보로 쓴다. 세부 조건은 각 RESULT가 정본이다.

| 출처 | 남은 작업 | 근거 | 배정 |
|---|---|---|---|
| 00 | 원본 설정 조회의 서버 라우트·설정 화면 연결 | `work/RESULT-00.md` | 10 |
| 01 | 스킬 선택·적용의 모델 경로 연결 | `work/RESULT-01.md`, `work/RESULT-11.md` | 11에서 통합·검증 완료 |
| 04 | 이미지 읽기 도구의 모델 입력 경로 연결 | `work/RESULT-04.md`, `work/RESULT-12.md` | 12에서 통합·검증 완료 |
| 07 | Linux 사용자 서비스의 실제 설치·재시작 검증 (외부 환경 필요) | `work/RESULT-07.md` | 보류: 실제 systemd 사용자 서비스 환경에서 검증 필요 |
| 08 | HTML 본문 추출 방식 결정·실제 네트워크 검증 (`INTEGRATION-002`) | `work/RESULT-08.md` | 보류: 추출 의존성 추가 승인 필요 |
| 18 | `TERM-005` Android/iOS 실기기 한글 키보드·클립보드 확인 | `work/RESULT-18.md` | 보류: 실기기 필요 |
| 10·21 | `RESOURCE-018` Codex inline TOML hook 조회 | `work/RESULT-10.md`, `work/RESULT-21.md` | 안전 필드·스킬 metadata·JSON hook 연결과 Linux 인수 완료. TOML parser dependency 버전/범위 승인 또는 승인된 재사용 parser 제공 뒤 후속 배정 |
| 33 | SETTINGS-004 역할별 모델/context/disabled | `work/RESULT-33.md` | HTTP fallback과 hook 결합 포함 현재 통합 인수 완료. 역할별 설정은 별도 미배정 |
| 29 | RESOURCE-016 미지원 PreToolUse/SessionEnd·나머지 발생 경로, RESOURCE-017 Windows command | `work/RESULT-29.md` | Linux bash/sh 지원 범위 인수 완료. 원래 작업 차단·세션 종료/추가 lifecycle 계약을 정한 후 후속 배정; Windows 실행 환경 필요 |
| 11 | `RESOURCE-012` metadata/root 간 alias·hardlink 계약, Windows 경로/junction 검증 | `work/RESULT-11.md` | 보류: 지원 계약·Windows 환경 확인 필요 |
| 14 | `WEB-007`·`WEB-009`·`WEB-016` 인증/나머지 작업 경계·offline cold start·다중 탭·저장소 인수 | `work/RESULT-14.md`, `af0ad28` | 27 |
| 20 | `FILEUI-007` 실제 GUI 편집기·Windows/macOS·서비스 세션 검증 | `work/RESULT-20.md` | 보류: 해당 플랫폼·GUI 환경 필요 |
| 23 | `PC-005` 설치형 standalone PWA native 창 수명 확인 | `work/RESULT-23.md` | 보류: 설치형 PWA 환경 필요 |
| 24·31 | `SETTINGS-011` Windows/macOS 실행·경계·복구 실측 | `work/RESULT-24.md`, `work/RESULT-31.md` | Linux 연결·브라우저·hook 분리 인수 완료. 플랫폼 실측은 해당 OS 환경 필요 |
| 26 | `WEB-010` Safari/Firefox·iOS/Android·실제 비보안 origin 권한 동작 | `work/RESULT-26.md` | 보류: 해당 브라우저·실기기 환경 필요 |

## 통합 담당의 완료 절차
1. 사용자 통합 요청 뒤 각 worktree의 RESULT와 실제 branch·SHA·diff를 확인한다. 인계 파일만 보고 성공으로 단정하지 않는다.
2. 작업자가 편집을 끝냈는지 확인한다. 미커밋 작업은 승인 없이 수집·삭제하지 않는다.
3. 승인된 로컬 통합 범위에서 기능별 변경을 하나씩 합친다. 권장 순서: 05, 03, 09, 02, 07, 00, 01, 04, 08.
4. 공통 API·등록·화면·runner 연결을 완성한다. 구현 복제·권한 완화·가짜 성공으로 연결하지 않는다.
5. 입력이 유효한 통과 근거는 재사용하고 미실행·실패·통합 영향 검사를 수행한다. Rust와 웹 빌드·E2E는 기본 순차 실행한다.
6. 교차 경계: 배포 경로와 새 화면, 승인 대상과 새 도구, 이미지 모델 입력, 스킬 선택/적용 구분, 사용량 수치, 서비스 데이터 보존, 웹 조회 SSRF·취소.
7. 해당 TODO 전체 요구와 필수 검증이 충족되면 `TODO.md`를 반드시 `[x]`로 갱신하고 근거를 기존 형식에 맞춰 남긴다.
8. 부분 구현·미연결·실기기/플랫폼 미검증은 `[ ]`와 남은 조건을 유지한다. 이미 체크한 판단이 틀리면 다시 연다.
9. `work/INTEGRATE.md`의 보존·정리 조건을 확인해 종료된 작업의 worktree와 Paseo 워크스페이스를 제거하고 남은 일은 이월 작업 표로 옮긴다. 같은 흐름에서 활성 목표 수까지 다음 번호 작업을 준비한다. 진행 중인 작업은 수정하지 않는다.
10. 기능별 결과·정리 대상·새 워크스페이스와 blocker를 보고한다. 다음 번호 작업은 최신 검증 통합 기준에서 시작한다.

## 권한
준비 요청은 기능 세션 실행·stage·commit·merge·push·배포를 자동 승인하지 않는다.
START의 프롬프트를 사용자가 실제로 보내면 그 세션의 지정 작업과 관련 로컬 커밋을 승인하는 문구가 포함돼 있다.
START의 통합 프롬프트는 해당 배치의 로컬 통합·검증·관련 커밋, 조건을 충족한 완료 worktree/워크스페이스 정리, 다음 작업 준비를 승인한다.
현재 사용자의 명시적인 자동 순환 승인은 준비된 기능 세션 자동 시작과 위 범위의 반복 운영도 포함한다. 관련 계약은 `work/INTEGRATE.md`의 자동 순환 절을 따른다.
원격 push·배포·서비스 중단·강제 삭제·브랜치 삭제·이력 재작성은 포함하지 않는다.
