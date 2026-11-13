# 루트·하위 경로 호스팅 예제

이 디렉터리는 배포 실행기가 아니다. 실제 배포·origin·인증 정책 변경은 포함하지 않는다.
공통 root/PWA 호출부 연결 전에는 `/grove/` 산출물을 완성된 앱으로 배포하지 않는다.

## 빌드 계약

기존 `web/package.json`의 build 명령에 빌드 환경 변수 `GROVE_WEB_BASE`를 준다.
기본은 `/`, 하위 경로 예시는 `/grove/`다. CLI의 Vite `--base`만 따로 덮어쓰지 않는다.
Vite `base`와 React Router `basename`은 `web/app/deployment/base.ts`의 정규화를 공유한다.
선행·후행 slash와 중복 내부 slash는 정규화하며, URL·query·fragment·dot segment·인코딩·`/api` prefix는 거부한다.
셸/CI 환경 변수로 설정한다. Vite가 늦게 읽는 `.env` 파일에만 두면 Router와 일치한다고 보장하지 않는다.

기존 `web/scripts/stamp-sw.mjs`는 산출물 루트 기준 목록을 삽입한다.
`web/public/sw.js`가 이 목록을 등록 scope에 맞게 매핑하므로 stamp 스크립트는 변경하지 않는다.
manifest의 `./` 값과 icon 경로는 **manifest URL** 기준이다. deep link 문서 기준 상대 링크를 쓰지 않는다.

## 필수 공통 연결

- `web/app/root.tsx`: manifest·icon·apple-touch-icon href를 `web/app/deployment/index.ts`의 `deployment` 값으로 연결한다.
- `web/app/components/pwa.tsx`: `deployment.serviceWorker`, `{ scope: deployment.serviceWorkerScope }`로 등록한다. 기존 사용자 선택 후 업데이트·한 번만 reload 계약은 유지한다.
- `src/web.rs`: UI base에 static 서비스를 mount하고 그 base 안에서만 SPA fallback을 한다. `/api`, `/api/*`는 없는 endpoint도 HTML fallback으로 보내지 않는다. 누락된 hashed asset·SW·manifest도 404여야 한다.
- `web/app/api/`: 이번 범위에서는 변경하지 않는다. 현재 API·SSE는 origin 루트 `/api/v1`을 사용한다. UI base를 무조건 앞에 붙이지 않는다.

하위 경로 worker를 등록하기 위해 `Service-Worker-Allowed: /`를 추가하지 않는다.
scope를 확대하거나 기존 root worker를 자동 해제하지 않는다.
기존 scope 없는 `grove-shell-*` cache는 소유 배포를 알 수 없어 남겨 둔다.
scope별 cache만 정리하며 CacheStorage의 다른 cache를 지우지 않는다.
기존 root worker가 남은 origin의 하위 경로 전환은 통합 단계에서 별도 migration 검증이 필요하다.

## Nginx

`web/deployment/nginx-root.conf` 또는 `web/deployment/nginx-subpath.conf`를 기존 HTTPS server 안에서 사용한다.
두 예제를 동시에 같은 server에 포함하지 않는다. 경로와 기존 Grove API upstream을 운영 구성에 맞춘다.
하위 경로 예제는 **alias가 아니라 root**를 사용한다. 산출물 내용을 `/srv/grove-site/grove/`에 배치한다.
루트 예제는 `/srv/grove-web/`에 배치한다.
`mime.types`·TLS·보안 header와 `src/web.rs::csp_for`에 준하는 산출물별 CSP는 기존 호스트 설정에서 유지한다.
인라인 script hash가 바뀌는 갱신에서도 CSP를 새 산출물과 함께 검증한다. `unsafe-inline` script 허용으로 우회하지 않는다.
Nginx `add_header`의 하위 location 상속 규칙에 따라 필요한 보안 header도 각 location에 유지해야 한다.
예제는 인증·cookie·origin 허용 정책을 새로 만들지 않는다.

API는 기존 Grove 서버로 전달하고 cache·SSE buffering을 끈다.
정적 hash 자산은 immutable, HTML·worker·manifest는 재검증한다.
`/grove`는 query를 유지한 채 `/grove/`로 redirect한다.
누락된 hashed 자산은 SPA HTML 성공 응답이 아닌 404이고, deep link는 각 배포의 index로 돌아간다.

## Cloudflare Pages

Pages 기본 SPA fallback이나 `/* /index.html 200` 규칙만으로는 API 제외를 보장할 수 없다.
`web/deployment/cloudflare-pages/_worker.js`는 advanced-mode의 명시적 routing/header 예제다.
Pages 출력 루트에 `_worker.js`와 `404.html`을 둔다. **최상위 `404.html`을 생략하지 않는다.**
이 파일이 Pages의 암묵적인 전역 SPA fallback을 막고, worker가 UI navigation만 명시적으로 fallback한다.

루트 배포는 산출물 내용을 Pages 출력 루트에, 하위 배포는 출력 루트의 `grove/` 안에 둔다.
worker와 `404.html`은 어느 경우에도 출력 최상위다.
worker 런타임 변수 `GROVE_WEB_BASE`도 빌드와 같은 정규화 값(`/` 또는 `/grove/`)으로 설정한다.
다른 base를 사용할 때도 동일하게 prefix 디렉터리와 변수를 맞춘다.
worker가 응답 cache header를 직접 설정하므로 `_headers` 또는 `_redirects`에 의존하지 않는다.
기존 CSP 등 보안 header를 제거·완화하지 않으며, 실제 Pages 적용은 별도 검증 대상이다.

**API는 아직 연결되지 않았으므로 예제는 `/api`와 scoped `/grove/api`에 JSON 503/no-store를 반환한다.**
실사용 전에 통합 담당이 기존 인증·cookie·SSE·origin 계약을 유지하는 동일 origin API routing을 연결해야 한다.
외부 origin proxy URL·자격증명을 예제에 넣지 않으며 이 연결 없이 앱 기능이 완성됐다고 보지 않는다.

## 인수 검사

통합 후 기존 진입점으로 각각 `/`와 `/grove/` 빌드를 선택해
`web/e2e/deployment-base.spec.ts`를 실행한다. 기존 E2E 서버도 해당 base mount가 연결돼 있어야 한다.
각 실행의 빌드·서버·브라우저 base가 같아야 하며 하나의 산출물로 두 base를 통과했다고 간주하지 않는다.
UI 갱신 중 stream·초안 회귀는 기존 `web/e2e/pwa-update.spec.ts`도 함께 검증한다.
Pages/Nginx 예제의 실제 문법·헤더·deep link·API 오류 처리는 해당 호스트에서 별도 검증한다.
