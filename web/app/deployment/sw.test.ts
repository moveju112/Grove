import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const source = readFileSync(new URL("../../public/sw.js", import.meta.url), "utf8");
const origin = "https://grove.invalid";

// Worker의 실제 event handler를 작은 CacheStorage 대역으로 검사한다. 브라우저 인수 검사는 별도다.
function worker(base: string, assets?: string[]) {
    type WorkerEvent = {
        request?: { url: string; method: string; mode: string };
        data?: unknown;
        waitUntil: (promise: Promise<unknown>) => void;
        respondWith: (promise: Promise<Response>) => void;
    };
    const handlers = new Map<string, (event: WorkerEvent) => void>();
    const entries = new Map<string, Map<string, Response>>();
    const absolute = (value: string | { url: string }) => new URL(typeof value === "string" ? value : value.url, origin).href;
    const caches = {
        keys: async () => [...entries.keys()],
        delete: vi.fn(async (key: string) => entries.delete(key)),
        open: vi.fn(async (key: string) => {
            if (!entries.has(key)) entries.set(key, new Map());
            const cache = entries.get(key)!;
            return {
                addAll: vi.fn(async (urls: string[]) => {
                    for (const url of urls) cache.set(absolute(url), new Response(url.endsWith("/") ? `shell:${base}` : "asset"));
                }),
                match: async (request: string | { url: string }) => cache.get(absolute(request))?.clone(),
                put: async (request: string | { url: string }, response: Response) => { cache.set(absolute(request), response); },
            };
        }),
    };
    const self = {
        registration: { scope: origin + base },
        __GROVE_ASSETS__: assets,
        clients: { claim: vi.fn(async () => undefined) },
        skipWaiting: vi.fn(),
        addEventListener: (type: string, handler: (event: WorkerEvent) => void) => { handlers.set(type, handler); },
    };
    const fetch = vi.fn(async (_request: unknown) => new Response("network", { headers: { "content-type": "text/javascript" } }));
    runInNewContext(source, { self, caches, fetch, URL, Response });
    async function dispatch(type: string, request?: WorkerEvent["request"], data?: unknown) {
        const pending: Promise<unknown>[] = [];
        let response: Promise<Response> | undefined;
        handlers.get(type)!({
            request, data,
            waitUntil: (promise) => { pending.push(promise); },
            respondWith: (promise) => { response = promise; },
        });
        const result = await response;
        await Promise.all(pending);
        return result;
    }
    const request = (path: string, method = "GET", mode = "cors") => ({ url: new URL(path, origin).href, method, mode });
    return { self, caches, entries, fetch, dispatch, request };
}

describe.each(["/", "/grove/", "/grove/child/"])("worker at %s", (base) => {
    it("maps stamped paths to its own scope and excludes API precache", async () => {
        const w = worker(base, ["/", "/assets/app-hash.js", "/api/v1/private"]);
        await w.dispatch("install");
        const urls = [...w.entries.values()].flatMap((cache) => [...cache.keys()]);
        expect(urls).toEqual([`${origin}${base}`, `${origin}${base}assets/app-hash.js`]);
        expect(w.self.skipWaiting).not.toHaveBeenCalled();
    });

    it("never handles API, non-GET, other-origin, or out-of-scope requests", async () => {
        const w = worker(base);
        for (const path of ["/api", "/api/v1/health", `${base}api`, `${base}api/private`, "https://other.invalid/asset"]) {
            expect(await w.dispatch("fetch", w.request(path))).toBeUndefined();
        }
        expect(await w.dispatch("fetch", w.request(`${base}assets/app.js`, "POST"))).toBeUndefined();
        if (base !== "/") {
            expect(await w.dispatch("fetch", w.request("/outside/assets/app.js"))).toBeUndefined();
            expect(await w.dispatch("fetch", w.request(`${base.slice(0, -1)}-other/assets/app.js`))).toBeUndefined();
        }
        expect(w.caches.open).not.toHaveBeenCalled();
        expect(w.fetch).not.toHaveBeenCalled();
    });

    it("falls back only to this version's shell when navigation loses transport", async () => {
        const w = worker(base);
        await w.dispatch("install");
        w.fetch.mockRejectedValue(new TypeError("offline"));
        const response = await w.dispatch("fetch", w.request(`${base}deep/link?x=1`, "GET", "navigate"));
        expect(await response!.text()).toBe(`shell:${base}`);
    });

    it("does not turn online API-like errors or failed navigation into a shell", async () => {
        const w = worker(base);
        await w.dispatch("install");
        w.fetch.mockResolvedValue(new Response("not found", { status: 404 }));
        const response = await w.dispatch("fetch", w.request(`${base}missing`, "GET", "navigate"));
        expect(response!.status).toBe(404);
        expect(await response!.text()).toBe("not found");
    });

    it("does not use an old or another deployment's shell when its own shell is absent", async () => {
        const w = worker(base);
        const prefix = `grove-shell-${encodeURIComponent(origin + base)}-`;
        w.entries.set(`${prefix}old`, new Map([[origin + base, new Response("stale shell")]]));
        w.entries.set("other-app", new Map([[origin + base, new Response("foreign shell")]]));
        w.fetch.mockRejectedValue(new TypeError("offline"));
        const response = await w.dispatch("fetch", w.request(`${base}deep/link`, "GET", "navigate"));
        expect(response!.type).toBe("error");
    });

    it("caches successful hashed assets, not HTML fallbacks or failed responses", async () => {
        const w = worker(base);
        await w.dispatch("install");
        const path = `${base}assets/app.js`;
        await w.dispatch("fetch", w.request(path));
        w.fetch.mockRejectedValue(new TypeError("offline"));
        expect(await (await w.dispatch("fetch", w.request(path)))!.text()).toBe("network");
        expect(w.fetch).toHaveBeenCalledTimes(1);
        for (const response of [
            new Response("<html>shell</html>", { headers: { "content-type": "text/html" } }),
            new Response("missing", { status: 404 }),
        ]) {
            w.fetch.mockResolvedValue(response);
            await w.dispatch("fetch", w.request(`${base}assets/missing.js`));
            const urls = [...w.entries.values()].flatMap((cache) => [...cache.keys()]);
            expect(urls).not.toContain(`${origin}${base}assets/missing.js`);
        }
    });

    it("deletes only the exact scope's previous versions and waits for user consent", async () => {
        const w = worker(base);
        const prefix = `grove-shell-${encodeURIComponent(origin + base)}-`;
        const other = base === "/" ? "/grove/" : "/";
        const keep = [
            "grove-shell-legacy",
            `grove-shell-${encodeURIComponent(origin + other)}-old`,
            `grove-shell-${encodeURIComponent(origin + base + "nested/")}-old`,
            `${prefix}__GROVE_BUILD__`,
            "unrelated-app-cache",
        ];
        for (const key of [...keep, `${prefix}old`]) w.entries.set(key, new Map());
        await w.dispatch("activate");
        expect([...w.entries.keys()]).toEqual(keep);
        expect(w.self.clients.claim).toHaveBeenCalledOnce();
        expect(w.self.skipWaiting).not.toHaveBeenCalled();
        await w.dispatch("message", undefined, { type: "other" });
        expect(w.self.skipWaiting).not.toHaveBeenCalled();
        await w.dispatch("message", undefined, { type: "skip-waiting" });
        expect(w.self.skipWaiting).toHaveBeenCalledOnce();
    });
});
