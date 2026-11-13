# b02 / 18 — 터미널 모바일 입력 인계

## 상태·기준
- 상태: 구현 종료, 통합 검증 대기. 코드·단위 시험·typecheck blocker는 없다. 실제 PTY E2E와 모바일 실기기 검증은 남아 있다.
- worktree: `/home/ubuntu/.local/share/paseodog/paseo/worktrees/0q796rug/b02-18-terminal-input`
- branch: `parallel/b02-terminal-input`
- 공통 기준 SHA: `bc797b36cd0c09ce41eb675d7d152ce95ffa7ef1` (시작 HEAD·merge-base 모두 일치).
- 원본 프로젝트·서버·공통 CSS·dependency/lockfile·TODO는 변경하지 않았다. push·merge·배포·서비스 조작은 하지 않았다.

## 제공 동작·소유 변경
| 파일 | 동작 |
|---|---|
| `web/app/components/TerminalView.tsx` | xterm의 onData와 보조키를 동일 입력 경로로 연결. clipboard paste를 capture 단계에서 받아 여러 줄 확인 후 xterm.paste에 전달. mount·연결 실패·연결 끊김에서 보조키 초기화, listener 정리. |
| `web/app/components/terminal/input.ts` | 동기식 one-shot Ctrl/Alt 상태, 문자·Esc·Tab·화살표 변환, paste 승인·키 변환 우회, IME input 중복 경로 차단. |
| `web/app/components/terminal/TerminalKeys.tsx` | 44px 최소 크기 보조키, 줄바꿈 배치, aria-pressed·다음 키 한 번 적용 안내·해제 버튼. 포인터 조작 시 기존 textarea 포커스 유지. |
| `web/app/components/terminal/input.test.ts` | 키 변환·연속 입력·한글/Unicode·paste 승인/취소/순서·IME 이벤트 중복 방지·listener 해제 27개 시험. |
| `web/e2e/terminal-input.spec.ts` | 모바일 viewport/터치 환경의 실제 raw PTY 누적 바이트 검증 시나리오. 미실행. |
| `work/RESULT-18.md` | 이 인계. |

기존 `.term-keys`의 `@media (pointer: fine)` 표시 규칙을 유지했다. 애니메이션은 입력 지연과 시각적 잡음을 피하려고 추가하지 않았다.
기존 출력·fit/resize·snapshot/reset·일회용 ticket·재연결·저장 화면·TerminalCapture 경로는 유지했다.

## 공개 계약·연결
- `Modifiers`, `NO_MODIFIERS`, `AUXILIARY_KEYS`, `applyModifiers(data, modifiers)`를 export한다. 보조키 없는 문자열·데스크톱 키 시퀀스는 변경하지 않는다. Ctrl은 ASCII 제어문자로, Alt는 ESC 접두사로, 보조키+화살표는 CSI modifier 형식으로 변환한다. 여러 문자가 한 번에 들어오면 첫 Unicode code point에만 문자 보조키를 적용한다.
- `TerminalInput(send, changed)`는 `toggle`, `reset`, `data`, `paste`를 제공한다. 상태는 React 재렌더를 기다리지 않고 소모된다. 빈 입력은 보조키를 소모하지 않고 특수키는 소모한다. 고정 모드는 없다.
- `paste(text, confirm, pasteCallback)`은 CR/LF가 있으면 확인하고, 거절·빈 입력이면 `false`를 반환하며 전송하지 않는다. 승인된 원문은 동기식 callback에 전달한다. callback 실행 중 onData는 변환하지 않으며 대기 중인 보조키도 소모하지 않는다. callback 예외는 전파하되 paste 상태는 finally에서 복구한다.
- 줄바꿈 정규화와 현재 bracketed paste mode 반영은 설치된 xterm의 공개 `paste` API를 재사용한다. 별도 escape 포맷 구현이나 WebSocket 프로토콜 변경은 없다.
- `guardComposition(host)`는 disposer를 반환한다. xterm의 compositionstart/update/end와 조합 UI·확정 타이밍은 유지하고, 조합 중 및 compositionend 직후 같은 이벤트 묶음의 중복 input 경로만 차단한다. 확정 문자열은 직접 전송하지 않고 xterm onData로만 전달한다.
- `TerminalKeys` props: `modifiers`, `onToggle(key)`, `onReset()`, `onKey(data)`. 상위 TerminalView에서 연결을 완료했다. 추가 mount·API·store 등록은 필요 없다.
- 서버 계약은 기존 `{ type: "input", data: string }` 그대로다. 기존 인증·일회용 ticket·서버 권한 검사를 재사용한다. 닫힌 소켓에는 전송하지 않으며 읽기 전용/연결 중 paste도 전달하지 않는다.

## 검증 근거
기존 `/data/project/paseodog_opus/web/node_modules`를 task-owned 임시 symlink로 참조했다. 설치·복사는 하지 않았고 검증 후 해당 symlink를 제거했다. 각 검사 전에 `source .envrc.dev`를 적용했다.

| 실제 명령·입력 | 결과 |
|---|---|
| `source .envrc.dev && python3 scripts/build.py test --vitest app/components/terminal/input.test.ts --typecheck` (최초) | typecheck 통과, Vitest 26 통과/1 실패. Node EventTarget의 boolean capture listener 제거 차이로 cleanup 시험 실패. |
| Node EventTarget 최소 재현: 동일 listener의 add/remove capture 인자를 `true`와 `{capture:true}`로 비교 | boolean은 제거 후 1회 호출, options 객체는 0회 호출. guard의 등록·해제에 명시적 capture options 객체를 사용하도록 수정했다. |
| `source .envrc.dev && python3 scripts/build.py test --vitest app/components/terminal/input.test.ts --typecheck` (수정 후) | typecheck 통과, 선택 Vitest 27/27 통과. |
| `source .envrc.dev && python3 scripts/build.py test --typecheck` (최종 표시 규칙 보존 수정 후) | 통과. input 구현·단위 시험 입력은 이전 통과 이후 변경하지 않았다. |
| Python UTF-8 인코딩으로 E2E의 `한글`, bracketed `붙임`, CR로 정규화한 여러 줄 기대 바이트를 독립 계산 | E2E의 고정 기대 hex와 일치. PTY나 브라우저 실행을 대체하는 근거는 아니다. |

Rust는 서버/프로토콜 변경이 없어 미선택했다. E2E·전체 회귀·release/패키징은 COMMON에 따라 독립 단계에서 실행하지 않았다.
다른 개발 세션 상태 조회는 런타임의 `session: cross-session control is unavailable in this runtime` 오류로 확인하지 못했다. 시작 Git 상태는 깨끗했고 발견한 다른 세션 변경을 인수하지 않았다.

## TERM-005 남은 요구·통합 단계
- 키 변환, one-shot 상태, paste 확인/순서, IME 중복 input 방지는 선택 단위 시험으로 확인했다.
- 실제 브라우저+xterm 조합 확정이 PTY에 정확히 한 번 도착하는지, 터치 포커스·화면 배치·실제 bracketed paste·reload 후 입력 복구는 E2E 미검증이다. 단위 시험의 EventTarget은 브라우저/OS IME를 대신하지 않는다.
- 통합 담당은 공통 빌드 환경에서 `python3 scripts/build.py test --e2e e2e/terminal-input.spec.ts e2e/terminal-capture.spec.ts`를 순차 실행해야 한다. 신규 spec은 자체 390×844 viewport·isMobile·hasTouch를 지정하므로 공통 Playwright 설정 변경이 필요 없다.
- 신규 E2E는 보조키의 raw 바이트·상태 소모, 네 화살표, 합성 한글 조합 이벤트, 한 줄/승인된 여러 줄 bracketed paste, 거절된 paste의 부재, 데스크톱 Ctrl+C, reload 후 modifier 초기화·PTY 지속을 검사하도록 작성했다. 시험 서버 호스트의 `python3`를 raw PTY 수집기로 사용한다.
- E2E 외에 Android/iOS 실제 한글 키보드·클립보드·선택 메뉴는 실기기 확인이 필요하다. 합성 composition/clipboard 이벤트를 실기기 검증으로 간주하지 않는다.
- `TERM-005` 전체 완료를 판정하지 않았고 `TODO.md`는 체크하지 않았다. 통합 담당이 위 검증과 남은 플랫폼 요구를 확인한 뒤 판정해야 한다.
