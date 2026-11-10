// Grove service worker: 정적 앱 화면만 cache한다. API(/api/)는 절대 cache하지 않는다.
// 새 버전은 설치 후 대기하고, 사용자가 "지금 업데이트"를 눌렀을 때만 활성화한다(FLOW-16).
// VERSION은 빌드 후 scripts/stamp-sw.mjs가 자산 목록 hash로 바꾼다.
const VERSION = "__GROVE_BUILD__";
const CACHE = `grove-shell-${VERSION}`;
const PRECACHE = self.__GROVE_ASSETS__ || ["/", "/manifest.webmanifest", "/icon.svg"];

self.addEventListener("install", (event) => {
    // 같은 버전의 자산을 한꺼번에 받아 혼합 자산 상태를 피한다.
    event.waitUntil(caches.open(CACHE).then((c) => c.addAll(PRECACHE)));
});

self.addEventListener("activate", (event) => {
    event.waitUntil(
        (async () => {
            const keys = await caches.keys();
            await Promise.all(keys.filter((k) => k.startsWith("grove-shell-") && k !== CACHE).map((k) => caches.delete(k)));
            await self.clients.claim();
        })(),
    );
});

self.addEventListener("message", (event) => {
    if (event.data && event.data.type === "skip-waiting") self.skipWaiting();
});

self.addEventListener("fetch", (event) => {
    const url = new URL(event.request.url);
    if (event.request.method !== "GET" || url.origin !== self.location.origin || url.pathname.startsWith("/api/")) return;
    // 화면 이동: 네트워크 우선, 오프라인이면 cache된 앱 화면
    if (event.request.mode === "navigate") {
        event.respondWith(fetch(event.request).catch(() => caches.match("/", { ignoreSearch: true })));
        return;
    }
    // 해시된 자산: cache 우선(현재 버전 cache에 있는 것만 사용)
    event.respondWith(
        caches.open(CACHE).then(async (c) => {
            const hit = await c.match(event.request);
            if (hit) return hit;
            const resp = await fetch(event.request);
            if (resp.ok && url.pathname.startsWith("/assets/")) c.put(event.request, resp.clone());
            return resp;
        }),
    );
});
