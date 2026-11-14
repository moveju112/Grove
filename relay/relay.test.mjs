import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";

let mf;
const room = randomBytes(32).toString("hex");
const token = randomBytes(32).toString("hex");
const origin = "https://grove.choondoggy.com";
before(async () => {
    mf = new Miniflare(convertV4MiniflareOptions({
        modules: true,
        scriptPath: new URL("./worker.mjs", import.meta.url).pathname,
        compatibilityDate: "2026-04-07",
        durableObjects: { RELAY: { className: "GroveRelay", useSQLite: true } },
        bindings: { ROOM: room, DAEMON_TOKEN: token },
    }));
    await mf.ready;
});
after(async () => { await mf.dispose(); });
const request = (path, headers = {}) => mf.dispatchFetch(`https://relay.example${path}`, { headers });
async function socket(path, headers) {
    const response = await request(path, { Upgrade: "websocket", ...headers });
    assert.equal(response.status, 101);
    response.webSocket.accept();
    return response.webSocket;
}
function next(ws, event = "message", label = "") {
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error(`waiting for ${label} ${event}`)), 5000);
        ws.addEventListener(event, (value) => { clearTimeout(timeout); resolve(value); }, { once: true });
    });
}
test("unknown rooms, plaintext API, foreign origins, and unauthenticated daemon connections fail closed", async () => {
    assert.equal((await request("/api/v1/health")).status, 404);
    assert.equal((await request(`/api/e2ee/${"0".repeat(64)}`, { Origin: origin })).status, 404);
    assert.equal((await request(`/api/e2ee/${room}`, { Upgrade: "websocket", Origin: "https://foreign.example" })).status, 403);
    assert.equal((await request(`/relay/${room}/control`, { Upgrade: "websocket" })).status, 403);
    assert.equal((await request(`/api/e2ee/${room}`, { Origin: origin })).status, 426);
    assert.equal((await request(`/api/e2ee/${room}`, { Upgrade: "websocket", Origin: origin })).status, 503);
});
test("PAGES_ORIGIN replaces the production origin instead of adding to it; invalid values fall back to production", async () => {
    const make = (bindings) => new Miniflare(convertV4MiniflareOptions({
        modules: true,
        scriptPath: new URL("./worker.mjs", import.meta.url).pathname,
        compatibilityDate: "2026-04-07",
        durableObjects: { RELAY: { className: "GroveRelay", useSQLite: true } },
        bindings: { ROOM: room, DAEMON_TOKEN: token, ...bindings },
    }));
    const staging = make({ PAGES_ORIGIN: "https://staging.grove-cca.pages.dev" });
    const broken = make({ PAGES_ORIGIN: "javascript:alert(1)" });
    try {
        const status = async (mf, origin) => (await mf.dispatchFetch(`https://relay.example/api/e2ee/${room}`,
            { headers: { Upgrade: "websocket", Origin: origin } })).status;
        // 제어 연결이 없으면 허용 Origin은 503, 거절 Origin은 403이다.
        assert.equal(await status(staging, "https://staging.grove-cca.pages.dev"), 503);
        assert.equal(await status(staging, origin), 403);
        assert.equal(await status(broken, origin), 503);
        assert.equal(await status(broken, "javascript:alert(1)"), 403);
    } finally { await Promise.all([staging.dispose(), broken.dispose()]); }
});
test("authenticated daemon pairs isolated opaque channels; disconnect closes peers and supports reconnect", async () => {
    const auth = { Authorization: `Bearer ${token}` };
    let control = await socket(`/relay/${room}/control`, auth);
    assert.equal((await request(`/relay/${room}/control`, { Upgrade: "websocket", ...auth })).status, 409);
    const opened = next(control);
    const client = await socket(`/api/e2ee/${room}`, { Origin: origin });
    const { id, type } = JSON.parse((await opened).data);
    assert.equal(type, "open");
    client.send('{"version":1,"key":"public-handshake"}');
    const data = await socket(`/relay/${room}/data/${id}`, auth);
    assert.equal((await next(data)).data, '{"version":1,"key":"public-handshake"}');
    assert.equal((await request(`/relay/${room}/data/${id}`, { Upgrade: "websocket", ...auth })).status, 409);
    const opaque = randomBytes(1024);
    const fromClient = next(data);
    client.send(opaque);
    assert.deepEqual(Buffer.from((await fromClient).data), opaque);
    const fromDaemon = next(client);
    data.send(opaque);
    assert.deepEqual(Buffer.from((await fromDaemon).data), opaque);
    const closedClient = next(client, "close", "client");
    const closedData = next(data, "close", "data");
    const closedControl = next(control, "close", "control");
    control.close();
    await Promise.all([closedClient, closedData, closedControl]);
    control = await socket(`/relay/${room}/control`, auth);
    const pong = next(control);
    control.send("ping");
    assert.equal((await pong).data, "pong");
    const done = next(control, "close");
    control.close();
    await done;
});
