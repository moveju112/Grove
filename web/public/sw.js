// Grove service worker: 등록 scope 안의 정적 앱 화면만 cache한다. API는 절대 cache하지 않는다.
// 새 버전은 설치 후 대기하고, 탭이 skip-waiting을 보낼 때만 활성화한다(FLOW-16).
// 탭은 입력이 없으면 바로, 입력이 남아 있으면 사용자가 업데이트를 고를 때 보낸다.
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

// document의 shell과 controller는 다르다. worker 재시작으로 기록이 없어지면 삭제를 보류한다.
const reportedShells = new Map();
async function collectUnusedShells() {
    const clients = (await self.clients.matchAll({ type: "window", includeUncontrolled: true }))
        .filter((client) => client.url.startsWith(SCOPE.href));
    // 한 탭이라도 구 HTML이거나 버전 불명이면 lazy asset을 남긴다. 탭 수만으로 판단하지 않는다.
    if (clients.some((client) => reportedShells.get(client.id) !== VERSION)) return;
    if (!(await (await caches.open(CACHE)).match(SCOPE.href, { ignoreSearch: true }))) return;
    const keys = await caches.keys();
    // CacheStorage.keys는 생성 순서다. 아직 대기 중이거나 이후 활성화된 cache를 구버전 worker가 지우지 않는다.
    const previous = keys.slice(0, keys.indexOf(CACHE));
    if (self.registration.installing || self.registration.waiting) return;
    await Promise.all(previous.filter((key) => key.startsWith(CACHE_PREFIX)).map((key) => caches.delete(key)));
    const live = new Set(clients.map((client) => client.id));
    for (const id of reportedShells.keys()) if (!live.has(id)) reportedShells.delete(id);
}

async function documentShell(response) {
    if (!response.headers.get("content-type")?.includes("text/html")) return response;
    const html = await response.text();
    const headers = new Headers(response.headers);
    headers.delete("content-length");
    headers.delete("content-encoding");
    // cache에서 제공한 버전만 document에 기록한다. cache 유실 시 network HTML의 버전은 추측하지 않는다.
    return new Response(html.replace(/<head(?:\s[^>]*)?>/i, `$&<meta name="grove-shell-version" content="${VERSION}">`),
        { status: response.status, statusText: response.statusText, headers });
}

self.addEventListener("install", (event) => {
    // 같은 버전의 자산을 한꺼번에 받아 혼합 자산 상태를 피한다.
    event.waitUntil(caches.open(CACHE).then((c) => c.addAll(PRECACHE)));
});

self.addEventListener("activate", (event) => {
    event.waitUntil(
        (async () => {
            await collectUnusedShells();
            await self.clients.claim();
        })(),
    );
});

self.addEventListener("message", (event) => {
    if (event.data && event.data.type === "skip-waiting") self.skipWaiting();
    if (event.data?.type === "push-test-status" && notificationId(event.data.testId)
        && event.source?.url?.startsWith(SCOPE.href) && event.ports?.[0]) {
        const port = event.ports[0];
        event.waitUntil((async () => {
            try {
                const cache = await caches.open(PUSH_TEST_CACHE);
                const record = await cache.match(pushTestKey(event.data.testId));
                port.postMessage({ type: "push-test-status", testId: event.data.testId, version: VERSION,
                    receipt: record ? await record.json() : null, storageError: pushTestStorageError });
            } catch {
                port.postMessage({ type: "push-test-status", testId: event.data.testId, version: VERSION,
                    receipt: null, storageError: true });
            } finally { port.close(); }
        })());
    }
    if (event.data && event.data.type === "shell-status") {
        event.waitUntil((async () => {
            if (event.source?.id && event.source.url?.startsWith(SCOPE.href)) {
                reportedShells.set(event.source.id, event.data.version);
                await collectUnusedShells();
            }
            const cache = await caches.open(CACHE);
            event.source?.postMessage({ type: "shell-status", cached: !!(await cache.match(SCOPE.href, { ignoreSearch: true })) });
        })());
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
                return shell ? documentShell(shell) : response;
            } catch {
                return shell ? documentShell(shell) : new Response(
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

const notificationId = (value) => typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const PUSH_TEST_CACHE = `grove-push-tests-${encodeURIComponent(SCOPE.href)}`;
const pushTestKey = (id) => new URL(`__grove_push_test__/${id}`, SCOPE).href;
let pushTestStorageError = false;

// 수신 여부와 표시 요청 결과만 기기 안에 보관한다. payload·구독 키·대화 내용은 저장하지 않는다.
async function recordPushTest(id, stage, error = null) {
    try {
        const cache = await caches.open(PUSH_TEST_CACHE);
        await cache.put(pushTestKey(id), new Response(JSON.stringify({ stage, error, version: VERSION, at: Date.now() })));
        const keys = await cache.keys();
        await Promise.all(keys.slice(0, Math.max(0, keys.length - 16)).map((key) => cache.delete(key)));
    } catch {
        // 진단 저장 실패 때문에 알림 자체를 막지 않으며, 조회 시 실패 사실을 함께 반환한다.
        pushTestStorageError = true;
    }
}

// Push payloads contain identifiers and generic completion status, never conversation text.
self.addEventListener("push", (event) => {
    event.waitUntil((async () => {
        let data;
        try { data = event.data?.json(); } catch { return; }
        const testId = data?.test === true && notificationId(data.testId) ? data.testId : null;
        if (testId) await recordPushTest(testId, "received");
        if (!data || data.scope !== SCOPE.href || !/^[0-9a-f]{64}$/.test(data.server)
            || typeof data.tag !== "string" || data.tag.length > 200) {
            if (testId) await recordPushTest(testId, "rejected", "push_envelope_invalid");
            return;
        }
        const test = data.test === true;
        if (test ? !notificationId(data.testId) || data.tag !== `test:${data.testId}`
            : !notificationId(data.projectId) || !notificationId(data.sessionId)) {
            if (testId) await recordPushTest(testId, "rejected", "push_target_invalid");
            return;
        }
        try {
            await self.registration.showNotification(test ? "Grove 실제 Push 시험" : data.failed ? "작업 실패" : "작업 완료", {
                body: test ? "서버에서 Push로 도착한 시험 알림이야." : data.failed ? "대화의 요청 처리가 실패하거나 중단됐습니다." : "대화의 요청 처리가 끝났습니다.",
                tag: `${data.server}:${data.tag}`, data,
                icon: new URL("icon-192.png", SCOPE).href,
                vibrate: data.vibrate ? [180, 80, 180] : [],
            });
            if (testId) await recordPushTest(testId, "registered");
        } catch (error) {
            if (testId) await recordPushTest(testId, "display_failed",
                ["NotAllowedError", "TypeError", "DataCloneError", "InvalidStateError", "SecurityError"].includes(error?.name) ? error.name : "Error");
            throw error;
        }
    })());
});
self.addEventListener("notificationclick", (event) => {
    event.notification.close();
    const data = event.notification.data;
    if (!data || !/^[0-9a-f]{64}$/.test(data.server)) return;
    const test = data.test === true && notificationId(data.testId) && data.tag === `test:${data.testId}` && data.scope === SCOPE.href;
    if (!test && (!notificationId(data.projectId) || !notificationId(data.sessionId))) return;
    event.waitUntil((async () => {
        // The app validates the server fingerprint before opening an identifier.
        const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
        const client = clients.find((c) => c.url.startsWith(SCOPE.href));
        if (client) {
            if (!test) client.postMessage({ type: "open-session", projectId: data.projectId, sessionId: data.sessionId, server: data.server });
            await client.focus();
            return;
        }
        const url = new URL(SCOPE);
        if (!test) {
            url.searchParams.set("notify_project", data.projectId);
            url.searchParams.set("notify_session", data.sessionId);
            url.searchParams.set("notify_server", data.server);
        }
        await self.clients.openWindow(url.href);
    })());
});
