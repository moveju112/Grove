<!-- grove-handoff:v1
{"state":"ready","remaining":[],"blockers":[],"integration_checks":[]}
-->

# 34 — 역할별 위임 허용 정책

- 배치/요구: b02 / 34 / `AGENT-013`. 소유 구현·연결·선택 검사 완료, blocker 없음.
- Worktree: `/home/ubuntu/.local/share/paseodog/paseo/worktrees/0q796rug/b02-34-agent-policy`
- Branch: `parallel/b02-agent-policy`
- 고정 기준: `a340d2bccd7860d8452a5513b59c7f8ac215178c`. 시작 시 HEAD 일치·clean 및 제품 입력 `07bbd7b26763bf96735e013962f4d8f0d33c01ba` 포함을 확인했다. 기준 변경·merge·rebase는 하지 않았다.
- 권위 문서: `/data/project/paseodog_opus/work/ENTRY.md`, `/data/project/paseodog_opus/work/COMMON.md`, `/data/project/paseodog_opus/work/34.md`.

## 제공 동작·입출력 계약

| 설정 | 기본값 | 적용 |
| --- | --- | --- |
| `agents.orchestration` | `delegated` | `solo`는 새 spawn/send 금지. 상위 solo를 하위에서 해제하지 못한다. |
| `agents.allowed_roles` | `*` | 실제 agent 정의 ID의 쉼표 구분 목록. `*`는 전체, 빈 문자열은 모두 금지, null은 해당 override 해제다. 서버·프로젝트·대화·부모 run 계보의 교집합을 적용한다. |
| `agents.delegation` | 기존 `ask` | `off/ask/auto` 및 기존 일회 승인 흐름을 재사용한다. 상위 off는 하위 auto로 해제하지 못하고, 자식 대화의 auto로 부모 대화의 승인 요구를 생략하지 못한다. |

- 새 두 설정 모두 registry의 `agents` 메뉴에 등록해 기존 `ScopedSettings`의 문자열/enum 편집기와 settings API에 실제 연결했다. 새 화면·props·route·migration·dependency는 없다.
- 역할 입력의 공백·순서는 적용값 계산 때 정규화한다. 잘못된 자료형·ID 문법·빈 구분 항목·중복 ID·wildcard 혼합·존재하지 않는 정의는 기존 HTTP 400 `invalid_request` 형식으로 거절하고 값/revision을 보존한다. 사용자 정의 역할도 표시 이름이 아닌 ID에 묶는다.
- `settings::resolve_key/effective`와 복원 미리보기는 같은 상속 계산을 사용한다. 자식 문맥의 `layers`에는 읽기 전용 `parent:<session_id>` 항목(`scope_id/value/revision`)이 추가된다. 저장 가능한 scope는 기존 server/project/session뿐이다. 부모 정책 revision 변경도 복원 fingerprint에 반영하며, server/project 복원 시 부모의 적용값 역시 복원 후 상위 값으로 다시 계산한다.
- `agents::available_for`에서 금지 역할을 제외한다. 기본 정책에서는 기존 활성 정의 목록을 유지하고 off/solo/빈 허용 목록/최대 깊이에서는 빈 목록을 반환한다.
- `agents::approval_policy`는 spawn의 실제 정의 ID와 send의 저장된 run 역할을 검사한다. disabled·삭제된 정의, 역할 금지 및 orchestration 금지를 승인 전과 실행 claim 때 차단한다.
- `spawn_in_tx/send_in_tx`는 `approvals::check_running_execution`을 transaction 안에서 재호출한다. 실행 claim과 transaction 사이의 철회 및 auto→ask 변경도 새 자식/후속 턴을 만들기 전에 막는다. `src/approvals.rs`의 기존 재검사 경로는 수정하지 않았다.
- 정책 거부는 기존 `delegation_disabled`, 자동 승인 철회는 `approval_revoked`를 사용한다. transaction 경계의 오류를 `agent_failed`로 뭉개지 않는다. 기존 공통 승인 계층의 최초 거부 문구는 역할/solo 금지에도 기존 `agents.delegation=off` 문구를 재사용한다(형식·오류 코드는 유지).
- `Principal`, `expected_revision`, `idem::run`, 승인 identity, 부모/run 소유권 및 기존 한도 경계를 유지했다. 다른 대화의 run은 기존 `not_found` 도구 결과로 거절한다.
- 정책 철회 뒤에도 list/status/wait/cancel과 사용자 API 조회·취소를 유지한다. 기존 완료 결과·부모 note·출처를 보존하고, 재시작 interrupted 보고·응답 재조회·정책 복원은 자동 재실행을 만들지 않는다.

## 소유 변경·연결

| 경로 | 변경 |
| --- | --- |
| `src/agent_policy.rs` | 역할 입력 검증, 범위/부모 상속 규칙, 실제 실행 정책 계산 |
| `src/agents.rs` | available_for/approval_policy, spawn/send transaction 재검사, 직접 오류 매핑 |
| `src/settings.rs` | 두 registry 항목, 입력 검증, 상속 및 적용값/복원 계산 연결 |
| `src/lib.rs` | `pub mod agent_policy;` 한 곳 |
| `tests/agent_policy.rs` | 로컬 fixture 기반 정책·승인·복원·복구 회귀 6개 |
| `web/e2e/agent-policy.spec.ts` | 실제 설정 저장·composer·승인·응답 유실·결과 관측·철회·취소·reload 흐름 2개 |
| `work/RESULT-34.md` | 이 구조화된 인계 |

주요 public 연결은 `agent_policy::{ROLES, ORCHESTRATION, valid_roles, validate_roles, inherit, inherit_parent, Policy::for_session}`이며 기존 settings/agents 호출에서 사용한다. 미연결 모듈·추가 등록 대기는 없다.

## 검증 근거

최종 제품 코드와 Rust 시험이 안정된 뒤 아래 통합 선택 명령을 실행했다.

```bash
source /data/project/paseodog_opus/.envrc.dev && flock /home/ubuntu/.cache/grove-rust-check.lock python3 scripts/build.py test --rust agent_policy agents settings settings_reset --e2e e2e/agent-policy.spec.ts
```

| 단계 | 결과 | 실행기 wall / CPU |
| --- | --- | --- |
| Rust `agent_policy` 6 + `agents` 7 + `settings` 5 + `settings_reset` 4 | 22개 통과, 컴파일 포함 | 50.11s / 42.93s |
| debug 서버 빌드 | 통과 | 27.94s / 24.82s |
| 웹 빌드 | 통과 | 9.63s / 4.99s |
| 실제 Chrome E2E `e2e/agent-policy.spec.ts` | 2개 통과, 재시도 없음 | 9.66s / 9.06s |

최종 로그: `/home/ubuntu/.local/share/paseodog/mixdog/data/shell-output/shell_41a12b7f.stdout` 및 `/home/ubuntu/.local/share/paseodog/mixdog/data/shell-output/shell_41a12b7f.stderr`.

아래 통과 근거도 재사용한다. 이후 변경은 Rust의 정책/설정 상속 및 해당 Rust 시험뿐이며, 관련 웹/타입/Vitest 입력은 변하지 않았다.

```bash
source /data/project/paseodog_opus/.envrc.dev && python3 scripts/build.py test --vitest app/components/AgentRunsPanel.test.ts app/components/approvals/decision.test.ts app/components/approvals/projection.test.ts app/components/approvals/ApprovalCard.test.ts
source /data/project/paseodog_opus/.envrc.dev && python3 scripts/build.py test --typecheck
```

- Vitest: 4개 파일·30개 시험 통과, 2.57s wall / 2.95s CPU. 로그: `/home/ubuntu/.local/share/paseodog/mixdog/data/shell-output/shell_90cd1370.stdout`.
- Typecheck: E2E TypeScript 포함 통과, 10.64s wall / 12.18s CPU. 로그: `/home/ubuntu/.local/share/paseodog/mixdog/data/shell-output/shell_9d7b1631.stdout`.
- 코드 검토와 `git diff --check` 통과. 검사 이후 제품/시험 변경은 없고 이 인계 문서만 추가했다.

### 실패 이력·환경·미선택

- 기준 코드에서 `discovery_respects_off_before_any_new_policy`가 실제로 실패했다(off인데 모델에 역할 노출). 구현 후 통과했다.
- 첫 새 Rust 회귀 실행은 시험의 잘못된 정의 API method(PATCH 대신 PUT)와 존재하지 않는 summary `turn_id` 가정으로 2개 실패했다. 실제 API/summary 계약에 맞게 시험을 고친 뒤 통과했다.
- 최초 E2E는 recent 버튼의 accessible name을 title과 정확히 같다고 가정해 timeout됐다. 실제 프로젝트명·시간 포함 이름에 맞는 locator로 수정했다.
- 다음 E2E는 hang fixture에 `[DONE]`을 포함해 자식이 먼저 완료되어 취소 시나리오가 실패했다. 기존 fixture 방식대로 종료 프레임 없이 연결을 유지하도록 수정했다. 임의 지연·성공할 때까지 재시도·제품 변경으로 우회하지 않았다. 이후 보완된 상속 코드에서도 두 흐름 모두 다시 통과했다.
- 공통 환경을 source했지만 `scripts/build.py::env()`가 worktree `.dev` 경로로 덮어써 첫 실행에서 고정 Rust 1.93.0 툴체인과 Cargo cache를 로컬에 자동 생성했다. 경고를 숨기지 않았으며, 검증 완료 뒤 이번 실행이 생성한 worktree `.dev`만 확인 후 정리했다. dependency/lockfile 변경은 없다. `web/node_modules`는 계약대로 `/data/project/paseodog_opus/web/node_modules` symlink를 사용했다.
- 개발 세션 조회는 이 런타임에서 `session: cross-session control is unavailable in this runtime`으로 불가능했다. 다른 세션을 생성·재개하거나 runtime 설정을 변경하지 않았다.
- 웹 빌드의 기존 큰 chunk/React Router future 경고는 남아 있다. 검사 실패로 처리하거나 무관한 설정 변경으로 감추지 않았다.
- 전체 suite·release·실계정·유료 모델·Windows/macOS는 실행하지 않았다. 검사 서버/DB와 모델은 격리된 로컬 fixture다.
- `SETTINGS-021` deep-link 스크롤 실패는 37 소유이므로 수정·재검증하지 않았다. hooks/cwd/fallback/역할 모델/기본 지침/TODO/runtime 설정도 수정하지 않았다.

## 요구 충족·다음 통합

- `AGENT-013`: solo/위임 설정, 실제 역할 ID 검증, 모든 범위 및 부모 계보의 축소, 모델 발견, 직접 spawn/send, 승인 대기 및 claim 이후 철회, 기존 작업 관측·취소·결과 보존, 응답 유실과 재시작 비재실행을 위 시험에서 확인했다. 소유 범위의 실행 가능한 잔여는 없다.
- 완료된 `AGENT-014`는 재구현하지 않았다. 기존 off/ask/auto·일회 승인·후속 send·부모 취소·소유권·깊이/동시 한도·결과 1회 전달 회귀는 `tests/agents.rs` 7개 통과 근거를 사용한다.
- 통합 담당은 이 변경을 고정 candidate에 합친 뒤 필요 시 위 정확한 선택 명령을 사용하면 된다. 미연결 구현을 넘기지 않는다.
- TODO 체크·merge·push·배포·workspace 관리는 하지 않았다. 인계 파일을 포함하는 commit SHA는 순환 수정하지 않는다.
