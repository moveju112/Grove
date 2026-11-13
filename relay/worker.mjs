// 릴레이는 암호문만 전달한다. 서버 인증 비밀은 Worker secret, 방 ID는 서버 공개키의 SHA-256이다.
// 배포 시 ROOM(64자리 소문자 hex)과 DAEMON_TOKEN(64자리 hex)을 secret으로 등록한다.
const PAGES = "https://grove.choondoggy.com";
const HEX = /^[0-9a-f]{64}$/;
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MAX_FRAME = 12 * 1024 * 1024;
const fail = (status) => new Response(null, { status });
const close = (ws) => { if (ws.readyState !== 3) ws.close(1008, "relay disconnected"); };

async function authorized(request, env) {
    const value = request.headers.get("Authorization") ?? "";
    if (!HEX.test(env.DAEMON_TOKEN ?? "") || !/^Bearer [0-9a-f]{64}$/.test(value)) return false;
    const digest = async (s) => new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
    const [a, b] = await Promise.all([digest(value), digest(`Bearer ${env.DAEMON_TOKEN}`)]);
    let different = 0;
    for (let i = 0; i < a.length; i++) different |= a[i] ^ b[i];
    return different === 0;
}

export default {
    async fetch(request, env) {
        const url = new URL(request.url);
        if (request.method !== "GET" || url.search) return fail(404);
        if (!HEX.test(env.ROOM ?? "")) return fail(503);
        const client = url.pathname === `/api/e2ee/${env.ROOM}`;
        const privatePath = new RegExp(`^/relay/${env.ROOM}/(control|data/([0-9a-f-]+))$`).exec(url.pathname);
        if (!client && !privatePath) return fail(404);
        if (client) {
            if (request.headers.get("Origin") !== PAGES) return fail(403);
        } else if (!await authorized(request, env)) return fail(403);
        if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") return fail(426);
        return env.RELAY.getByName(env.ROOM).fetch(request);
    },
};

export class GroveRelay {
    constructor(ctx) { this.ctx = ctx; }
    sockets(tag) { return this.ctx.getWebSockets(tag).filter((ws) => ws.readyState === 1); }
    async fetch(request) {
        const path = new URL(request.url).pathname;
        const role = path.includes("/api/e2ee/") ? "client" : path.endsWith("/control") ? "control" : "data";
        let id = role === "data" ? path.split("/").at(-1) : crypto.randomUUID();
        if (role === "data" && (!ID.test(id) || this.sockets(`data:${id}`).length || !this.sockets(`client:${id}`).length)) return fail(409);
        if (role === "control" && this.sockets("control").length) return fail(409);
        if (role === "client") {
            if (!this.sockets("control").length) return fail(503);
            if (this.sockets("client").length >= 64) return fail(429);
            const allowed = await this.ctx.blockConcurrencyWhile(async () => {
                const now = Math.floor(Date.now() / 60000);
                const rate = await this.ctx.storage.get("admission") ?? { minute: now, count: 0 };
                if (rate.minute !== now) { rate.minute = now; rate.count = 0; }
                if (rate.count >= 600) return false;
                rate.count++;
                await this.ctx.storage.put("admission", rate);
                return true;
            });
            if (!allowed) return fail(429);
            if (!this.sockets("control").length || this.sockets("client").length >= 64) return fail(503);
        }
        const [client, server] = Object.values(new WebSocketPair());
        const generation = role === "control" ? id : role === "client"
            ? this.sockets("control")[0].deserializeAttachment().id
            : this.sockets(`client:${id}`)[0].deserializeAttachment().generation;
        this.ctx.acceptWebSocket(server, [role, `${role}:${id}`, `generation:${generation}`]);
        server.serializeAttachment({ role, id, generation, pending: role === "client", deadline: Date.now() + 10000 });
        if (role === "client") {
            this.sockets("control")[0].send(JSON.stringify({ type: "open", id }));
            if (await this.ctx.storage.getAlarm() === null) await this.ctx.storage.setAlarm(Date.now() + 10000);
        }
        if (role === "data") {
            const peer = this.sockets(`client:${id}`)[0];
            const state = peer.deserializeAttachment();
            if (state.hello) server.send(state.hello);
            peer.serializeAttachment({ ...state, pending: false, hello: undefined });
        }
        return new Response(null, { status: 101, webSocket: client });
    }
    webSocketMessage(ws, message) {
        const state = ws.deserializeAttachment();
        if (state.role === "control") {
            if (message === "ping") ws.send("pong");
            else this.disconnect(ws);
            return;
        }
        const size = typeof message === "string" ? new TextEncoder().encode(message).length : message.byteLength;
        if (size > MAX_FRAME) { this.disconnect(ws); return; }
        const peer = this.sockets(`${state.role === "client" ? "data" : "client"}:${state.id}`)[0];
        if (peer) {
            try { peer.send(message); } catch { this.disconnect(ws); }
        } else if (state.role === "client" && state.pending && !state.hello && typeof message === "string" && size <= 256) {
            // 초기 공개키 handshake 한 개만 연결 대기 중 보관한다. API 본문·자격증명은 받지 않는다.
            ws.serializeAttachment({ ...state, hello: message });
        } else this.disconnect(ws);
    }
    disconnect(ws) {
        const state = ws.deserializeAttachment();
        const peers = state.role === "control" ? this.ctx.getWebSockets(`generation:${state.id}`) :
            this.ctx.getWebSockets(`${state.role === "client" ? "data" : "client"}:${state.id}`);
        for (const peer of peers) close(peer);
        close(ws);
    }
    webSocketClose(ws) { this.disconnect(ws); }
    webSocketError(ws) { this.disconnect(ws); }
    async alarm() {
        let deadline = Infinity;
        for (const ws of this.sockets("client")) {
            const state = ws.deserializeAttachment();
            if (!state.pending) continue;
            if (state.deadline <= Date.now()) this.disconnect(ws);
            else deadline = Math.min(deadline, state.deadline);
        }
        if (deadline !== Infinity) await this.ctx.storage.setAlarm(deadline);
    }
}
