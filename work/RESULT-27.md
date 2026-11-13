# b02 / 27 — PWA 호환·오프라인·다중 탭 복구

## 기준과 상태

- worktree: `/home/ubuntu/.local/share/paseodog/paseo/worktrees/0q796rug/b02-27-pwa-recovery`
- branch: `parallel/b02-pwa-recovery`
- 공통 기준: `551f551d48d1f47cd3ad67015f1737c62d576228`. 시작 HEAD와 일치했고 작업 트리는 깨끗했다.
- 원본 `/data/project/paseodog_opus/work/ENTRY.md`, `/data/project/paseodog_opus/work/COMMON.md`, `/data/project/paseodog_opus/work/27.md`와 README의 실제 경로·브랜치 배정을 확인했다. `af0ad28`이 현재 기준의 조상임도 확인했다.
- 상태: **소유 HTTP 복구 흐름 구현·타입 검사·선택 단위 시험 완료 / 브라우저 통합 인수 대기 / 남은 경계 있음**. 세 TODO 전체 완료로 판정하지 않는다.
- main·TODO·의존성·lockfile·서버·공통 검사 설정을 수정하지 않았다. 위임·세션 조회/연락·merge·push·배포·workspace 삭제는 하지 않았다.

## 제공 동작과 실제 연결

- `web/app/api/client.ts`의 로그인·페어링·refresh·logout 전송 직전에 기존 `serverActionGuard`를 사용한다. lifecycle의 offline·호환 확인 중·연결 실패·protocol 불일치 정책을 복제하지 않았다. 별도 인증 응답에도 기존 `checkProtocol()`을 적용한다.
- 로그인은 기존 `boundedRequest()`를 재사용해 전송 전 차단은 `result_unknown: false`, 실제 응답 유실은 `result_unknown: true`로 구분한다. 로그인·일회용 페어링은 자동 refresh/재시도를 하지 않는다.
- refresh singleflight와 소유 세대 검사를 유지했다. guard가 첫 await 전에 동기적으로 거부해도 완료된 Promise가 영구히 남지 않도록 정리를 Promise의 `finally`로 옮겼다. 차단·네트워크 실패는 열린 탭의 인증을 만료시키지 않는다. 실제 HTTP 인증 거부 시 만료 처리·초안 정리 정책은 기존대로다.
- 진행 중 로그인·페어링의 응답은 인증 세대가 바뀌면 적용하지 않는다. 인증이 아직 없던 cold start의 logout도 세대를 바꾼다. logout은 기존 로컬 종료와 진행 중 refresh 뒤 쿠키 폐기 순서를 유지하며, 차단된 원격 폐기를 복구 후 자동 재전송하지 않는다.
- 페어링 제출 callback은 HTTP status 0만으로 미전송을 결과 불명으로 오인하지 않고 `details.result_unknown`을 사용한다.
- `web/app/routes/app.tsx`의 기존 앱 인증 진입에서 health 호환 확인 뒤 최초 refresh를 시도한다. offline·호환 실패의 cold start에는 `AuthRecovery`를 표시한다. 연결 복구 이벤트는 health만 조회하며, 보류한 인증 복구는 사용자가 직접 선택한다. 실패하면 기존 로그인 화면으로 이어진다. 페어링 링크는 자동 사용하지 않는다.
- `AuthRecovery`는 로컬 초안 목록·키·본문·대화 목록을 조회하지 않는다. 인증 없이 Workspace를 mount하지 않는다. 기존 사본을 삭제하거나 새 자격을 저장하지 않고, 원래 계정으로 온라인 인증 후 대화를 열도록 안내한다. 서버 작업·결과 불명 요청의 재전송은 하지 않는다.
- 기존 root의 `LifecycleBanner` mount를 유지했다. 보존 한계 안내에 구 UI 탭·버전 불명 탭 때문에 cache 회수가 보류될 수 있다는 설명을 더했다. 안내에 애니메이션은 추가하지 않았다.
- `ServerActionButton`으로 아래 기존 서버 작업 버튼의 disabled·title·접근성 설명을 연결했다. 원래 disabled·callback·권한·idempotency key·불명 결과 사본은 유지했다. 로컬 편집·취소·복사·조회 버튼은 별개다. 승인 카드는 `af0ad28`의 기존 `blockedReason` 연결을 그대로 사용한다.
- 외부 편집기의 순수 `ExternalEditorControls`는 전역 PWA 상태를 읽지 않는다. FilesView가 `blockedReason` action prop을 전달하고 실제 API는 기존 공통 guard로 차단한다.
- worker가 자기 cache의 HTML을 반환할 때만 `grove-shell-version` meta로 document 버전을 표시한다. cache 유실 시 network HTML의 버전을 추측하지 않는다. lifecycle은 시작 시 읽은 document 버전을 계속 보고하므로 다른 탭의 controller 전환을 자기 document 갱신으로 오인하지 않는다.
- cache 회수는 scope 안의 **모든 살아 있는 document가 현재 버전을 보고한 경우**, 또는 살아 있는 document가 없는 activation에서만 허용한다. 단일 구 탭·버전 불명 탭·worker 재시작 후 미확인 탭은 cache를 보존한다. 탭 수만으로 삭제하던 분기를 제거했다.
- 회수 대상은 정확한 scope prefix의 현재 cache보다 먼저 만들어진 cache다. 현재 shell 유실·설치 중·대기 worker가 있으면 회수를 보류한다. 뒤에 생긴 새 cache·대기 cache·다른 scope·scope 없는 legacy cache는 삭제하지 않는다. 구 탭의 정확한 hashed asset URL fallback과 API cache 제외는 유지했다.
- 대기 worker를 관측하지 못한 탭도 다른 탭의 controller 전환 뒤 업데이트 선택을 받는다. 첫 claim·다른 탭의 동의만으로 reload하지 않는다.

## public 계약

| export / 연결 | 계약 |
|---|---|
| `AuthRecovery({ recover })` | `recover: () => Promise<void>`. 온라인 버튼으로 health 확인 후 callback 호출. 인증·초안 데이터는 props로도 받지 않음 |
| `ServerActionButton(props)` | `ButtonHTMLAttributes<HTMLButtonElement>`. 기존 disabled와 공통 차단을 합치고 이유를 title·aria-description에 표시. 전송 검사는 API guard 소유 |
| `ExternalEditorControlsProps.blockedReason`, `ExternalEditor.blockedReason` | 선택적 `string \| null`. 호출부 FilesView가 주입. 기존 독립 사용의 기본 활성 조건 유지 |
| worker `shell-status` 요청 | `{ type: "shell-status", version: string \| null }`. 문서의 버전이며 controller 버전이 아님. 출처 client ID·scope를 확인하고 미확인 버전은 삭제 동의로 해석하지 않음 |
| worker `shell-status` 응답 | 기존 `{ type: "shell-status", cached: boolean }` 유지 |
| 인증·서버 오류 | 기존 `ApiError`, protocol 알림, `result_unknown`, 요청 세대와 원래 idempotency key 사용. 새 서버 endpoint·권한 완화·영구 자격 저장 없음 |

추가 root mount·API 등록은 필요 없다. 22·24·25·26의 새 화면에는 통합 시 같은 action props/기존 guard를 연결해야 하며 해당 기능 구현은 수정하지 않았다.

## 소유 변경 파일

복구·worker·시험:

- `web/app/api/client.ts`
- `web/app/routes/app.tsx`
- `web/app/components/pwa.tsx`
- `web/app/components/pwa/AuthRecovery.tsx`
- `web/app/components/pwa/ServerActionButton.tsx`
- `web/app/components/pwa/LifecycleBanner.tsx`
- `web/app/components/pwa/lifecycle.ts`
- `web/app/components/pwa/lifecycle.test.ts`
- `web/app/components/pwa/auth.test.ts`
- `web/app/components/pwa/presentation.test.ts`
- `web/app/components/pwa/update.test.ts`
- `web/app/components/pwa/pwa.css`
- `web/public/sw.js`
- `web/app/deployment/sw.test.ts`
- `web/e2e/pwa-lifecycle.spec.ts`
- `web/e2e/pwa-recovery.spec.ts`
- `work/RESULT-27.md`

나머지는 기존 서버 action props·버튼 연결만 변경했다. 페어링은 제출 callback의 미전송/결과 불명 안내 조건도 바로잡았다.

- `web/app/components/SessionView.tsx`
- `web/app/components/AgentRunsPanel.tsx`
- `web/app/components/ArchivedProjects.tsx`
- `web/app/components/BotsPanel.tsx`
- `web/app/components/ChangesPanel.tsx`
- `web/app/components/ContextMeter.tsx`
- `web/app/components/FilesView.tsx`
- `web/app/components/GitPanel.tsx`
- `web/app/components/GoalsPanel.tsx`
- `web/app/components/Login.tsx`
- `web/app/components/McpServers.tsx`
- `web/app/components/NotificationsPanel.tsx`
- `web/app/components/Pairing.tsx`
- `web/app/components/ProfileCapabilities.tsx`
- `web/app/components/ProfileCatalog.tsx`
- `web/app/components/ProfileContextPolicy.tsx`
- `web/app/components/ProjectLabels.tsx`
- `web/app/components/ProjectScripts.tsx`
- `web/app/components/ProjectView.tsx`
- `web/app/components/RecentPanel.tsx`
- `web/app/components/RemoteWatchesPanel.tsx`
- `web/app/components/SchedulesPanel.tsx`
- `web/app/components/ScopedSettings.tsx`
- `web/app/components/Settings.tsx`
- `web/app/components/SettingsReset.tsx`
- `web/app/components/TasksPanel.tsx`
- `web/app/components/TerminalView.tsx`
- `web/app/components/TrashPanel.tsx`
- `web/app/components/UsagePanel.tsx`
- `web/app/components/Workspace.tsx` (배치 다시 저장 버튼만, 생성 진입은 미변경)
- `web/app/components/WorktreesPanel.tsx`
- `web/app/components/files/ExternalEditor.tsx`
- `web/app/components/git/GitConfirmation.tsx`
- `web/app/components/hooks/HooksSettings.tsx`

## 실제 검증

검사마다 `source /data/project/paseodog_opus/.envrc.dev`를 적용했다. COMMON의 경로로 `web/node_modules` symlink만 만들었고 설치·복사는 하지 않았다.

1. 결함 재현:
   `python3 scripts/build.py test --vitest app/components/pwa/auth.test.ts`
   - 최초 8개 모두 실패, exit 1. 인증 전송이 guard를 우회하고 응답 protocol도 반영하지 않는 것을 확인했다. 이 실패를 통과로 계산하지 않는다.
2. 첫 구현 검사:
   `python3 scripts/build.py test --vitest app/components/pwa/auth.test.ts app/components/pwa/lifecycle.test.ts app/components/pwa/update.test.ts app/components/pwa/presentation.test.tsx app/deployment/sw.test.ts app/deployment/base.test.ts app/api/client.test.ts app/state/drafts.test.ts app/state/cleanup.test.ts app/state/fileState.test.ts app/state/projectScripts.test.ts app/components/approvals/ApprovalCard.test.ts app/components/approvals/decision.test.ts app/components/git/GitConfirmation.test.ts --typecheck`
   - typecheck 통과. 실행된 13개 파일 158개 시험 통과.
   - `presentation.test.tsx`는 기존 `app/**/*.test.ts` include에서 제외됐음을 출력과 설정으로 확인했다. 통과한 시험으로 취급하지 않고 JSX 없는 파일을 `presentation.test.ts`로 옮겼다.
3. action 연결 검사:
   `python3 scripts/build.py test --vitest app/components/pwa/presentation.test.ts app/components/hooks/HooksSettings.test.ts app/components/files/ExternalEditor.test.ts app/components/AgentRunsPanel.test.ts app/state/layoutPersistence.test.ts --typecheck`
   - typecheck 통과. 28개 중 27개 통과·외부 편집기 활성 조건 1개 실패, exit 1.
   - 순수 Controls가 PWA 전역 상태를 직접 읽던 연결을 FilesView의 명시적 `blockedReason` props로 수정했다. 기존 시험의 요구를 낮추거나 수정하지 않았다.
   - 뒤에 `&&`로 연결한 `node --check`는 이 호출에서는 미실행이었다.
4. 실패·변경된 시험 재검사:
   `python3 scripts/build.py test --vitest app/components/pwa/presentation.test.ts app/components/files/ExternalEditor.test.ts app/components/pwa/lifecycle.test.ts app/deployment/sw.test.ts --typecheck`
   - typecheck 통과. 4개 파일 72개 시험 통과: 표시/개인정보 6, 외부 편집기 4, lifecycle 14, worker 48.
   - 이어 실행한 `node --check web/public/sw.js`도 통과했다.
5. 인증 오류 안내와 실제 응답 유실 보강 뒤:
   `python3 scripts/build.py test --vitest app/components/pwa/auth.test.ts --typecheck`
   - typecheck 통과. 인증 시험 13개 통과.
6. `git diff --check`: 통과.

변경되지 않은 입력의 통과를 재사용하면 현재 선택 검증 범위는 18개 파일 197개 시험이다. 이는 단일 전체-suite 실행 결과나 브라우저 인수 결과가 아니다. 실제 worker source를 VM에서 실행한 단위 시험이며 브라우저 CacheStorage·service worker 실증으로 바꾸어 표현하지 않는다.

Rust 변경은 없어 선택 Rust 시험은 해당 없음이다. COMMON의 독립 단계 계약에 따라 E2E·전체 회귀·release·원격 서비스·실기기는 실행하지 않았다. 새 E2E는 타입 검사까지만 통과했다.

## TODO별 충족과 남은 조건

| ID | 이번에 연결·검증한 요구 | 미완료·외부 검증 |
|---|---|---|
| WEB-007 | auth 전송도 기존 호환 guard 사용, 응답 protocol 확인, 다른 탭 전환 안내, 문서 버전별 cache 보존·안전 회수 단위 시험 | 실제 다중 탭 전환·HTML meta hydration·구 lazy asset 응답·브라우저 재시작 인수는 새 E2E 실행 필요 |
| WEB-009 | 소유 서버 action 버튼의 이유·비활성 연결, 미전송/결과 불명 구분, 인증 전 초안을 읽지 않는 cold-start 안내와 명시적 복구, 인증 세대·singleflight·원래 요청 키 회귀 | offline cold start→같은 계정 인증→기존 초안 복원은 브라우저 미검증. 22 소유 생성 진입 등 다른 기능 버튼의 최종 연결·일부 기존 전송 경계는 아래에 명시 |
| WEB-016 | 단일 구 탭·버전 불명·다중 탭·탭 종료·모두 전환·대기 cache·현재 shell 유실을 구분한 회수 단위 시험, 보존 한계 안내 유지 | 실제 quota 한계·eviction·저장 정책·디스크 오류·브라우저 lifecycle은 미검증. 모든 저장 데이터 삭제와 첫 방문은 구분 불가 |

## 한계·blocker·다음 통합 단계

- **브라우저 인수 대기:** COMMON이 독립 단계 E2E를 통합으로 남긴다. 새 `web/e2e/pwa-recovery.spec.ts`는 cookie 없는 offline 재시작 시 초안 비노출·사본 보존·연결 후 무재전송·명시적 인증 복구·protocol 차단을 작성했다. `web/e2e/pwa-lifecycle.spec.ts`는 기존 action 차단 확인과 두 탭→새 탭 전환→구 탭만 남음→오프라인 exact asset 응답→모든 문서 전환 후 회수를 작성했다. 실행하지 않았으므로 실제 다중 탭·offline cold start 완료를 주장하지 않는다.
- 통합에서는 고정 포트를 독점한 뒤 `python3 scripts/build.py test --e2e e2e/pwa-recovery.spec.ts e2e/pwa-lifecycle.spec.ts e2e/pwa-update.spec.ts e2e/connection.spec.ts e2e/request-recovery.spec.ts`와 해당 승인 offline 흐름을 실행해야 한다. 루트·하위 경로 배포 브라우저 인수도 필요하다.
- **다른 기능 소유:** 22의 프로젝트/세션 생성 진입, 24·25의 새 실행/서버 업데이트 설정, 26의 브라우저 capability·권한 UI는 수정하지 않았다. 기존 공통 mutation guard는 이들 API의 fetch도 막지만, 다른 기능 생성 버튼 전체의 비활성 이유까지 이 작업이 연결했다고 주장하지 않는다. 기존 새 터미널·worktree 생성 버튼도 별도 UI 연결이 남는다.
- **기존 비-HTTP 경계:** TerminalView에서는 종료·명시적 재연결 버튼만 연결했다. 이미 열린 WebSocket의 키보드 입력·resize 전송 경로는 action props/버튼 범위를 넘어 수정하지 않았다. 알려진 protocol 불일치 중 기존 socket 입력까지 차단하는 보장은 아직 없으며, “모든 서버 변경”을 WebSocket까지 포함하는 인수에는 이 경계 연결이 추가로 필요하다. 실행·재연결 로직을 임의로 재설계하지 않았다.
- cache는 인증·대화·초안을 담지 않는다. 버전 불명 탭·정지된 탭·메시지를 보내지 않는 구 UI가 남으면 안전을 우선해 회수를 보류한다. 따라서 무제한 갱신 중 cache 공간의 고정 상한을 보장하지 않는다. 사용자가 입력을 보관한 뒤 탭을 갱신/종료하고 현재 탭의 다음 상태 확인에서 회수를 진행한다. 사이트 데이터 전체 자동 삭제는 하지 않는다.
- cold-start 안내는 인증 없이 기존 초안을 열어 주는 기능이 아니다. 삭제된 데이터 복구, 초안의 영구 보관, 인증되지 않은 로컬 초안 목록 제공, 전체 사이트 데이터 삭제 후 유실 감지는 제공하지 않는다.
- 원격 logout을 전송하지 못하면 서버 refresh 쿠키 폐기 성공을 보장하지 않는다. 같은 실행 문맥의 `lastAuthEnd === "logout"` 억제는 유지하며 새 영구 자격/저장 방식이나 자동 폐기 큐를 만들지 않았다. 브라우저 재시작을 포함한 원격 기기 폐기 인수는 별도다.
- microphone 녹음·음성 입력·STT는 추가하지 않았다. 기존 TTS와 microphone 차단 코드는 변경하지 않았다. 해당 실기기 동작을 새로 검증했다고 주장하지 않는다.

이 인계와 관련 변경만 한국어 로컬 커밋으로 남기고 편집을 종료한다. 이 문서에 자기 커밋 SHA를 넣기 위한 순환 수정은 하지 않는다.
