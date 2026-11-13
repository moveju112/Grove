# 26 — WEB-010 브라우저 기능·권한 차이 표시

## 작업 식별·상태

- 배치/번호: b02 / 26.
- Worktree: `<세션 worktree 루트>/b02-26-browser-caps`.
- Branch: `parallel/b02-browser-caps`.
- 공통 기준: `7b3949d24e420d09e6e4cde29405414b2d99253a`. 시작 시 실제 경로·브랜치·clean 상태와 기준 ancestry를 확인했다.
- 상태: 구현 종료, 선택 Rust·Vitest·typecheck 통과. 실제 브라우저 E2E는 COMMON 계약에 따라 통합 단계 실행 대기이며 검증 완료로 간주하지 않는다.
- 구현 blocker는 없다. 실제 브라우저·플랫폼별 권한 동작과 시각적 검증은 아직 미확인이다.

## 소유 변경 파일·연결

| 경로 | 제공 동작 |
| --- | --- |
| `web/app/components/capabilities/browser.ts` | 부작용 없는 탐지·권한 조회/구독, 사용자 동작 전용 알림 요청·원문 복사, 첨부 미지원 안내 |
| `web/app/components/capabilities/BrowserCapabilities.tsx` | 이 기기 기능표·수동 새로 확인·focus/visibility/권한 변경 갱신 |
| `web/app/components/capabilities/MessageCopyButton.tsx` | 복사 성공 표시, 미지원·차단·실패 시 선택 가능한 읽기 전용 원문과 수동 복사 안내 |
| `web/app/components/capabilities/capabilities.css` | 기능표 전용 가로 스크롤·기존 색상 변수 기반 표시 |
| `web/app/components/capabilities/browser.test.ts` | 가짜 navigator/window·권한 상태·실패 분기·표시 단위 시험 11개 |
| `web/app/components/Settings.tsx` | 기기·연결 메뉴에 이 기기 범위 `browser-capabilities` 항목 등록·mount 한 곳, 기존 NotifyPrefs의 요청/대안 연결 |
| `web/app/components/SessionView.tsx` | 기존 메시지 원문 CopyButton을 새 MessageCopyButton으로 교체한 한 진입점 |
| `web/app/components/Attachments.tsx` | 기존 AttachmentPicker 클릭에서 지원 확인·대안 안내, 드래그 대신 일반 첨부 안내 |
| `web/e2e/browser-capabilities.spec.ts` | 실제 권한 허용·거부 context 2개, API 미지원 대안 1개, 비보안 신호 1개: 총 4개 시나리오 |
| `work/RESULT-26.md` | 이번 인계 |

추가 공통 파일 연결은 필요하지 않다. 서버·API·store·dependency/lockfile·TODO는 변경하지 않았다.
기존 Markdown 코드 블록 등 다른 복사 진입점은 할당된 한 곳 제한에 따라 변경하지 않았다.
마이크 녹음·음성 입력·STT는 추가하지 않았고 기존 마이크 차단·TTS도 변경하지 않았다.
저장소 quota·service worker·오프라인 수명 주기는 다루지 않았다.

## 공개 인터페이스·권한 계약

- `BrowserCapabilitiesSettings()`: 외부 props 없는 기기 설정 mount.
- `BrowserCapabilitiesPanel({ snapshot: BrowserCapabilities })`: 주입된 typed snapshot만 표시하는 패널.
- `useBrowserCapabilities()`: `[BrowserCapabilities | null, refresh]`. mount·focus·visible 복귀·사용자 새로 확인에서 관찰자를 교체하고 unmount 시 구독과 늦은 응답을 정리한다.
- `BrowserEnvironment` / `BrowserCapabilities` / `BrowserCapability` / `CapabilityId` / `Permission`: 테스트 가능한 브라우저 입력과 표시 snapshot 계약. 서버 상태·저장 데이터는 받지 않는다.
- `browserEnvironment()` / `detectBrowserCapabilities(env?)`: API 존재와 `window.isSecureContext`를 읽는다. 파일 입력 요소 생성·타입 확인만 하며 클릭·읽기·picker 호출은 하지 않는다.
- `observeBrowserCapabilities(env, publish)`: 최초 snapshot을 동기 발행하고, 지원·보안 조건을 충족할 때만 `Permissions.query`로 notifications·clipboard-read·clipboard-write를 조회한다. 반환값은 구독 해제 함수다. 조회 미지원/실패는 미확인으로 남기며 거부로 바꾸지 않는다.
- `capabilityIssue(snapshot, item)` / `currentNotificationIssue(snapshot | null)`: 비보안·미지원·거부의 원인별 안내를 반환한다. 비보안 때문에 API가 숨겨진 경우 브라우저 자체 미지원으로 확정하지 않는다.
- `requestNotificationAccess(env?)`: 사용자 클릭에서만 실행. 미결정일 때 `Notification.requestPermission()`을 호출하고, 이미 허용이면 재요청하지 않으며 거부·미지원·비보안이면 요청 없이 대안을 반환한다. 결과는 `{ permission?, message? }`; 요청 예외는 안전한 안내로 반환한다.
- `copyMessageText(text, env?)`: 사용자 클릭에서만 실행. 성공을 기다린 뒤 `{ copied: true }`; 미지원·비보안·차단·실패는 `{ copied: false, message }`. 권한 query를 먼저 await하지 않아 사용자 활성화를 보존한다. Clipboard 읽기는 실행하지 않는다.
- `MessageCopyButton({ text: string })`: 기존 `msg-copy` test ID·원문 복사 계약 유지. 실패를 성공으로 표시하지 않는다. 수동 원문은 읽기 전용 textarea에 표시·focus·전체 선택하고 HTML로 실행하지 않는다.
- `attachmentIssue(env?)`: 일반 파일 선택·읽기에 필요한 지원 여부만 검사한다. File System Access API 미지원 때문에 일반 첨부를 차단하지 않는다.
- API 호출 실패 메시지에 브라우저 원시 예외·사용자 데이터·자격증명은 넣지 않는다.

## WEB-010 요구 충족 근거

| 요구 | 구현·검증 근거 | 남은 검증 |
| --- | --- | --- |
| 현재 브라우저 지원 차이 | 알림, Clipboard readText/writeText, 파일 선택, 드래그, 파일 시스템 열기·저장·폴더 접근을 각각 표시. 선택/드래그는 Grove 업로드에 필요한 File.arrayBuffer도 확인. 가짜 navigator/window 및 개별 API 조합 단위 시험 통과 | 실제 브라우저별 렌더링 |
| 권한 허용·거부·미결정 구분 | Notification.permission 기본값 및 지원되는 Permissions API의 granted/denied/prompt, 조회 불가·미확인, 파일별 선택 권한, 별도 사이트 권한 없음 구분. 변경 구독·해제·늦은 결과·조회 예외 단위 시험 통과 | 실제 허용·거부 context E2E |
| 보안 컨텍스트 구분 | 실제 isSecureContext를 사용. HTTPS/localhost 필요와 일반 파일 선택·드래그의 비요구를 분리. 미노출 API는 보안 컨텍스트에서 재확인 안내. 비보안·미노출 단위 시험 통과 | 실제 원격 일반 HTTP·각 브라우저 |
| 탐지 무부작용 | 탐지·렌더·권한 query에서 requestPermission·Clipboard read/write·파일 picker를 호출하지 않는 단위 시험 통과. 파일/폴더 개별 권한 조회를 위해 handle을 만들지 않음 | 설정 열기·새로 확인 무부작용 E2E |
| 의도적인 권한 요청 | 알림 종류 활성화 또는 알림 허용 버튼만 요청 함수 호출. 거부·미지원·비보안·예외·허용된 상태·사용자 취소 단위 시험 통과 | 실제 브라우저 클릭 흐름 |
| 미지원·거부 시 대안 | 알림 목록·대화 상태/별도 소리, Clipboard 읽기 대신 입력란 붙여넣기, 메시지 원문 수동 복사, 드래그 대신 첨부 버튼, 파일 시스템 대신 일반 첨부·원문 다운로드·개별 파일 안내. 복사·첨부 실패 분기 단위 시험 통과 | 수동 선택·첨부 대안 E2E |

WEB-010 전체 구현은 연결됐지만 E2E·실기기 확인은 남았다. 이 문서만으로 TODO 완료 체크를 요청하지 않는다.

## 실제 실행 검증

환경은 메인의 기존 의존성을 재사용했다. `web/node_modules`는 `<원본 저장소>/web/node_modules`, `.dev`는 `<원본 저장소>/.dev`로 향하는 Git ignore symlink다.
`.dev` 연결은 빌드 실행기가 worktree의 `.dev` 경로를 사용하는 계약 때문에 필요했다. 설치·복사·dependency 갱신은 하지 않았다.

1. `source <원본 저장소>/.envrc.dev && python3 scripts/build.py test --vitest app/components/capabilities/browser.test.ts app/state/attention.test.ts --typecheck`
   - 최초 실패: typecheck에서 배열 접근 결과의 undefined 가능성 TS2345 2건. 이때 Vitest는 실행기에서 중단되어 미실행이었다.
   - 수정 후 동일 명령 성공: typecheck 통과, 신규 11개 + 기존 알림 3개 = Vitest 14개 통과.
2. `source <원본 저장소>/.envrc.dev && CARGO_TARGET_DIR=<원본 저장소>/target flock /home/ubuntu/.cache/grove-rust-check.lock python3 scripts/build.py test --rust web_base`
   - 컴파일 포함 성공. `deployment_base_is_a_safe_path`, `static_mount_preserves_api_and_asset_boundaries` 2개 통과. 이후 Rust 관련 입력은 변경하지 않아 결과 재사용.
3. 최종 웹 변경 후 `source <원본 저장소>/.envrc.dev && python3 scripts/build.py test --vitest app/components/capabilities/browser.test.ts --typecheck`
   - 성공. typecheck 및 신규 11개 통과. E2E 파일도 tsconfig 범위에 포함되어 타입 검사됨.
   - 기존 알림 3개의 코드·시험 입력은 그대로여서 앞선 통과 결과 재사용.
4. `git diff --check`: 통과.

E2E·전체 회귀·release·패키징은 COMMON에 따라 실행하지 않았다.
웹 production build, Safari/Firefox·iOS/Android 실기기, 실제 비보안 origin의 사용자 흐름도 미검증이다.
추가 dependency 설치나 권한 정책 우회는 하지 않았다.

## 통합 단계

- 기존 Settings 등록/mount 및 세 진입점 변경을 보존해 병합한다.
- 공통 고정 포트 소유가 확보된 통합 단계에서 `source <원본 저장소>/.envrc.dev && python3 scripts/build.py test --e2e e2e/browser-capabilities.spec.ts e2e/attention.spec.ts e2e/markdown.spec.ts e2e/attachments.spec.ts`로 신규 상태·기존 알림/복사/첨부 흐름을 확인한다.
- 신규 E2E의 비보안 시나리오는 localhost에서 isSecureContext 신호를 제어하는 시험이지 실제 원격 HTTP 보안 정책 시험은 아니다.
- 파일 시스템 권한은 선택한 handle별이므로 탐지로 사전 허용을 확정하지 않는다. Clipboard 권한 descriptor 미지원 브라우저는 계속 미확인으로 표시하는 것이 의도된 계약이다.
- 통합 담당이 실제 브라우저 검증 결과와 남은 플랫폼 범위를 판단한 뒤 TODO를 반영한다.
