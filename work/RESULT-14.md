# b02 / 14 — PWA 수명주기 인계

## 기준·상태
- worktree: `<세션 worktree 루트>/b02-14-pwa-lifecycle`
- branch: `parallel/b02-pwa-lifecycle`
- 공통 기준 SHA: `bc797b36cd0c09ce41eb675d7d152ce95ffa7ef1` (작업 시작 HEAD와 merge-base 모두 일치)
- 원본 `work/README.md`의 경로·브랜치가 함께 일치하는 14번을 선택했다. 시작 시 변경 없음, 같은 checkout의 다른 개발 세션 없음.
- 상태: 소유 범위 구현 종료, **통합·컴파일·행동 검증 대기 / blocker 있음**. TODO 완료 판정은 하지 않았다.
- push·merge·배포·서비스 중단·다른 작업 파일 편집은 수행하지 않았다. 아래 첫 검사에서 npx의 자동 설치 시도를 발견해 취소한 사실은 별도로 보존하며, 별도 의존성 설치는 실행하지 않았다.

## 제공 동작
- root에서 서버 연결·오프라인·저장 정책·관측한 데이터 유실·앱 cache 유실을 표시한다. 경고가 겹치거나 workspace 높이가 화면 밖으로 밀리지 않도록 전용 CSS와 root wrapper를 연결했다.
- 기존 공개 `/api/v1/health`의 `protocol`과 응답 protocol 헤더를 재사용한다. 최초 확인, online/focus/visible 복귀, 보이는 탭의 30초 간격에 조회한다. 서버 빌드 `version` 차이 자체는 차단 사유가 아니다.
- Composer는 호환 확인 전·오프라인·서버 연결 실패·protocol 불일치일 때 전송/결과 확인/서버 초안 저장/첨부 업로드 진입을 비활성화한다. 단축키·slash 실행 직전에도 검사한다. textarea는 부모가 원래 차단한 경우를 제외하고 계속 편집할 수 있다.
- 복구는 health 조회만 한다. 대기 전송이나 승인·도구 실행을 자동 재전송하지 않는다. 기존 idempotency key·결과 불명 복구 계약은 바꾸지 않았다.
- 초안 Store 대역은 기존 `state/drafts.ts`에 주입한다. 실제 쓰기의 quota 오류와 접근 거부를 구분해 알리고 오류를 다시 던진다. 저장 공간 검사 성공만으로 실패한 초안의 저장 성공을 주장하지 않는다.
- `navigator.storage` 미지원, 정책 조회 거부, best-effort, origin 영구 보관을 구분한다. 영구 보관도 localStorage 초안의 삭제 방지 보장으로 표현하지 않는다.
- localStorage와 가능한 경우 sessionStorage의 `grove.pwa.storage-seen` 표식으로 관측한 삭제를 감지한다. 원인을 eviction이라고 단정하지 않는다. 모든 저장소 삭제 후 재방문과 첫 방문은 구분 불가능하다고 안내한다.
- service worker 등록을 중복하지 않고 `updateViaCache: "none"`을 사용한다. 등록/갱신/설치 실패를 안내한다. 업데이트 선택 없는 controllerchange는 reload하지 않는다. 사용자 선택은 한 번만 전환하고 오프라인에서는 업데이트 버튼을 비활성화한다.
- 제어 중인 worker의 HTML을 새 서버 HTML과 섞지 않는다. 정상 navigation은 해당 worker의 shell을 유지하고 HTTP 오류는 그대로 반환한다. 자기 shell 유실 시 온라인 응답을 구 cache에 넣지 않고 사용하며, 오프라인에는 실행 불가능한 이유와 복구 한계를 담은 503 HTML을 반환한다.
- 다중 탭에서 이전 shell을 실행하는 탭의 lazy asset을 지우지 않는다. 이전 cache의 정확한 asset URL만 재사용하고, 신규 미등록 asset을 구 버전 cache에 추가하지 않는다. 이전 HTML을 fallback으로 재사용하지 않는다.
- `/`, `/grove/`, `/grove/child/` 단위 시험을 유지·추가했다. API/non-GET/다른 origin/다른 scope는 계속 worker cache 대상 밖이다.

## 소유 변경 파일
- `web/app/components/pwa.tsx`
- `web/app/components/pwa/lifecycle.ts`
- `web/app/components/pwa/LifecycleBanner.tsx`
- `web/app/components/pwa/pwa.css`
- `web/app/components/pwa/lifecycle.test.ts`
- `web/app/components/pwa/update.test.ts`
- `web/app/deployment/sw.test.ts`
- `web/public/sw.js`
- `web/app/root.tsx` (안내 mount와 전용 wrapper 한 곳)
- `web/app/components/Composer.tsx` (PWA 작업 차단·초안 Store 연결)
- `web/e2e/pwa-lifecycle.spec.ts`
- `work/RESULT-14.md`

`src/web.rs`, `web/scripts/stamp-sw.mjs`, API/권한/인증/store/다른 화면/의존성/lockfile/공통 설정/`TODO.md`는 변경하지 않았다.

## export·입출력·오류·권한
- `LifecycleBanner()`는 props 없는 root 안내다. effect의 `startLifecycle()`이 구독·주기 조회를 시작하고 cleanup한다.
- `LifecycleState`, `StorageIssue`, `lifecycleSnapshot()`, `useLifecycle()`은 online/connection/protocol/storageIssue/storageApi/persistence/shell 상태를 제공한다.
- `serverBlockReason(state)`, `useServerBlockReason()`은 실행 불가 이유 또는 `null`을 반환한다. `requireServerAction()`은 브라우저의 현재 online 값까지 재확인하며 `ApiError`를 던진다. 코드: `offline`, `protocol_mismatch`, `server_unavailable`; 전송하지 않았으므로 `result_unknown: false`.
- `localDraftStorage()`는 `getItem/setItem/removeItem/key/length`를 가진 안정된 Store 또는 접근 불가 시 `null`이다. 기존 저장소 내용을 이관하거나 삭제하지 않는다. `storageFailure(error)`는 quota 이름을 구분한다.
- `inspectLocalDrafts()`, `inspectStoragePolicy()`는 상태만 갱신한다. `checkCompatibility()`는 진행 중 health 조회를 합치며 timeout은 10초다. 네트워크/HTTP/형식 오류는 `unreachable`로 표시한다.
- `registerServiceWorker()`, `applyUpdate()`, `ProtocolBanner()`, `UpdateBanner()`의 기존 연결은 유지했다. `checkForUpdate()`를 추가했다. 프로토콜 안내의 새 UI 확인과 업데이트 선택을 분리했다.
- worker message: 요청 `{ type: "shell-status" }`, 응답 `{ type: "shell-status", cached: boolean }`; 현재 controller의 메시지만 반영한다. 기존 `{ type: "skip-waiting" }`은 사용자 동의 경로에서 보낸다.
- 서버 mutation 차단은 기존 `api/client.ts`의 protocol guard를 재사용한다. 새 API·권한 완화·fetch/Storage 전역 monkey patch·자격증명 저장은 없다.
- 애니메이션은 추가하지 않았다. 즉시 읽어야 하는 상태·경고이며 기존 UI 동작과 접근성을 우선했다.

## 실제 검사 결과
1. `python3 scripts/build.py test --vitest app/deployment/sw.test.ts`
   - navigation 버전 고정 회귀를 먼저 추가한 뒤 실행했다.
   - 의존성이 없어 `npm warn exec The following package was not found and will be installed: vitest@5.1.0`가 출력됐다.
   - COMMON의 설치 금지에 따라 즉시 취소, exit 137. 테스트는 통과도 red 확인도 하지 못했다. 자동 설치를 승인·재시도하지 않았다. worktree의 의존성/lockfile 변경 없음.
2. `python3 scripts/build.py test --vitest app/components/pwa/lifecycle.test.ts app/components/pwa/update.test.ts app/deployment/sw.test.ts app/deployment/base.test.ts app/api/client.test.ts app/state/drafts.test.ts --typecheck`
   - `npm run typecheck`가 `sh: 1: react-router: not found`로 exit 127.
   - 실행기가 typecheck 실패 뒤 `미실행: vitest`를 보고했다. 타입·컴파일·선택 Vitest 통과 근거 없음.
3. `node --check web/public/sw.js`: 통과. JavaScript 구문 검사일 뿐 worker 행동 검증은 아니다.
4. `git diff --check`: 통과.
5. E2E는 COMMON에 따라 통합 단계로 남겼다. 새 `web/e2e/pwa-lifecycle.spec.ts`의 오프라인 입력/버튼·단축키 차단/복구 후 무재전송, health protocol 불일치, 초안 쓰기 quota 오류, storage/cache 유실, 구→신 worker 전환·초안 복원은 **작성만 했으며 미실행**이다.
6. Rust 변경 없음: 선택 Rust 시험은 해당 없음. release·전체 회귀·실기기·원격 호스팅 검사는 실행하지 않았다.

## TODO별 판정·남은 요구
| ID | 제공 구현 | 남은 완료 조건 |
|---|---|---|
| WEB-007 | 기존 protocol guard 재사용, health 사전 확인, Composer 차단, 호환 build 허용, 사용자 선택 갱신, 버전 shell 고정 | typecheck/Vitest/E2E, 다중 탭 실제 브라우저 전환, auth 등 Composer 밖 변경 진입점의 호환 사전 확인 |
| WEB-009 | 열린 탭의 오프라인 편집·로컬 초안 저장·전송/서버 저장/첨부 차단·복구 후 무재전송, cache 없는 오프라인 복구 화면 | 승인·도구 실행·그 외 서버 작업 버튼과 공통 전송 경계 연결, 오프라인 cold start의 기존 초안 접근 계약, 행동 검증 |
| WEB-016 | quota/접근 거부/정책 미지원/관측한 유실/cache 유실 구분과 보존 한계 안내 | typecheck/Vitest/E2E, 실제 브라우저 quota/eviction/저장 정책 확인, 다중 탭 구 cache 정리 정책 인수 |

세 항목 모두 `[ ]` 유지 대상이다. 인접 WEB-014/기존 WEB-015 역시 이 변경의 미실행 검사를 기존 통과 근거로 대체하면 안 된다.

## 통합 단계·blocker
1. 제공된 환경에는 웹 의존성이 없다. 승인된 공통 환경에서 위 선택 typecheck/Vitest를 먼저 실행해야 한다. 새 모듈은 root/Composer에 연결돼 있지만 실제 컴파일 통과는 확인하지 못했다.
2. COMMON은 `api/client.ts`, `approvals/ApprovalCard.tsx`, 다른 도구 실행 화면·SessionView 편집을 14번에 허용하지 않는다. 통합 담당이 `useServerBlockReason()`을 각 버튼의 disabled/이유에, `requireServerAction()`을 실행 직전에 연결해야 한다. **현재 승인·다른 서버 작업 버튼 전체가 오프라인 비활성화된 것은 아니다.** 공통 API에서도 offline 변경 요청이 fetch에 도달하지 않도록 기존 인증·idempotency·복구 계약에 맞춰 연결해야 한다.
3. 현재 AppRoute는 cold start 시 refresh 실패로 로그인 화면을 표시한다. 인증·세션 목록이 메모리에 남은 열린 탭의 오프라인 초안은 제공하지만, 닫았다가 오프라인으로 재실행한 뒤 로컬 초안 목록까지 여는 기능은 제공하지 않는다. 인증되지 않은 사용자에게 로컬 초안을 노출하지 않는 복구 계약과 소유 범위가 필요하다.
4. 다중 탭에서 남긴 이전 cache는 다음 단일 탭 activation 때 정리한다. 모든 탭을 계속 열고 업데이트를 반복하면 cache 사용량이 증가할 수 있다. 입력 보존을 위해 자동 사이트 데이터 삭제는 하지 않는다. 통합에서 다중 탭·quota·cache 삭제 흐름을 확인해야 한다.
5. E2E는 통합 환경에서 고정 포트를 독점해 `python3 scripts/build.py test --e2e e2e/pwa-lifecycle.spec.ts e2e/pwa-update.spec.ts e2e/connection.spec.ts e2e/request-recovery.spec.ts`를 실행한다. 루트/하위 경로 배포, 좁은 화면의 안내·composer 높이, 승인·도구 실행 차단 연결까지 인수한 뒤 TODO를 판정한다.
6. 브라우저 데이터 전체 삭제 후 과거 유실 감지, 삭제된 초안 복구, 영구 초안 보존, 실제 서버 작업 중단은 보장하지 않는다. 서버 상태 변경 API·권한 정책은 변경하지 않았다.

인계를 끝으로 편집을 종료한다. 통합·push·배포·worktree 정리는 수행하지 않는다.
