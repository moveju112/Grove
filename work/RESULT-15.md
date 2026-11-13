# b02 / 15 — 턴 시간 표시 인계

## 식별·상태

- worktree: `<세션 worktree 루트>/b02-15-turn-timing`
- branch: `parallel/b02-turn-timing`
- 공통 기준 SHA: `bc797b36cd0c09ce41eb675d7d152ce95ffa7ef1`
- `git merge-base HEAD <기준 SHA>`가 기준 SHA와 일치했고 시작 시 Git 변경은 없었다.
- 상태: 구현 종료, **검증 blocker로 통합 대기**. 컴파일·행동 검증을 통과했다고 주장하지 않는다.
- `TODO.md`는 수정하지 않았다. `USAGE-009` 전체 완료 판정은 보류한다.
- push·merge·배포·실제 서비스 조작·의존성 설치·복사는 하지 않았다.

## 소유 변경

- `web/app/components/turn-timing/model.ts`: 서버 총 경과 표본과 단조 시계 기반 보간, 표시 형식, 해제 가능한 timer.
- `web/app/components/turn-timing/preference.ts`: 전용 기기 설정 저장·구독.
- `web/app/components/turn-timing/TurnTimingSetting.tsx`: 켜기·끄기와 저장 실패 안내.
- `web/app/components/turn-timing/TurnTiming.tsx`: 조회·진행·종료·재연결·오류·표시 수명 관리.
- `web/app/components/turn-timing/model.test.ts`, `web/app/components/turn-timing/presentation.test.ts`: 단위 시험.
- `web/app/components/SessionView.tsx`: 기존 로컬 `TurnTiming`을 새 컴포넌트로 교체하고 진행 중 턴 또는 마지막 턴 한 곳에 연결.
- `web/app/components/Settings.tsx`: 기존 시간 표시 항목에 설정 mount와 검색어 추가.
- `web/e2e/turn-timing.spec.ts`: 진행·완료·시계 차이·설정 유지·격리 서버 실제 재시작 시험.
- `work/RESULT-15.md`: 이 인계.

## 제공 동작·계약

### 서버 재사용

새 API·migration·서버 필드·생성 타입 변경은 없다.
인증된 기존 `GET /turns/:id`를 공용 `api.get`으로 읽는다.
`src/runner.rs::show`가 `src/usage.rs::turn_timing`을 호출하며 반환하는 `timing.total_ms`, `running`, 승인·도구·공급자 시간 분해를 재사용한다.
시작·종료 차이는 서버가 계산하고, 기기의 `Date.now()`는 계산에 쓰지 않는다.
조회 수신 뒤의 짧은 증분만 `performance.now()`로 보간하므로 기기 시각 ±수 분 차이나 실행 중 시각 변경이 경과에 더해지지 않는다.

기존 서버 복구는 `queued`·`running`을 `interrupted`로 종료하고 `finished_at`을 기록한다.
`awaiting_approval`은 복구 가능한 실제 대기 상태를 유지한다.
새 화면은 종료 표본을 고정하고 승인 대기는 계속 총 경과로 표시한다.
강제 종료의 정확한 프로세스 사망 시각을 새로 추정하지 않으며, 재시작 복구가 기록한 종료 시각까지의 총 경과를 표시한다.
오프라인 동안 실제 실행했는지 모르는 시간을 별도 실행 시간으로 만들어 내지 않는다.

### public export·props

| 경로 | export·입출력 |
|---|---|
| `web/app/components/turn-timing/TurnTiming.tsx` | `TurnTiming({ sessionId: string, turn: Turn, messagesReady: boolean })`. `Turn`은 기존 생성 타입. `messagesReady`는 같은 턴의 최종 메시지가 화면 데이터에 반영됐는지 나타낸다. |
| 같은 경로 | `TimingSummary({ sample, total, connected, deliveryMs? })`. 표본은 `id`, `status`, `updated_at`, `receivedAt`, `timing`; 시간 수치는 ms. 표현 단위 시험에서도 사용한다. |
| `web/app/components/turn-timing/TurnTimingSetting.tsx` | `TurnTimingSetting()`. 외부 props 없음, 전용 기기 설정 hook 사용. |
| `web/app/components/turn-timing/model.ts` | `Timing`, `TimingSample`, `elapsedMs(sample, monotonicNow, advance)`, `seconds(ms)`, `startTimingTimer(enabled, tick)`. timer는 해제 함수를 반환하고 꺼진 상태에서는 tick도 실행하지 않는다. |
| `web/app/components/turn-timing/preference.ts` | `TIMING_PREF_KEY`, `timingEnabled()`, `saveTimingEnabled(boolean)`, `useTimingEnabled()`. |

### 상태·오류·권한

- 총 경과에는 큐·승인·질문 대기가 포함된다고 명시한다. 이를 순수 실행 시간으로 부르지 않는다.
- 완료 시 기존 승인·도구·공급자 분해와 `deliveryTiming` 화면 반영 지표를 유지한다.
- 진행 중에는 1초 계산 timer, 15초마다 서버 재확인과 기존 `turn.updated` cache 무효화를 사용한다.
- 연결이 끊기거나 조회가 실패하면 마지막 서버 표본으로 멈추고, 연결이 복구되면 새 표본을 확인한 뒤 다시 보간한다.
- 상세 조회보다 목록에서 종료가 먼저 확인되면 이전 진행 표본으로 계속 늘리지 않는다.
- 조회 오류는 확인 실패 또는 마지막 확인 값으로 표시하며 연결된 상태에서는 `시간 다시 확인`을 제공한다.
- 끄거나 pane이 숨겨지면 시간 컴포넌트의 조회 구독과 계산 timer를 해제한다. 이미 전송된 공용 cache 조회까지 취소하지는 않는다.
- 설정 키는 `grove.device.turn-timing`, 기본 켜짐, 값 `on`·`off`이다. 같은 창 event와 다른 탭 storage event를 구독한다.
- 설정 저장 실패는 기존 값을 유지하고 UI 오류로 드러낸다. 읽기 실패·알 수 없는 저장값은 기본 켜기로 읽는다.
- 서버 권한·인증·idempotency 계약은 변경하지 않는다. 새 제품 상태 변경 API는 없다.
- 수치가 자주 바뀌는 보조 텍스트이므로 추가 애니메이션은 넣지 않았다.

## 검증 근거·실패·미실행

| 실제 명령·행동 | 결과 |
|---|---|
| `git merge-base HEAD bc797b36cd0c09ce41eb675d7d152ce95ffa7ef1` | 기준 SHA 일치. |
| `git diff --check` | 구현 변경에 대해 통과. 행동·컴파일 검증은 아니다. |
| `source .envrc.dev && python3 scripts/build.py test --vitest app/components/turn-timing/model.test.ts app/components/turn-timing/presentation.test.ts --typecheck` | exit 127. 먼저 실행되는 typecheck가 `sh: 1: react-router: not found`로 실패. 실행기가 Vitest를 미실행으로 표시했다. |
| `source .envrc.dev && python3 scripts/build.py test --rust usage --vitest app/components/turn-timing/model.test.ts app/components/turn-timing/presentation.test.ts --typecheck --dry-run` | 첫 도구 호출은 workspace admission lock timeout으로 실행 전에 실패. 한 번 재시도한 호출은 exit 0으로 선택 계획만 출력. Rust·typecheck·Vitest 통과 근거가 아니다. |
| 개발 세션 상태 조회 | 도구가 `session: cross-session control is unavailable in this runtime`을 반환해 다른 세션 상태는 확인하지 못했다. 실제 branch·clean 시작 상태·번호 문서 소유 범위를 기준으로 작업했다. |

이 worktree의 `web/`에는 `node_modules`가 없고 프로젝트 `.dev`도 없었다.
`command -v cargo`는 경로를 반환하지 않았으며 승인된 추가 공통 빌드 환경 경로도 문서에서 확인하지 못했다.
설치·복사·자동 다운로드·임시 실행기로 우회하지 않았다.
Rust 소스 변경은 없지만 기존 시간 API의 `tests/usage.rs` 선택 회귀도 실행하지 못했다.
E2E·웹 build·전체 회귀는 COMMON 계약대로 실행하지 않았다.
현재 코드·시험의 TypeScript 컴파일 및 단위·브라우저 행동은 모두 미검증이다.

작성한 단위 시험은 가짜 시계 ±5분·실행 중 시각 변경, 종료 표본 고정, 서버 재조회, 대기 중복 합산 방지, timer 끄기·해제, 상태 표현, 설정 저장·읽기·실패를 다룬다.
E2E 첫 시험은 실제 기존 API·모델 fixture로 진행·취소·완료를 만들고 서버 총 경과와 표시값을 비교하며 설정 유지·새로고침을 다룬다.
E2E 둘째 시험은 별도 임시 데이터·동적 포트·자기 소유 서버 프로세스를 사용해 강제 종료 후 실제 재시작한다.
공용 E2E 서버는 중단하지 않으며, 복구된 `interrupted` 상태·서버 시간 고정·브라우저 60초 전진 뒤 비증가를 확인하도록 작성했다.
작성된 시험이 실행됐거나 통과했다고 주장하지 않는다.

## TODO·통합 단계

`USAGE-009`의 경과·소요 표시, 표시 끄기, 서버 기준 시간 계산, 실제 복구 상태에 따른 표시 경로를 연결했다.
그러나 필수 typecheck·단위·E2E 검증이 막혀 **전체 요구 충족 근거는 아직 없다**.
`USAGE-010` auto effort는 수정하지 않았다.

추가 서버·공통 store 연결은 필요하지 않다.
다만 허용된 소유 범위 밖인 `web/app/state/device.ts`를 바꾸지 않아 전용 설정 키는 기존 `DeviceSettingsReset`의 시간 표시·기기 전체 복원 대상에 포함되지 않는다.
통합 담당은 기존 기기 설정 registry·복원·로그아웃 정책과 이 전용 키의 일관성을 확인하고 필요 시 공용 Prefs로 합쳐야 한다.

통합 환경에서 필요한 선택 검사는 다음과 같다.

```bash
source .envrc.dev && python3 scripts/build.py test --rust usage --vitest app/components/turn-timing/model.test.ts app/components/turn-timing/presentation.test.ts --typecheck
source .envrc.dev && python3 scripts/build.py test --e2e e2e/turn-timing.spec.ts e2e/workspace.spec.ts
```

위 명령은 승인된 공통 도구 환경을 먼저 적용한 통합 환경에서 실행한다.
`web/e2e/workspace.spec.ts`의 기존 사용량·`ui-delivery` 회귀가 같은 교체 지점을 사용한다.
E2E는 다른 worktree와 동시에 실행하지 않는다.
실제 실패가 나오면 해당 실패와 영향받은 검사만 다시 수행하고, 필수 검증 이후 통합 담당이 `TODO.md` 완료 여부를 판단한다.
