// Pages advanced-mode 예제. GROVE_WEB_BASE는 빌드와 같은 정규화된 "/" 또는 "/grove/" 값이다.
// ASSETS는 Pages가 제공한다. API 연결 전에는 실패를 명시하고 HTML로 성공을 가장하지 않는다.
export default {
    async fetch(request, env) {
        const url = new URL(request.url);
        const base = env.GROVE_WEB_BASE ?? "/";
        const scopedApi = url.pathname === `${base}api` || url.pathname.startsWith(`${base}api/`);
        if (url.pathname === "/api" || url.pathname.startsWith("/api/") || scopedApi) {
            return new Response(JSON.stringify({ error: { code: "api_not_connected", message: "Connect the existing authenticated Grove API before deployment" } }), {
                status: 503,
                headers: { "content-type": "application/json", "cache-control": "no-store" },
            });
        }
        if (base !== "/" && url.pathname === base.slice(0, -1)) {
            return new Response(null, { status: 308, headers: { location: `${base}${url.search}`, "cache-control": "no-cache" } });
        }
        if (!url.pathname.startsWith(base)) return new Response("Not found", { status: 404 });
        if (request.method !== "GET" && request.method !== "HEAD") {
            return new Response("Method not allowed", { status: 405, headers: { allow: "GET, HEAD", "cache-control": "no-store" } });
        }
        const path = url.pathname.slice(base.length);
        let response = await env.ASSETS.fetch(request);
        const isStatic = path.startsWith("assets/") ||
            ["sw.js", "manifest.webmanifest", "icon.svg", "icon-192.png", "icon-512.png"].includes(path);
        if (response.status === 404 && !isStatic && request.headers.get("accept")?.includes("text/html")) {
            // Pages의 /index.html -> / 정규 URL redirect를 피하고 디렉터리 index를 요청한다.
            response = await env.ASSETS.fetch(new Request(new URL(base, url), request));
        }
        const headers = new Headers(response.headers);
        headers.set("cache-control", response.ok && path.startsWith("assets/") ? "public, max-age=31536000, immutable" : "no-cache");
        headers.set("x-content-type-options", "nosniff");
        return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
    },
};
