import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { GroveRelay } from "./worker.mjs";

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
    const previous = await socket(`/relay/${room}/control`, auth);
    // 새 제어 연결이 이전 연결을 대체하고, 브라우저 연결은 새 제어 연결로만 전달된다.
    // close code(4000)는 lease 시험과 실제 소켓을 쓰는 서버 시험(src/relay.rs)에서 확인한다.
    // 프로세스 내부 소켓은 서버 쪽 close를 dispose 때까지 전달하지 않는다.
    let control = await socket(`/relay/${room}/control`, auth);
    let stale = false;
    previous.addEventListener("message", () => { stale = true; });
    const opened = next(control);
    const client = await socket(`/api/e2ee/${room}`, { Origin: origin });
    const { id, type } = JSON.parse((await opened).data);
    assert.equal(type, "open");
    assert.equal(stale, false);
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
    // 16MiB 첨부는 JSON과 암호화 전송 envelope의 base64를 거치면 약 29MiB다.
    const large = Buffer.alloc(Math.ceil(Math.ceil(16 * 1024 * 1024 / 3) * 4 / 3) * 4 + 4096, 0x78);
    const largeFromClient = next(data);
    client.send(large);
    assert.deepEqual(Buffer.from((await largeFromClient).data), large);
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

// close 이벤트가 오지 않고 readyState도 OPEN에 머무는 단절을 재현한다.
// 실제 WebSocket·인증 경계는 위 Miniflare 시험에서 별도로 확인한다.
async function leaseFixture(t, attachments = []) {
    let now = 1_000_000;
    t.mock.method(Date, "now", () => now);
    const sockets = [];
    const makeSocket = (attachment = {}) => ({
        readyState: 1, attachment: structuredClone(attachment), messages: [], closes: 0,
        deserializeAttachment() { return structuredClone(this.attachment); },
        serializeAttachment(value) { this.attachment = structuredClone(value); },
        send(value) { this.messages.push(value); },
        close(code) { this.closes++; this.closeCode = code; },
    });
    const NativeResponse = globalThis.Response;
    t.mock.method(globalThis, "Response", function (body, init) {
        return init?.status === 101 ? { status: 101, webSocket: init.webSocket } : new NativeResponse(body, init);
    });
    globalThis.WebSocketPair = class {
        constructor() { return { 0: makeSocket(), 1: makeSocket() }; }
    };
    t.after(() => { delete globalThis.WebSocketPair; });
    let alarm = null;
    const values = new Map();
    const ctx = {
        gate: Promise.resolve(),
        blockConcurrencyWhile(callback) {
            const pending = this.gate.then(callback);
            this.gate = pending.then(() => undefined);
            return pending;
        },
        storage: {
            async getAlarm() { return alarm; },
            async setAlarm(value) { alarm = value; },
            async deleteAlarm() { alarm = null; },
            async get(key) { return values.get(key); },
            async put(key, value) { values.set(key, value); },
        },
        getWebSockets(tag) { return sockets.filter((ws) => !tag || ws.tags.includes(tag)); },
        acceptWebSocket(ws, tags) { ws.tags = tags; sockets.push(ws); },
    };
    for (const attachment of attachments) {
        const ws = makeSocket(attachment);
        ctx.acceptWebSocket(ws, [attachment.role, `${attachment.role}:${attachment.id}`, `generation:${attachment.generation}`]);
    }
    const relay = new GroveRelay(ctx);
    await ctx.gate;
    return {
        relay, ctx, sockets, values, alarm: () => alarm, at: (value) => { now = value; },
        request: (role) => relay.fetch(new Request(`https://relay.example/relay/room/${role}`)),
    };
}
const controlState = (id = "old") => ({ role: "control", id, generation: id, leaseUntil: 1_070_000 });

test("a lost control expires without a close event and retires only its own generation", async (t) => {
    const f = await leaseFixture(t, [
        controlState(),
        { role: "client", id: "stream", generation: "old", pending: false },
        { role: "data", id: "stream", generation: "old" },
        { role: "data", id: "unrelated", generation: "other" },
    ]);
    assert.equal(f.alarm(), 1_070_000);
    f.at(1_070_000);
    await f.relay.alarm();
    assert.deepEqual(f.sockets.map((ws) => ws.closes > 0), [true, true, true, false]);
    assert.equal(f.relay.sockets("control").length, 0);
    assert.equal(f.alarm(), null);
    // 인증·페어링 저장소를 바꾸지 않고 통신 연결만 정리한다.
    assert.equal(f.values.size, 0);
});

test("heartbeat renews the lease across hibernation and an old alarm cannot expire a live control", async (t) => {
    const f = await leaseFixture(t, [controlState()]);
    const control = f.sockets[0];
    f.at(1_020_000);
    await f.relay.webSocketMessage(control, "ping");
    assert.deepEqual(control.messages, ["pong"]);
    assert.equal(f.alarm(), 1_090_000);
    const resumed = new GroveRelay(f.ctx);
    await f.ctx.gate;
    f.at(1_070_000);
    await resumed.alarm();
    assert.equal(control.closes, 0);
    assert.equal(f.alarm(), 1_090_000);
    f.at(1_090_000);
    await resumed.alarm();
    assert.ok(control.closes > 0);
});

test("a late heartbeat cannot revive an expired generation", async (t) => {
    const f = await leaseFixture(t, [controlState()]);
    f.at(1_070_000);
    await f.relay.webSocketMessage(f.sockets[0], "ping");
    assert.deepEqual(f.sockets[0].messages, []);
    assert.equal(f.relay.sockets("control").length, 0);
});

test("reconnect replaces a stale OPEN control before its lease ends; delayed old events do not close the replacement", async (t) => {
    const f = await leaseFixture(t, [controlState(), { role: "client", id: "stream", generation: "old", pending: false }]);
    // lease가 남아 있어도 기다리지 않는다.
    assert.equal((await f.request("control")).status, 101);
    const current = f.relay.sockets("control")[0];
    assert.notEqual(current, f.sockets[0]);
    assert.equal(f.relay.sockets("control").length, 1);
    assert.equal(f.sockets[0].closeCode, 4000);
    // 이전 세대의 브라우저 연결은 함께 닫아 새 제어 연결과 섞이지 않게 한다.
    assert.equal(f.sockets[1].closeCode, 1008);
    await f.relay.webSocketClose(f.sockets[0]);
    await f.relay.webSocketError(f.sockets[0]);
    await f.relay.webSocketMessage(f.sockets[0], "ping");
    assert.equal(current.closes, 0);
    assert.equal(f.relay.sockets("control").length, 1);
});

test("simultaneous reconnects leave one control, not two", async (t) => {
    const f = await leaseFixture(t, [controlState()]);
    const responses = await Promise.all([f.request("control"), f.request("control")]);
    assert.deepEqual(responses.map((r) => r.status), [101, 101]);
    assert.equal(f.relay.sockets("control").length, 1);
    // 나중에 들어온 연결이 남는다.
    assert.equal(f.relay.sockets("control")[0], f.sockets.at(-1));
});

test("client admission reaps stale controls even when the alarm has not run", async (t) => {
    const f = await leaseFixture(t, [controlState()]);
    f.at(1_070_000);
    const response = await f.relay.fetch(new Request("https://relay.example/api/e2ee/room"));
    assert.equal(response.status, 503);
    assert.equal(f.relay.sockets("control").length, 0);
});

test("deployment grants legacy controls one lease, not an unlimited lease on each wake", async (t) => {
    const f = await leaseFixture(t, [{ role: "control", id: "old", generation: "old", deadline: 10 }]);
    assert.equal(f.sockets[0].attachment.leaseUntil, 1_070_000);
    f.at(1_040_000);
    const resumed = new GroveRelay(f.ctx);
    await f.ctx.gate;
    assert.equal(f.sockets[0].attachment.leaseUntil, 1_070_000);
    f.at(1_070_000);
    await resumed.alarm();
    assert.equal(resumed.sockets("control").length, 0);
});

test("the shared alarm preserves the earlier pending handshake deadline", async (t) => {
    const id = "12345678-1234-4234-8234-123456789abc";
    const f = await leaseFixture(t, [
        controlState(),
        { role: "client", id, generation: "old", pending: true, deadline: 1_010_000 },
    ]);
    assert.equal(f.alarm(), 1_010_000);
    f.at(1_010_000);
    await f.relay.alarm();
    assert.equal(f.sockets[0].closes, 0);
    assert.ok(f.sockets[1].closes > 0);
    assert.equal(f.alarm(), 1_070_000);
});
