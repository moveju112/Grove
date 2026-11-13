// Grove service worker: 등록 scope 안의 정적 앱 화면만 cache한다. API는 절대 cache하지 않는다.
// 새 버전은 설치 후 대기하고, 사용자가 "지금 업데이트"를 눌렀을 때만 활성화한다(FLOW-16).
// VERSION은 빌드 후 scripts/stamp-sw.mjs가 자산 목록 hash로 바꾼다.
const VERSION = "__GROVE_BUILD__";
const SCOPE = new URL(self.registration.scope);
const BASE = SCOPE.pathname;
// 구분자를 포함한 scope 전체를 인코딩해 /grove/와 /grove/child/도 서로 겹치지 않는다.
const CACHE_PREFIX = `grove-shell-${encodeURIComponent(SCOPE.href)}-`;
const CACHE = `${CACHE_PREFIX}${VERSION}`;
const isApi = (path) => path === "/api" || path.startsWith("/api/") ||
    path === `${BASE}api` || path.startsWith(`${BASE}api/`);
const inScope = (url) => url.origin === SCOPE.origin && url.pathname.startsWith(BASE) && !isApi(url.pathname);
// 기존 stamp-sw.mjs의 목록은 산출물 루트 기준이다. 등록 scope 기준으로 한 번만 매핑한다.
const PRECACHE = (self.__GROVE_ASSETS__ || ["/", "/manifest.webmanifest", "/icon.svg"])
    .map((path) => new URL(path.replace(/^\//, ""), SCOPE))
    .filter(inScope)
    .map((url) => url.href);

self.addEventListener("install", (event) => {
    // 같은 버전의 자산을 한꺼번에 받아 혼합 자산 상태를 피한다.
    event.waitUntil(caches.open(CACHE).then((c) => c.addAll(PRECACHE)));
});

self.addEventListener("activate", (event) => {
    event.waitUntil(
        (async () => {
            const keys = await caches.keys();
            // 예전의 scope 없는 cache는 소유 배포를 알 수 없으므로 자동 삭제하지 않는다.
            await Promise.all(keys.filter((k) => k.startsWith(CACHE_PREFIX) && k !== CACHE).map((k) => caches.delete(k)));
            await self.clients.claim();
        })(),
    );
});

self.addEventListener("message", (event) => {
    if (event.data && event.data.type === "skip-waiting") self.skipWaiting();
});

self.addEventListener("fetch", (event) => {
    const url = new URL(event.request.url);
    if (event.request.method !== "GET" || !inScope(url)) return;
    // 화면 이동: 네트워크 우선, 오프라인이면 cache된 앱 화면
    if (event.request.mode === "navigate") {
        event.respondWith(fetch(event.request).catch(async () => {
            const cache = await caches.open(CACHE);
            return (await cache.match(SCOPE.href, { ignoreSearch: true })) || Response.error();
        }));
        return;
    }
    // 해시된 자산: cache 우선(현재 버전 cache에 있는 것만 사용)
    event.respondWith(
        caches.open(CACHE).then(async (c) => {
            const hit = await c.match(event.request);
            if (hit) return hit;
            const resp = await fetch(event.request);
            if (resp.ok && url.pathname.startsWith(`${BASE}assets/`) && !resp.headers.get("content-type")?.includes("text/html")) {
                event.waitUntil(c.put(event.request, resp.clone()));
            }
            return resp;
        }),
    );
});
