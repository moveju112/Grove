import { describe, expect, it, vi } from "vitest";
import worker from "../../deployment/cloudflare-pages/_worker.js";

describe.each(["/", "/grove/"])("Pages example at %s", (base) => {
    it("never routes API to static assets or HTML fallback", async () => {
        const fetch = vi.fn(async () => new Response("<html>shell</html>"));
        for (const path of ["/api", "/api/v1/unknown", `${base}api`, `${base}api/v1/unknown`]) {
            const response = await worker.fetch(new Request(`https://grove.invalid${path}`, { headers: { accept: "text/html" } }), {
                GROVE_WEB_BASE: base, ASSETS: { fetch },
            });
            expect(response.status).toBe(503);
            expect(response.headers.get("content-type")).toBe("application/json");
            expect(response.headers.get("cache-control")).toBe("no-store");
        }
        expect(fetch).not.toHaveBeenCalled();
    });

    it("falls back only for UI navigation and revalidates the shell", async () => {
        const fetch = vi.fn(async (request: Request) => new URL(request.url).pathname === base
            ? new Response("<html>shell</html>", { headers: { "content-type": "text/html" } })
            : new Response("missing", { status: 404 }));
        const env = { GROVE_WEB_BASE: base, ASSETS: { fetch } };
        const navigation = await worker.fetch(new Request(`https://grove.invalid${base}deep/link`, { headers: { accept: "text/html" } }), env);
        expect(navigation.status).toBe(200);
        expect(await navigation.text()).toBe("<html>shell</html>");
        expect(navigation.headers.get("cache-control")).toBe("no-cache");
        for (const path of ["assets/missing.js", "sw.js", "manifest.webmanifest", "icon.svg"]) {
            const response = await worker.fetch(new Request(`https://grove.invalid${base}${path}`, { headers: { accept: "text/html" } }), env);
            expect(response.status).toBe(404);
        }
        const nonNavigation = await worker.fetch(new Request(`https://grove.invalid${base}missing`), env);
        expect(nonNavigation.status).toBe(404);
    });

    it("uses immutable only for successful assets, not mutable entrypoints", async () => {
        const fetch = vi.fn(async () => new Response("asset"));
        const env = { GROVE_WEB_BASE: base, ASSETS: { fetch } };
        for (const path of ["assets/app-hash.js", "sw.js", "manifest.webmanifest", "index.html"]) {
            const response = await worker.fetch(new Request(`https://grove.invalid${base}${path}`), env);
            expect(response.headers.get("cache-control")).toBe(path.startsWith("assets/") ? "public, max-age=31536000, immutable" : "no-cache");
        }
    });

    it("rejects static mutations and requests outside a subpath without fetching", async () => {
        const fetch = vi.fn(async () => new Response("asset"));
        const env = { GROVE_WEB_BASE: base, ASSETS: { fetch } };
        expect((await worker.fetch(new Request(`https://grove.invalid${base}`, { method: "POST" }), env)).status).toBe(405);
        if (base !== "/") {
            expect((await worker.fetch(new Request("https://grove.invalid/outside"), env)).status).toBe(404);
            const redirect = await worker.fetch(new Request(`https://grove.invalid${base.slice(0, -1)}?x=1`), env);
            expect(redirect.status).toBe(308);
            expect(redirect.headers.get("location")).toBe(`${base}?x=1`);
        }
        expect(fetch).not.toHaveBeenCalled();
    });
});
