# b01 / 03 — assistant 이름·사진·기본 아이콘

## 배정·현재 상태

- Worktree: `/home/ubuntu/.local/share/paseodog/paseo/worktrees/0q796rug/b01-03-assistant-identity`
- Branch: `parallel/b01-assistant-identity`
- 공통 기준: `c186b31ab62734c9f91803cf7848b639ad9871fb`
- `ENTRY.md`와 `README.md`의 절대 경로·브랜치가 일치하는 유일한 행으로 03을 선택했다. `git rev-parse --show-toplevel`, `git status --short --branch`, `git merge-base HEAD c186b31ab62734c9f91803cf7848b639ad9871fb`로 확인했다. 시작 시 작업 트리는 깨끗했다.
- 상태: **독립 구현 종료·통합 대기. UI-013은 부분 구현이며 제품 기능 완료가 아니다.**
- 독립 구현을 막는 blocker는 없다. 의존성 부재와 공통 검증 제한 때문에 런타임 동작·타입·빌드는 미검증이다. `SessionView` 연결은 지정된 통합 담당 소유로 남겼다.
- 확인 가능한 세션 정보에서 현재 세션의 cwd가 이 worktree임을 확인했다. 다른 세션 목록 조회는 런타임이 `session: cross-session control is unavailable in this runtime`으로 거절했다. 다른 세션에 메시지·승인을 요청하지 않았다.

## 소유 변경 파일

- `web/app/components/assistant-identity/AssistantIdentity.tsx`
- `web/app/components/assistant-identity/AssistantIdentity.module.css`
- `web/app/components/assistant-identity/imagePolicy.ts`
- `web/app/components/assistant-identity/index.ts`
- `web/app/components/assistant-identity/AssistantIdentity.test.ts`
- `web/e2e/assistant-identity.spec.ts`
- `work/RESULT-03.md`

공통 파일·설정 저장소·API·dependency·lockfile·`TODO.md`는 변경하지 않았다. 코드 구조 분석·parser도 변경하지 않았다.

## 제공 동작·public 계약

`web/app/components/assistant-identity/index.ts`에서 `AssistantIdentity`와 `AssistantIdentityProps`를 named export한다.

| Prop | 타입·기본값 | 계약 |
|---|---|---|
| `name` | `string`, 필수 | React 텍스트로 표시한다. 바깥 공백을 제거하고 빈 값은 `어시스턴트`로 표시한다. HTML을 삽입하지 않는다. |
| `imageUrl` | `string \| null`, 선택 | 호출자가 기존 인증된 PNG 응답에서 생성한 현재 origin의 `blob:` object URL만 받는다. |
| `size` | `"sm" \| "md" \| "lg"`, 기본 `"md"` | 아이콘 크기는 각각 `1.25rem`, `1.75rem`, `2.5rem`이다. |
| `purpose` | `"label" \| "avatar" \| "decorative"`, 기본 `"label"` | 이름과 장식 이미지 / 이름 있는 단독 이미지 / 전체 장식용을 구분한다. |

- 이미지 없음·정책 위반·로딩 중에는 같은 크기의 기본 SVG 아이콘을 표시한다. `onLoad` 후 사진으로 바꾸고 `onError` 후 이미지를 제거한다.
- 같은 URL로 rerender되어도 실패한 이미지를 다시 삽입하지 않는다. URL이 실제로 바뀌면 keyed 하위 컴포넌트의 상태를 새로 시작한다.
- 이름이 보이면 사진·SVG는 `alt=""`·`aria-hidden`으로 중복 낭독을 막는다. `avatar` 용도는 wrapper에 `role="img"`와 assistant 이름을 지정한다. `decorative`는 wrapper 전체를 보조기술에서 제외한다.
- 긴 이름은 생략하지 않고 줄바꿈한다. `min-width: 0`, `max-width: 100%`, `overflow-wrap: anywhere`, bidi 격리를 사용한다. CSS module로 공통 스타일과 분리했다.
- API·fetch·저장·업로드·다운로드·로그 출력은 없다. 오류는 표시용 fallback으로 처리하며 throw·자동 재시도·오류 내용 노출은 하지 않는다.
- 임의 HTTP(S) URL, 동일 origin의 직접 API URL, 상대 경로, protocol-relative URL, `javascript:`, `data:`, `file:`, 다른 origin의 `blob:`, opaque origin, credentials/query/hash·비정규 경로는 거절한다. 거절된 URL로 `<img>`를 만들지 않는다.
- `imagePolicy.ts`의 `safeAssistantImageUrl`은 내부 정책 함수이며 barrel의 public export에는 포함하지 않았다.
- object URL 생성·인증·PNG 출처 확인·수명·폐기는 호출자 책임이다. origin 일치만으로 blob의 인증된 출처를 증명할 수는 없다.
- 반복되는 메시지 identity는 즉시 읽혀야 하므로 추가 애니메이션을 넣지 않았다.

## 실제 원천·필요한 통합

1. `src/bots.rs`의 `Bot`/`BotView`가 실제 `name`, `avatar_sha256`, `avatar_color`를 제공한다. `GET /api/v1/bots` 응답은 `{ bots, order_revision }`이다. `Session.bot_id`는 `src/sessions.rs`와 `web/app/api/generated.ts`에 이미 있다.
2. `src/bot_avatars.rs::get`의 `GET /api/v1/bots/{id}/avatar`는 `Principal` 인증을 요구한다. 저장된 이미지는 서버에서 정규화한 PNG이고 `image/png`, `nosniff`, private/no-cache를 사용한다. 사진이 없으면 404다. 인증·업로드 정책을 변경하지 않았다.
3. `web/app/components/BotsPanel.tsx`의 기존 `avatarUrl`은 `rawGet`으로 인증된 바이너리를 받아 PNG Blob의 object URL을 생성한다. `Avatar`는 이름·사진을 표시한다. 함수들은 현재 private이므로 새 폴더에 복제하지 않았다.
4. 통합 담당은 기존 avatar 로딩을 공통으로 추출해 재사용하고, `SessionView`의 기존 `bots` query projection을 `name`·`avatar_sha256`까지 확장해야 한다. 기존 `/bots/${id}/avatar` 읽기와 `rawGet`의 인증 갱신·인증 세대 검사를 유지해야 한다. 원본 API URL을 `img.src`나 query token으로 넘기지 않는다.
5. 공통 loader는 이미지 변경·삭제·unmount·인증 변경 시 object URL 소유권과 폐기를 정리해야 한다. 기존 `avatarUrls` Map은 전역 cache이고 명시적인 revoke/인증 수명 관리가 없으므로 그대로 확대 사용하지 않는다. 이 파일은 이번 소유 범위 밖이라 수정하지 않았다.
6. `web/app/components/SessionView.tsx`의 `MessageView`는 현재 assistant의 `.who`에 `모델 · <model>`을 표시한다. 이 assistant 분기에 `AssistantIdentity`를 넣고 기존 model·중간 응답 설명은 유지한다. user/tool/note를 assistant로 표시하지 않는다. `MessageView` 호출부에서 resolved identity props를 전달해야 한다.
7. `SessionView`의 `botId`와 기존 `bots` query를 재사용할 수 있다. `web/app/state/store.ts`는 `bot.changed`, `bot.seen`, `bot.order`에서 이미 `bots`를 invalidate한다. 사진·이름 변경을 기존 메시지에도 반영하고, pending 비동기 결과가 다른 봇·인증 세대에 적용되지 않게 해야 한다.
8. 일반 대화에는 조사한 `Settings.tsx`·device prefs·메시지 표시 경로에서 별도 assistant 이름·사진 설정 원천을 찾지 못했다. 새 저장소나 설정 키를 만들지 않았다. 일반 대화의 기존 model 표시는 유지하고 기본 identity의 `name` 선택은 통합 시 명시해야 한다.
9. `VirtualMessages`는 메시지 높이를 `ResizeObserver`로 측정한다. 통합 후 긴 이름·사진 변경·좁은 화면에서 줄바꿈과 읽기 위치를 함께 확인해야 한다. 스트리밍 `.partial` 표시의 identity 적용 여부도 통합 시 결정·검증한다.

## 검증 근거·미실행

| 검사 | 입력·결과 |
|---|---|
| `git diff --check` | 실행, exit 0. 당시 신규 untracked 파일의 동작 검증 근거로 사용하지 않는다. |
| `git diff --cached --check` | 코드·시험 6개 파일을 명시적으로 stage한 뒤 실행, exit 0. 공백 검사만 통과했다. |
| `python3 scripts/build.py test --vitest app/components/assistant-identity/AssistantIdentity.test.ts --dry-run` | 실행, exit 0. `npx vitest run app/components/assistant-identity/AssistantIdentity.test.ts` 선택을 확인했을 뿐 실제 시험을 실행하지 않았다. |
| Vitest | 미실행. 이 worktree의 `web/node_modules`가 없다. 설치·복사·우회 실행을 하지 않았다. |
| Typecheck·웹 build | 미실행. `COMMON.md`에서 통합 단계로 지정했다. |
| Playwright E2E | 미실행. `COMMON.md`에서 통합 단계로 지정했고 실제 `SessionView`도 미연결이다. 서버·브라우저·고정 포트 작업을 시작하지 않았다. |

작성한 단위 시험은 URL 허용·차단, HTML 텍스트 escaping, 빈 이름, 접근성 용도, 로딩 초기 fallback, 크기별 긴 이름 보존, browser origin 없는 렌더링을 다룬다. 실제 load/error 이벤트·CSS 렌더링을 단위 시험 통과로 주장하지 않는다.

작성한 E2E는 기존 실제 봇/사진/세션/턴 API와 로컬 모델 fixture를 사용한다. 존재하지 않는 제품 API나 시험 전용 화면·컴포넌트 실행기를 만들지 않았다. 디코딩 실패만 해당 봇의 기존 avatar 응답을 가로채 주입한다. 다음을 실제 assistant 메시지에 요구한다:

- 설정된 이름의 literal 표시, 기본 아이콘, user 항목과 구분.
- 사진 설정·삭제·재설정의 기존 메시지 반영.
- 인증된 same-origin blob 사진, 장식 이미지 접근성, 긴 이름의 390px 화면 표시와 새로고침 복원.
- HTTP 성공이지만 PNG 디코딩이 실패하는 응답에서 기본 아이콘 복귀, 다음 응답에서도 추가 네트워크 요청이 없는 처리.

E2E는 `SessionView` 연결 전에는 통과하지 않는 통합 인수 시험이다. skip이나 가짜 성공을 넣지 않았다.

## TODO 충족 범위·다음 단계

`UI-013`은 **미완료**다. props 기반 안전한 표시 구현과 시험 코드는 제공했지만 실제 대화·설정 원천 연결, 이미지 loader 수명 관리, 타입·빌드·브라우저 검증이 남아 있다. `TODO.md`는 체크하지 않았다.

통합 담당은 위 공통 연결을 마친 뒤 다음 선택 검사를 실행해야 한다:

```bash
python3 scripts/build.py test --vitest app/components/assistant-identity/AssistantIdentity.test.ts --typecheck
python3 scripts/build.py test --e2e e2e/assistant-identity.spec.ts e2e/bot-avatar.spec.ts e2e/transcript-prefs.spec.ts
```

호스트의 승인된 공통 빌드 환경·의존성을 사용하고 E2E는 다른 worktree와 동시에 실행하지 않는다. 기존 bot avatar·메시지 표시 회귀, 인증 수명, image error, 일반 대화/스트리밍 표시는 실제 통합 상태에서 확인해야 한다. 필수 검증이 통과하고 전체 요구가 충족된 뒤에만 통합 담당이 `UI-013` 완료 여부를 판단한다.

로컬 커밋만 승인된 범위이며 push·merge·배포·서비스 중단은 하지 않았다. 이 인계를 포함한 로컬 커밋을 남긴 후 편집을 멈춘다.
