<!-- grove-handoff:v1
{"state":"blocked","remaining":[],"blockers":[{"reason":"manifest를 revision에 결합한 catalog와 src/skills/management.rs::execute의 Mutation::Save 응답 계산이 다르다. 관리 구현은 배정 밖이며 좁은 연결의 추가 승인을 받지 못해 수정하지 않았다.","unblock":"management.rs의 Save next 계산 한 곳을 requirements::load(root, &record.name, text.as_bytes())의 revision과 기존 management::revision 세대 계산에 연결하도록 소유권을 승인/배정하고, manifest 포함 본문 저장·같은 본문 재저장 응답의 revision 일치 회귀를 검증한다."}],"integration_checks":["통합으로 관련 입력이 바뀌면 COMMON 환경·전체 명령 잠금 아래 scripts/build.py test --rust skill_requirements skills skill_management --e2e e2e/skill-requirements.spec.ts e2e/skills.spec.ts"]}
-->

# 43 — RESOURCE-013

| 항목 | 값 |
|---|---|
| 배치/번호 | b02 / 43 |
| worktree | `/home/ubuntu/.local/share/paseodog/paseo/worktrees/0q796rug/b02-43-skill-requirements` |
| branch | `parallel/b02-skill-requirements` |
| 고정 기준 | `6fc2fbb5b36e883d13417fc9c41cf679aed3eb0c` |
| 검증 제품 입력 | `f53aa85061cc35198461bb54e1d133218dbb7cad`가 기준의 ancestor임을 확인 |
| 상태 | 소유 구현·브라우저 인수 완료, 관리 revision 연결의 승인 경계로 blocked |

`/data/project/paseodog_opus/work/ENTRY.md`, `COMMON.md`, `43.md`와 README의 정확한 경로/branch 행을 확인했다.
시작 HEAD는 고정 기준과 같고 clean이었다. 현재 세션의 `fast=false`를 조회로 확인했으며 runtime 설정은 변경하지 않았다.

## 제공 동작과 소유 변경

- `src/skills/requirements.rs`: 선택적 `requirements.grove.json`만 읽는다. version 1, 생략 가능한 `tools`/`platforms`/`skills` 문자열 배열을 지원한다. UTF-8 JSON 16 KiB, 배열당 64개, 항목당 128 byte 한도다. 미지 키/version, 중복 키/항목, 잘못된 타입/이름은 명시적 오류다. YAML/front matter는 해석하지 않는다.
- `src/skills/mod.rs`: manifest 원문·존재·canonical target을 본문과 함께 revision에 결합한다. manifest가 없으면 기존 본문 SHA-256을 그대로 유지한다. 기존 관리 세대, source, alias와 우선순위 계약은 유지한다. 열린 `ProjectFs` capability, 일반 파일/크기 제한, canonical target 전후 확인을 재사용한다.
- `src/skills/api.rs`: 기존 list/inspect/selection 경로에 요구 판정을 연결한다. 전체 선택의 현재 source/revision과 요구사항을 검증하고 실제 모델 입력에서는 미확정 도구 capability도 거절한다. 조회/선택 해제는 불충족 상태에서도 가능하다. 자동 선택·대체·설치·실행은 없다.
- `src/runner.rs`: `load_step`의 기존 `skills::api::model_instructions` 호출 한 곳에만 `t.tools_enabled`, `mp.capabilities.tools`, `cli_backend`를 전달했다. `tool_defs`, tool schema/선택 snapshot, hook/fallback/실행 루프는 수정하지 않았다.
- `web/app/api/skills.ts`, `web/app/components/skills/SessionSkills.tsx`, `web/app/components/skills/SkillsPanel.tsx`: 기존 목록·본문·선택·미확정 요청 복구에 이유를 연결했다. 검증용 모델/도구 조건은 전송 설정과 명시적으로 분리한다. 다음 호출 조건이 없거나 capability가 확인되지 않았으면 충족으로 추정하지 않는다.
- `web/app/components/skills/requirements/Requirements.tsx`, `Requirements.test.ts`: 선언/불충족/미확정 상태와 조회용 조건 UI, 전용 단위 시험이다. 기존 CSS와 접근 가능한 label/fieldset을 사용한다. 즉시 읽어야 하는 상태 표시이므로 별도 animation은 추가하지 않았다.
- `tests/skill_requirements.rs`: manifest 형식/보안/revision, 의존성/순환/모호성/명시적 낮은 출처, 실제 로컬 모델 적용과 tools-off/미확인 capability/정책 거절, read-only/CLI/MCP 미지원, 응답 유실·재시작·프로젝트 경계·선택 복구를 검증한다.
- `web/e2e/skill-requirements.spec.ts`: 선언 파일 → 이유 조회 → 명시적 의존/본체 선택 → 응답 유실 후 동일 요청 확인 → 실제 모델 지침 적용/불충족 거부 → reload 비재실행 → manifest stale/해제/재선택과 다른 세션 비전파를 검증한다.
- `work/RESULT-43.md`: 이 인계다.

`src/skills/management.rs`, 공통 route/client/state/CSS/store/settings/dependency, 다른 checkout, `TODO.md`는 수정하지 않았다.
34/35/40의 미병합 구현이나 deferred schema에 의존하지 않는다.

## 공개 계약과 연결

`skills::requirements`는 `Requirements`, `Report`, `Status`, `Problem`, `Invocation`, `Capabilities`와 한도 상수를 제공한다.
`SkillEntry`/`SkillBody`의 `requirements`는 서버가 만든 `declaration`, `status: satisfied|blocked|unknown`, `problems[{code,message}]`다. 입력의 충족 상태로 검증을 우회하지 않도록 역직렬화에서는 받지 않는다.

기존 GET skills는 선택적 `profile_id`/`tools_enabled` query를 받는다.
기존 inspect/select JSON은 선택적 `context:{profile_id?,tools_enabled?}`를 받는다.
조건은 서버에서 현재 profile capability를 다시 조회하는 검증 입력일 뿐, 프로필/도구 설정·권한·저장된 skill binding을 바꾸지 않는다.
빈 context는 서버 직렬화에서 생략하므로 기존 selection의 idempotency body hash와 호환된다.

`skills::api::model_instructions(c, data, session, tools_enabled, model_tools, cli)`는 실제 접수된 도구 사용 여부와 현재 실제 프로필 capability를 받는다.
등록된 `tools::specs()`, 현재 서버 OS, 기존 `approvals::tool_policy`, enabled/ready MCP 상태를 비교한다.
등록/schema 노출은 실행 허가가 아니며, 기존 대상별 승인·실행 직전 권한 검사를 대체하지 않는다.
API 조회/선택은 서버의 tool-loop disabled도 반영한다.

의존 스킬은 허용 root의 정확한 사용자 선택 source/revision으로만 충족된다.
선택된 동명 항목은 명시적 출처를 존중하고, 미선택 이름을 탐색할 때는 기존 프로젝트 우선순위·동급 충돌·불완전 목록 정본을 사용한다.
순환/모호성/미선택/누락은 오류이며 다른 항목을 선택하거나 대체하지 않는다.
선택 전체가 유효하지 않으면 일부 본문을 모델에 적용하지 않는다.

주요 오류는 `skill_requirements_invalid`, `skill_requirements_version`, `skill_dependency_cycle`, `skill_dependency_ambiguous`, `skill_dependency_missing`, `skill_dependency_unselected`, `skill_platform_unsupported`, `skill_tool_unregistered`, `skill_tool_unavailable`, `skill_tools_disabled`, `skill_model_unknown`, `skill_model_unsupported`다.
기존 `skill_changed`/`skill_not_found`/`skill_disabled`와 정책/읽기 전용 오류도 유지한다.

## 실행 검사와 근거

모든 실행에서 먼저 `source /data/project/paseodog_opus/.envrc.dev`를 적용했다.
옛 실행기의 `DEV`만 프로세스 안에서 `/data/project/paseodog_opus/.dev`로 지정했다.
공유 `web/node_modules`로 Git-ignored symlink를 연결했으며 설치/빌드 파일/검사 설정/cache 설정은 변경하지 않았다.
Rust/E2E는 아래와 같이 전체 명령을 같은 잠금으로 직렬화했다.

```bash
source /data/project/paseodog_opus/.envrc.dev
flock /home/ubuntu/.cache/grove-rust-check.lock python3 -c 'import sys; from scripts import build; build.DEV="/data/project/paseodog_opus/.dev"; sys.argv=["scripts/build.py","test","--rust","skill_requirements","skills","skill_management"]; build.main()'

source /data/project/paseodog_opus/.envrc.dev
python3 -c 'import sys; from scripts import build; build.DEV="/data/project/paseodog_opus/.dev"; sys.argv=["scripts/build.py","test","--vitest","app/components/skills/SkillsPanel.test.ts","app/components/skills/SkillEditor.test.ts","app/components/skills/requirements/Requirements.test.tsx","--typecheck"]; build.main()'

source /data/project/paseodog_opus/.envrc.dev
python3 -c 'from scripts import build; build.DEV="/data/project/paseodog_opus/.dev"; build.main(["test","--vitest","app/components/skills/requirements/Requirements.test.ts","--typecheck"])'

source /data/project/paseodog_opus/.envrc.dev
flock /home/ubuntu/.cache/grove-rust-check.lock python3 -c 'from scripts import build; build.DEV="/data/project/paseodog_opus/.dev"; build.main(["test","--e2e","e2e/skill-requirements.spec.ts","e2e/skills.spec.ts"])'
```

| 검사 | 결과 | 실행기가 출력한 wall / CPU |
|---|---|---|
| Rust `skill_requirements` 8 + `skills` 17 + `skill_management` 11 | 36개 통과, exit 0 | 131.11s / 222.48s |
| 기존 SkillsPanel/SkillEditor Vitest | 12개 통과 | 1.86s / 2.71s |
| 최종 요구사항 전용 Vitest | 3개 통과 | 2.91s / 2.2s |
| 최종 typecheck | 통과 | 10.24s / 13.05s |
| E2E용 실제 debug 서버 빌드 | 통과 | 94.01s / 84.73s |
| E2E용 웹 빌드 | 통과 | 3.85s / 4.98s |
| 요구사항 spec 2 + 기존 skills spec 2 | desktop 4개 통과 | 7.75s / 7.58s |
| `git diff --check` | 통과 | 미제공 |

첫 웹 실행은 새 시험을 `.test.tsx`로 지정해서 기존 Vitest include(`app/**/*.test.ts`)에 잡히지 않았다. 따라서 그 실행은 기존 시험 12개만의 근거다.
새 시험을 `.test.ts`로 변경했다.
그 뒤 typecheck가 새 E2E의 배열 원소 접근 두 곳에서 `TS2532: Object is possibly 'undefined'.`로 실패해 해당 실행의 Vitest는 미실행이었다.
명시적인 고정 길이 검증 뒤 원소 접근을 수정하고, 위 마지막 전용 Vitest/typecheck 명령으로 둘 다 통과했다.
실패를 통과로 치환하지 않는다.

최종 Rust 검사에는 현재 Rust 구현/시험이 포함됐다. 이후 Rust 변경은 `SkillEntry.revision` 설명 주석뿐이며 실행 코드/시험은 같다.
웹 최종 typecheck 이후에는 `SessionSkills.tsx`의 관측 조건 안내 문구만 바뀌었고, 실제 debug 서버/웹 빌드와 네 브라우저 시험은 이 문구를 포함한 최종 입력으로 통과했다.
이후 변경은 위 Rust 설명 주석과 이 RESULT뿐이다. 기존 웹 단위 시험 대상 및 공통 요구사항 컴포넌트는 통과 때와 같다.

E2E 웹 빌드에는 기존 React Router v8 future flag 및 500 kB 초과 chunk 경고가 있었다. 관련 설정은 바꾸지 않았다.
전체 회귀/release, 실제 외부 모델·유료 서비스·CLI subprocess, Windows/macOS 실기기는 미선택/미검증이다.
명령 시작부터 종료까지의 공유 잠금 대기 시간을 검사 실행 시간이나 성능 절감으로 추정하지 않는다.

## RESOURCE-013 충족 근거와 blocker

형식 제한/호환, capability·정책·서버 OS 검증, 명시적 의존/출처/revision 보존, 순환/모호성 오류, bounded capability I/O, 불충족 전체 적용 거부와 선택 해제/유실/재시작/reload 복구는 위 소유 Rust/브라우저 검사로 확인했다.
권한 부여·자동 설치/선택/실행이 없고, 실제 fixture 모델 입력에 선택된 두 본문만 들어가며 tools-off/stale 요청은 fixture에 도달하지 않는 것을 확인했다.
기존 스킬 시험의 인증·root 교체/탈출·다른 프로젝트·동시 선택/이동 경계도 통과했다.

**완료 후보로 올리지 않는 경계**: `src/skills/management.rs::execute`의 `Mutation::Save`는 여전히 `revision(&sha256_hex(text.as_bytes()), record.generation)`으로 `next`를 만든다.
manifest 스킬의 catalog revision은 본문+manifest+target이므로 이 응답은 실제 revision과 다르고, 같은 본문 저장도 불필요한 쓰기로 판정한다.
이는 해당 기존 계산식과 새 catalog 계산을 대조한 정적 근거이며, manifest 포함 저장의 실행 회귀는 아직 미검증이다. 기존 management 시험 통과는 manifest 저장 호환을 증명하지 않는다.
관리 구현은 배정 밖이다. 한 곳의 revision 연결 승인을 질문했지만 답변 없이 닫혀 범위를 확대하지 않았다.

필요한 최소 후속은 위 `next`의 content hash를 기존 `requirements::load(root, &record.name, text.as_bytes())?.0` 결과로 대체하고 `management::revision`의 기존 세대 계산을 유지하는 연결이다.
실제 적용에는 기존 `api_error` 변환이 필요하다. 저장의 다른 동작/권한/receipt/파일 I/O를 변경할 필요는 없다.
승인/소유권 배정 후 manifest 포함 본문 저장·같은 본문 재저장·응답 revision을 사용한 명시적 선택·기존 세대 보존 회귀를 추가해 이 경계를 검증해야 한다.
현재 소유 범위의 실행 가능한 잔여는 없고, 이 승인 경계만 blocker로 남는다. 통합 완료·TODO 완료로 표시하면 안 된다.
