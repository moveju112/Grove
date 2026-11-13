# b01 / 02 — 루트·하위 경로 웹 배포 인계

## 위치·상태

- Worktree: `/home/ubuntu/.local/share/paseodog/paseo/worktrees/0q796rug/b01-02-web-base`
- Branch: `parallel/b01-web-base`
- 공통 기준: `c186b31ab62734c9f91803cf7848b639ad9871fb`
- `ENTRY.md`와 `README.md`의 경로·브랜치 행으로 02를 선택했다. 시작 시 Git은 clean이었고 `git merge-base HEAD c186b31ab62734c9f91803cf7848b639ad9871fb`도 기준 SHA와 같았다.
- 상태: **소유 범위 구현 종료, 통합·검증 대기. WEB-002/003 전체 완료 아님.**
- Blocker: 공통 root/PWA 등록·Rust static mount 연결이 남았고, 로컬 `web/node_modules`가 없어 Vitest도 실행하지 않았다. 빌드·typecheck·E2E·호스트 검증은 이번 독립 단계 계약에 따라 미실행이다.
- 개발 세션 목록 조회는 런타임의 `session: cross-session control is unavailable in this runtime`으로 확인할 수 없었다. 다른 세션에 인수·슬롯·승인을 요청하지 않았다.
- 로컬 커밋만 사용자 승인 범위다. push·merge·배포·서비스 조작은 하지 않는다.

## 소유 변경

- 설정: `web/vite.config.ts`, `web/react-router.config.ts`
- PWA: `web/public/sw.js`, `web/public/manifest.webmanifest`
- 공통 base/URL export: `web/app/deployment/base.ts`, `web/app/deployment/index.ts`
- 단위 시험: `web/app/deployment/base.test.ts`, `web/app/deployment/sw.test.ts`, `web/app/deployment/pages.test.ts`
- 브라우저 인수 시험: `web/e2e/deployment-base.spec.ts`
- 호스팅 예제: `web/deployment/nginx-root.conf`, `web/deployment/nginx-subpath.conf`, `web/deployment/cloudflare-pages/_worker.js`, `web/deployment/cloudflare-pages/_worker.d.ts`, `web/deployment/cloudflare-pages/404.html`, `web/deployment/README.md`
- 인계: `work/RESULT-02.md`

공통 API·store·root·PWA 등록 호출부·Rust·TODO·dependency/lockfile은 수정하지 않았다.

## 동작·public 계약

`web/app/deployment/base.ts`:

- `normalizeBasePath(input: string | undefined): string`: 기본 `/`. `grove`, `/grove`, `/grove/`는 `/grove/`로 정규화한다. trim·중복 내부 slash 정리를 지원한다. 절대 URL·protocol-relative URL·query·fragment·backslash·percent encoding·dot segment·예약 `/api` prefix는 `Error`로 거부한다.
- `deploymentPaths(input)` 반환: readonly `base`, `basename`, `manifest`, `icon`, `appleTouchIcon`, `serviceWorker`, `serviceWorkerScope`. `basename`은 루트 외에는 마지막 slash를 뺀다.
- 빌드 환경 변수 `GROVE_WEB_BASE`를 Vite `base`와 React Router `basename`에 함께 연결한다. CLI `--base`만 별도 override하지 않는다. 셸/CI 환경으로 전달한다.

`web/app/deployment/index.ts`:

- 위 두 함수를 재export하고 `deployment = deploymentPaths(import.meta.env.BASE_URL)`를 export한다.
- 브라우저의 manifest/icon/worker 호출부가 사용할 값이다. 현재 공통 호출부에는 **미연결**이다.

Manifest:

- `id`, `start_url`, `scope`, icon URL은 manifest URL 기준 상대 경로다. deep link 문서 기준 상대 경로가 아니다.

Worker:

- 실제 `self.registration.scope`로 base와 cache namespace를 결정한다.
- 기존 `web/scripts/stamp-sw.mjs`의 산출물 루트 기준 precache 목록을 scope에 매핑한다. stamp 스크립트 변경은 필요 없다.
- cache key는 `grove-shell-${encodeURIComponent(scopeURL)}-${VERSION}`. 활성화 시 정확히 같은 scope의 과거 버전만 삭제한다.
- legacy `grove-shell-${VERSION}` cache는 소유 배포를 알 수 없어 남긴다. 다른 배포·다른 앱 cache는 삭제하지 않는다.
- GET·동일 origin·scope 내부 요청만 처리한다. `/api`, `/api/*` 및 scoped `api` prefix는 precache/fetch 모두 제외한다.
- navigation은 network-first다. transport 실패 때만 현재 scope/버전의 shell을 사용하며, 다른 cache를 검색하지 않는다. shell도 없으면 `Response.error()`다. 온라인 HTTP 오류를 shell 성공 응답으로 바꾸지 않는다.
- 성공한 scope 내부 assets만 runtime cache한다. HTML fallback·실패 자산은 추가하지 않는다.
- 설치 시 자동 `skipWaiting`하지 않는다. 기존 `skip-waiting` 메시지로만 전환한다. UI의 사용자 선택·초안 보존·한 번 reload 계약은 변경하지 않았다.

호스팅:

- Nginx 루트·`/grove/` 예제는 기존 same-origin `/api/v1/*`를 Grove upstream으로 전달하고 API cache·SSE buffering을 끈다. 그 밖의 `/api` 경로는 JSON 404다. UI fallback과 hashed asset 404 경계, mutable entry 재검증, immutable asset header를 정의했다.
- Pages advanced-mode 예제는 최상위 `404.html`로 암묵적인 전역 SPA fallback을 끄고 UI navigation만 scope 내 directory index로 fallback한다. worker가 cache header를 직접 설정한다.
- Pages API는 아직 연결하지 않았다. `/api`와 scoped API 요청은 **JSON 503/no-store**다. HTML로 성공을 가장하지 않지만, 이 예제만으로 앱의 인증·API 기능이 작동하지는 않는다.
- 권한·인증·origin·cookie 정책은 확장하지 않는다. 실제 호스트의 TLS·MIME·산출물별 CSP와 기존 보안 header를 유지해야 한다. CSP 완화로 배포를 우회하지 않는다.

## 필요한 공통 연결

1. `web/app/root.tsx`: 현재 `/manifest.webmanifest`, `/icon.svg`, `/icon-192.png` literal을 `deployment.manifest`, `deployment.icon`, `deployment.appleTouchIcon`으로 연결한다.
2. `web/app/components/pwa.tsx::registerServiceWorker`: 현재 `register("/sw.js", { scope: "/" })`를 `register(deployment.serviceWorker, { scope: deployment.serviceWorkerScope })`로 연결한다. 기존 update 배너·controllerchange의 사용자 선택 조건은 보존한다.
3. `src/web.rs::static_routes`와 `src/lib.rs::router`: UI base mount·해당 base 내부 SPA fallback을 연결한다. API 경계는 `/api/v1`뿐 아니라 `/api`, `/api/*` 전체를 HTML fallback에서 제외한다. 현재 `/api/v1`만 별도 fallback이 있고, `/api`와 잘못된 API prefix는 정적 fallback으로 갈 수 있다.
4. API/SSE client의 현재 origin-root `/api/v1` 계약은 유지한다. UI base를 API 앞에 무조건 붙이지 않는다. scoped `/grove/api`도 HTML 성공으로 숨기지 않는다.
5. Pages 실사용 전 동일 origin backend routing을 기존 인증·cookie·SSE·origin 계약 그대로 연결한다. 예제의 503을 가짜 성공으로 바꾸지 않는다.

## 실제 검증

아래 실행에는 먼저 `source .envrc.dev`를 적용했다.

| 명령·입력 | 결과 |
| --- | --- |
| `node --check web/public/sw.js` | exit 0, JavaScript 문법만 확인 |
| `node --check web/deployment/cloudflare-pages/_worker.js` | exit 0, JavaScript 문법만 확인 |
| `python3 scripts/build.py test --vitest app/deployment/base.test.ts app/deployment/sw.test.ts app/deployment/pages.test.ts --dry-run` | exit 0, 세 파일 선택을 확인. 시험 실행 아님 |
| `git diff --check` | exit 0, 당시 추적 중인 네 수정 파일의 whitespace 확인 |

최초 dry-run에서는 `--vitest` 옵션을 반복해 마지막 파일만 선택됐다. 위처럼 한 옵션 뒤에 세 파일을 전달해 선택 범위를 바로잡았다. 어느 dry-run도 단위 시험 통과로 세지 않는다.

추가로 실행한 표준 라이브러리 검사:

```python
import json
from pathlib import Path
from urllib.parse import urljoin
manifest = json.loads(Path('web/public/manifest.webmanifest').read_text())
for base in ('/', '/grove/', '/teams/grove/'):
    manifest_url = 'https://grove.invalid' + base + 'manifest.webmanifest'
    for key in ('id', 'start_url', 'scope'):
        assert urljoin(manifest_url, manifest[key]) == 'https://grove.invalid' + base, (base, key)
    for icon, name in zip(manifest['icons'], ('icon.svg', 'icon-192.png', 'icon-512.png'), strict=True):
        assert urljoin(manifest_url, icon['src']) == 'https://grove.invalid' + base + name
        assert (Path('web/public') / name).is_file(), name
print('manifest JSON, root/nested URL resolution and icon files: PASS')
```

실행 명령은 `python3 - <<'PY'`와 위 본문, 종료 delimiter `PY`였고 exit 0이었다.
이는 JSON·URL resolution·icon 파일 존재 검사일 뿐 브라우저의 manifest 설치 검사나 TypeScript 실행 검사가 아니다.

미실행:

- Vitest 세 파일: `web/node_modules` 부재. 설치·npx 자동 다운로드·다른 worktree 복사는 하지 않았다.
- typecheck·웹 build·Rust build·E2E·Nginx 문법/실서빙·Pages runtime: 공통 문서가 통합 단계로 유보했다. 서버·브라우저·별도 standalone runner를 띄우지 않았다.
- 새 단위 시험의 worker VM/CacheStorage 대역은 브라우저 인수 증거가 아니다. 새 TypeScript와 시험 파일의 buildability도 아직 미검증이다.

## TODO 판정·다음 통합

| TODO | 현재 근거 | 남은 조건 |
| --- | --- | --- |
| WEB-002 | 공통 base 정규화·라우터/자산 설정, 상대 manifest, scope별 worker, root/subpath 선택 E2E 작성 | root/PWA/static mount 연결, 각각의 실제 build·deep link 새로고침·자산·worker 갱신·offline 검증 |
| WEB-003 | Nginx 두 base와 Pages routing/header 예제 정의, API HTML fallback 방지와 미연결 503 명시 | 실제 호스트 문법·서빙·CSP/header 검증, Pages backend routing 연결 |

둘 다 부분 구현/통합 대기로 남긴다. `TODO.md`를 체크하지 않았다.
통합 후 `python3 scripts/build.py test --vitest app/deployment/base.test.ts app/deployment/sw.test.ts app/deployment/pages.test.ts --typecheck`를 실행한다.
그다음 `GROVE_WEB_BASE=/`와 `GROVE_WEB_BASE=/grove/` 각각에서 기존 선택 E2E 진입점으로 `web/e2e/deployment-base.spec.ts`를 검증한다.
한 산출물을 서로 다른 base에 mount해서 두 배포를 검증했다고 보지 않는다.
기존 `web/e2e/pwa-update.spec.ts`의 stream·초안·사용자 선택 회귀도 유지한다. 그 spec의 root 전용 진입 helper는 하위 경로 검증 시 통합 담당이 맞춰야 한다.
기존 root worker에서 subpath worker로의 migration과 legacy cache 잔존은 별도 인수 위험이다. 자동 unregister나 광역 cache 삭제로 해결하지 않는다.
실제 배포·push·merge는 하지 않았으며, 이 인계를 포함한 로컬 커밋 후 작업을 멈춘다.
