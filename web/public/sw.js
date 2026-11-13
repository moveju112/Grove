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
            // 다른 탭은 아직 이전 HTML로 실행 중일 수 있다. 그 탭의 lazy asset을 지우지 않는다.
            // 다중 탭에서 남긴 cache는 이후 단일 탭 활성화 때 정리한다.
            const clients = (await self.clients.matchAll({ type: "window", includeUncontrolled: true }))
                .filter((client) => client.url.startsWith(SCOPE.href));
            // 예전의 scope 없는 cache는 소유 배포를 알 수 없으므로 자동 삭제하지 않는다.
            if (clients.length <= 1) {
                await Promise.all(keys.filter((k) => k.startsWith(CACHE_PREFIX) && k !== CACHE).map((k) => caches.delete(k)));
            }
            await self.clients.claim();
        })(),
    );
});

self.addEventListener("message", (event) => {
    if (event.data && event.data.type === "skip-waiting") self.skipWaiting();
    if (event.data && event.data.type === "shell-status") {
        event.waitUntil(caches.open(CACHE).then(async (cache) => {
            event.source?.postMessage({ type: "shell-status", cached: !!(await cache.match(SCOPE.href, { ignoreSearch: true })) });
        }));
    }
});

self.addEventListener("fetch", (event) => {
    const url = new URL(event.request.url);
    if (event.request.method !== "GET" || !inScope(url)) return;
    // 제어 중인 worker와 같은 빌드의 HTML을 유지한다. 서버에 새 HTML이 있어도 사용자 확인 전에는 섞지 않는다.
    // 온라인 404/오류를 성공한 shell로 바꾸지는 않는다.
    if (event.request.mode === "navigate") {
        event.respondWith((async () => {
            const cache = await caches.open(CACHE);
            const shell = await cache.match(SCOPE.href, { ignoreSearch: true });
            try {
                const response = await fetch(event.request);
                if (!response.ok) return response;
                // cache 유실 때만 온라인 shell로 복구한다. 이를 구 버전 cache에 저장하지 않는다.
                return shell || response;
            } catch {
                return shell || new Response(
                    '<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Grove 오프라인</title><h1>오프라인 · 앱 cache 없음</h1><p>앱 cache가 삭제됐거나 자동 정리돼 이 화면을 열 수 없습니다. 네트워크 연결 후 다시 불러오세요.</p><p>이 오프라인 화면에서는 새 서버 작업을 실행할 수 없습니다. 다른 탭의 입력은 먼저 복사하세요. 앱 cache 복구는 삭제된 로컬 초안을 복구하지 않습니다.</p></html>',
                    { status: 503, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } },
                );
            }
        })());
        return;
    }
    // 해시된 자산: cache 우선. 구 탭의 정확한 hash URL만 보존한 이전 cache에서 찾는다.
    event.respondWith(
        caches.open(CACHE).then(async (c) => {
            const hit = await c.match(event.request);
            if (hit) return hit;
            // 이미 열린 구 HTML은 정확한 hash URL의 자산만 이전 cache에서 찾는다.
            if (url.pathname.startsWith(`${BASE}assets/`)) {
                const keys = await caches.keys();
                for (const key of keys.filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE)) {
                    const old = await (await caches.open(key)).match(event.request);
                    if (old) return old;
                }
            }
            const resp = await fetch(event.request);
            if (resp.ok && PRECACHE.includes(url.href) && url.pathname.startsWith(`${BASE}assets/`) && !resp.headers.get("content-type")?.includes("text/html")) {
                event.waitUntil(c.put(event.request, resp.clone()));
            }
            return resp;
        }),
    );
});
