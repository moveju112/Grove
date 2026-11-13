# 41 · AGENT-022 완료 인계

<!-- grove-handoff:v1
{"state":"ready","remaining":[],"blockers":[],"integration_checks":[]}
-->

## 기준·상태

- worktree: `/home/ubuntu/.local/share/paseodog/paseo/worktrees/0q796rug/b02-41-agent-overview`
- branch: `parallel/b02-agent-overview`
- 고정 기준: `f4a4a702bcd342e159efe8801d429ad181391651`. 시작 HEAD와 일치하고 `43a51d0055a41fe889692fdb04a5e5b204eebf89` 포함을 확인했다.
- 정본: `/data/project/paseodog_opus/work/ENTRY.md`, `/data/project/paseodog_opus/work/COMMON.md`, `/data/project/paseodog_opus/work/41.md`. 원본 README의 경로·브랜치 행도 일치했다.
- 소유 구현·실제 Settings 연결·선택 검사·배정 브라우저 인수를 완료했다. 실행 가능한 잔여·blocker 없음. 통합·TODO 반영은 메인 소유이며 여기서는 하지 않았다.

## 제공 동작·연결

`Settings`의 기존 에이전트·워크플로우 편집 화면 맨 위에 조회 전용 개요를 연결했다.

| 요구 | 구현·인수 근거 |
|---|---|
| 등록 역할과 현재 사용 가능 구분 | `definitions::list_all`의 실제 등록·활성값, `agents::available_for`의 깊이 경계, `approvals::tool_policy`의 deny/read_only/bot 정책, 부모 턴 도구 상태를 사용한다. 대화 대상 없음·알 수 없는 위임값은 확인 필요/확인 불가로 표시한다. |
| 기본·사용자·override·비활성 지침 | resolver의 현재 body/name/description/enabled/modified_fields/revision을 사용한다. 비활성 지침은 실행 미사용으로 구분한다. 기본 원문·assets·정의 구현은 변경하지 않았다. |
| 부모 모델 상속과 다음 요청 기본값 구분 | 활성 부모 턴의 `profile_id`·`tools_enabled`와 범위별 `model.default_profile`을 별도로 조회한다. 활성 턴 없음·미설정·삭제·비활성·알 수 없음은 성공으로 표시하지 않고 첫 모델을 임의 선택하지 않는다. 모델 이름·식별용 model만 안전하게 표시하고 연결·실행 미확인을 명시한다. |
| 실제 위임 규칙 | `agents::approval_policy`와 실제 tool policy를 조합해 ask/auto/off·출처·현재 대화 시작 승인 상태를 표시한다. `tools.allow`의 ask 우회와 deny 우선순위, 공개 한도 상수, 부모 취소 전파·재시작 interrupted/자동 재실행 없음도 안내한다. 정책상 가능을 여유 한도나 성공으로 표현하지 않는다. |
| 기존 편집 연결 | 역할별 버튼은 기존 `setKind("agent")`·`setSel(id)`만 호출한다. 기존 편집의 저장 후 이벤트로 개요를 갱신한다. `DefinitionEditor` 비교·복원·편집 구현은 그대로다. |
| 대상·오류·복구 | 고정된 Settings target만 전달한다. 대상별 구독, 요청 sequence·unmount guard, 기존 cache 이벤트 무효화, 연결 상태와 브라우저 online/offline 신호로 이전값을 숨기고 재접속 시 새로 조회한다. 역순 응답·unmount 뒤 응답·다른 pane·reload·503/403 복구를 브라우저에서 인수했다. |
| 조회 부작용·보안 | GET만 제공한다. 파일·모델·자식·템플릿 실행이나 설정 저장을 하지 않는다. 기존 인증의 `tokens.last_used_at` 갱신 1건 외 DB 변경 없음과 모델 fixture 요청 없음도 확인했다. vault 값·자격 헤더/민감 행·PEM·개인 경로/URL 행은 서버에서 가리고 endpoint/options/secret_id/last_check는 응답하지 않는다. |

역할별 모델·context/disabled 설정, 기본 정의 변경, 정책 구현, Profiles/MCP, 직접 링크 effect/anchor는 범위 밖이며 변경하지 않았다. 긴 조회 본문은 기존 UI 패턴과 가독성을 유지하고 별도 애니메이션·CSS·의존성을 추가하지 않았다.

### public 계약

- `agent_overview::show`: `GET /api/v1/agent-overview?project_id=…` 또는 `?session_id=…`. `OverviewQuery`는 알려진 두 필드만 받는다. 대화가 프로젝트를 상속하며 서로 다른 두 대상을 함께 지정하면 400이다. 빈 대상·알 수 없는 인자 400, 없는 대상 404, 무인증/폐기된 자격 401이다.
- 기존 definitions/settings와 같은 `Principal` 읽기 권한이다. 기존 기기 토큰도 같은 경계에서 조회할 수 있다. 원본 source-settings의 소유자 전용 권한으로 바꾸거나 기존 권한을 넓히지 않았다.
- 응답은 `roles`, `delegation`, `parent`, `next_request_default`, `limits`, 확인된 대상 ID다. 원문 가림용 vault 읽기가 실패하면 `redaction_unavailable`로 전체 조회를 중단하며 원문을 반환하지 않는다.
- `getAgentOverview(target: OverviewTarget): Promise<AgentOverviewData>`: 대화 ID가 있으면 프로젝트 ID 대신 대화 ID로 조회한다. 전용 타입만 추가했고 generated/common client는 변경하지 않았다.
- `AgentOverview({ target, onEdit })`: target은 프로젝트/대화 식별자, callback은 기존 agent 편집 선택이다. 조회·지침 펼치기는 callback이나 쓰기 API를 호출하지 않는다.
- 공통 연결은 `src/lib.rs`의 모듈·GET 등록, `Settings.tsx`의 import·Definitions target props·상단 mount뿐이다. 미연결 지점 없음.

## 소유 변경 파일

- `src/agent_overview.rs`
- `tests/agent_overview.rs`
- `web/app/api/agentOverview.ts`
- `web/app/components/agent-overview/AgentOverview.tsx`
- `web/app/components/agent-overview/AgentOverview.test.ts`
- `web/e2e/agent-overview.spec.ts`
- `src/lib.rs`의 전용 모듈·GET route 두 선언
- `web/app/components/Settings.tsx`의 전용 import/mount/target props
- `work/RESULT-41.md`

## 실행 명령·유효한 검사

모든 실행은 이 worktree에서 했다. 기존 환경·검사·빌드 스크립트·툴체인은 변경하지 않았다. 원본 `.envrc.dev`를 source하고 구형 builder의 `DEV`만 프로세스에서 지정했다. 없는 `web/node_modules`는 COMMON의 원본 공유 경로로 symlink했다. `.dev` 설치·복사·덮어쓰기는 하지 않았다. 기존 cargo config의 jobs=2/build-dir 설정을 그대로 사용했다.

```bash
source /data/project/paseodog_opus/.envrc.dev && flock /home/ubuntu/.cache/grove-rust-check.lock python3 -c 'import sys; sys.path.insert(0, "scripts"); import build; build.DEV="/data/project/paseodog_opus/.dev"; build.main(["test", "--rust", "agent_overview", "definitions", "settings", "agents"])'

source /data/project/paseodog_opus/.envrc.dev && python3 -c 'import sys; sys.path.insert(0, "scripts"); import build; build.DEV="/data/project/paseodog_opus/.dev"; build.main(["test", "--vitest", "app/components/agent-overview/AgentOverview.test.ts", "--typecheck"])'

source /data/project/paseodog_opus/.envrc.dev && flock /home/ubuntu/.cache/grove-rust-check.lock python3 -c 'import sys; sys.path.insert(0, "scripts"); import build; build.DEV="/data/project/paseodog_opus/.dev"; build.main(["test", "--e2e", "e2e/agent-overview.spec.ts"])'
```

| 최종 검사 | 결과 | 실행기 wall / CPU |
|---|---|---|
| Rust `agent_overview`, `agents`, `definitions`, `settings` | 5+7+3+5=20 통과, 컴파일 포함 | 35.67s / 20.12s |
| typecheck | 통과 | 12.75s / 12.72s |
| 전용 Vitest | 11 통과 | 1.40s / 2.21s |
| E2E용 debug 서버 빌드 | 통과 | 4.76s / 0.31s |
| 웹 production 빌드 | 통과 | 3.60s / 5.30s |
| 배정 E2E `web/e2e/agent-overview.spec.ts` desktop | 5 통과 | 7.18s / 6.84s |

유효 로그:

- Rust: `/home/ubuntu/.local/share/paseodog/mixdog/data/shell-output/shell_3aa5f60f.stdout`, `/home/ubuntu/.local/share/paseodog/mixdog/data/shell-output/shell_3aa5f60f.stderr`
- 타입·Vitest: `/home/ubuntu/.local/share/paseodog/mixdog/data/shell-output/shell_24f15905.stdout`
- 빌드·최종 브라우저: `/home/ubuntu/.local/share/paseodog/mixdog/data/shell-output/shell_f279ecba.stdout`, `/home/ubuntu/.local/share/paseodog/mixdog/data/shell-output/shell_f279ecba.stderr`

최종 범위 확인에서 rustfmt의 하위 모듈 처리로 공통 fixture 두 파일에도 포맷 변경이 생긴 것을 발견했다. 그 변경만 원문으로 되돌렸고 `tests/common/mod.rs`, `tests/common/fixture.rs`의 Git diff가 없는 상태에서 위 Rust 20개를 다시 통과했다. 최종 웹/브라우저 검사 입력은 이 복구와 무관하며 그대로다. 최종 Rust 검사 이후에는 이 인계 문서만 갱신했다. 로컬 fixture만 사용했으며 실제 모델 품질·외부 서비스 성공을 주장하지 않는다. 전체 회귀·release·mobile·다른 OS는 미선택/미검증이다.

### 실패·수정 이력

- 첫 Rust 실행은 새 시험 4/5 통과 후, `total_changes`에 기존 Bearer 인증의 `tokens.last_used_at` 1건을 포함해 실패했다. 인증 구현을 확인해 그 1건만 기대값에 반영했고 제품 코드는 바꾸지 않았다. 같은 명령 재실행에서 20개가 모두 통과했다(68.55s wall / 36.32s CPU, `/home/ubuntu/.local/share/paseodog/mixdog/data/shell-output/shell_60c64899.stdout`). 공통 fixture 원문 복구 후 최종 20개 통과 근거는 위 표다. 최초 실행은 exit 101, rust tests 135.79s wall / 221.65s CPU였고 뒤 integration targets는 당시 미실행이었다. 로그: `/home/ubuntu/.local/share/paseodog/mixdog/data/shell-output/shell_fa77b645.stdout`, `/home/ubuntu/.local/share/paseodog/mixdog/data/shell-output/shell_fa77b645.stderr`.
- 최초 E2E는 세션 목록을 배열로 가정한 새 시험의 오류로 1 실패·3 미실행이었다. 실제 `SessionPage.items` 계약으로 고쳤다. 두 번째 실행은 편집/reload 1 통과 후 프로젝트 선택이 같은 pane의 활성 탭을 바꾼다는 점을 놓쳐 대상 보존 시험이 timeout, 나머지 2개는 미실행이었다. 실제 화면 snapshot을 확인하고 다른 대화를 오른쪽 pane에서 선택하는 원래 요구 시나리오로 고쳤다.
- 다음에는 `e2e/agent-overview.spec.ts:69`, `:103`, `:149`를 한 `--e2e` 입력으로 선택했다. 대상 보존은 통과했지만 실제 `context.setOffline(true)`에서 SSE의 기존 live 상태가 남아 개요가 이전값을 노출해 1 실패·1 미실행이었다. 개요 소유 범위에서 navigator online/offline도 구독하고 연결 변화마다 새 조회·세대 해제를 하도록 수정했다. HTTP 오류로 offline 시나리오를 바꾸거나 timeout을 늘리지 않았다. 최종 5개 전체 인수와 영향받은 타입·Vitest를 다시 통과했다.
- 실패 브라우저 로그는 각각 `/home/ubuntu/.local/share/paseodog/mixdog/data/shell-output/shell_8359e009.stdout`, `/home/ubuntu/.local/share/paseodog/mixdog/data/shell-output/shell_41264e89.stdout`, `/home/ubuntu/.local/share/paseodog/mixdog/data/shell-output/shell_4b008996.stdout`와 같은 basename의 `.stderr`다. 각 실행은 exit 1이다. E2E 단계 wall/CPU는 순서대로 4.54s/3.42s, 25.65s/4.58s, 7.36s/4.21s였다.
- 기존 React Router future flag·500kB 초과 chunk 경고는 남아 있으며 범위 밖 공통 설정을 수정하지 않았다.
- 읽기 전용 세션 목록 도구는 이 runtime에서 cross-session 기능을 제공하지 않았다. 원본의 broad inventory 조회도 timeout되어 알려진 cargo config 파일을 직접 읽어 환경을 확인했다. 이를 검사 성공이나 세션 관리 수행으로 간주하지 않았다.

## 통합 시 주의

AGENT-022의 배정 범위와 브라우저 인수는 완료했다. 다른 기능과 통합할 때 `src/lib.rs`의 전용 선언 및 `Settings::Definitions`의 좁은 mount/props만 보존하면 된다. 기존 DefinitionEditor·직접 링크·Profiles·MCP·정책 구현을 이 변경으로 대체하지 않는다. TODO 체크·merge/rebase·push/deploy·workspace/runtime 관리는 수행하지 않았다.
