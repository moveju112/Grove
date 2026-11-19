// 릴레이는 암호문만 전달한다. 서버 인증 비밀은 Worker secret, 방 ID는 서버 공개키의 SHA-256이다.
// 배포 시 ROOM(64자리 소문자 hex)과 DAEMON_TOKEN(64자리 hex)을 secret으로 등록한다.
// 브라우저 Origin은 운영 Pages 하나만 허용한다. 스테이징·로컬 스택은 PAGES_ORIGIN 변수로 자기 화면 주소 하나를 지정한다.
const PAGES = "https://grove.choondoggy.com";
const ORIGIN = /^https?:\/\/[a-z0-9.-]+(?::\d+)?$/;
const pagesOrigin = (env) => ORIGIN.test(env.PAGES_ORIGIN ?? "") ? env.PAGES_ORIGIN : PAGES;
const HEX = /^[0-9a-f]{64}$/;
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MAX_FRAME = 32 * 1024 * 1024;
// 서버의 20초 heartbeat 세 번을 놓쳐도 여유를 둔다. 로그인·페어링 수명과는 무관하다.
const CONTROL_LEASE_MS = 70_000;
// 새 제어 연결에 자리를 넘긴 연결에 보내는 close code. 서버는 이 code로 교체를 구분한다.
const REPLACED = 4000;
const fail = (status) => new Response(null, { status });
const close = (ws, code = 1008, reason = "relay disconnected") => { if (ws.readyState !== 3) ws.close(code, reason); };

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
            if (request.headers.get("Origin") !== pagesOrigin(env)) return fail(403);
        } else if (!await authorized(request, env)) return fail(403);
        if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") return fail(426);
        return env.RELAY.getByName(env.ROOM).fetch(request);
    },
};

export class GroveRelay {
    constructor(ctx) {
        this.ctx = ctx;
        ctx.blockConcurrencyWhile(async () => {
            this.expireControls();
            await this.scheduleAlarm();
        });
    }
    sockets(tag) {
        // close 완료를 기다리지 않는다. 네트워크가 끊겨도 OPEN으로 남는 소켓은 재접속을 막으면 안 된다.
        return this.ctx.getWebSockets(tag).filter((ws) => ws.readyState === 1 && !ws.deserializeAttachment().retired);
    }
    expireControls() {
        const now = Date.now();
        for (const ws of this.sockets("control")) {
            const state = ws.deserializeAttachment();
            if (state.leaseUntil === undefined) {
                // 배포 이전 연결에는 한 번만 유예한다. 이후 재기동·hibernation은 만료 시각을 연장하지 않는다.
                ws.serializeAttachment({ ...state, leaseUntil: now + CONTROL_LEASE_MS });
            } else if (state.leaseUntil <= now) this.disconnect(ws);
        }
    }
    async scheduleAlarm() {
        let deadline = Infinity;
        for (const ws of this.sockets("control")) deadline = Math.min(deadline, ws.deserializeAttachment().leaseUntil);
        for (const ws of this.sockets("client")) {
            const state = ws.deserializeAttachment();
            if (state.pending) deadline = Math.min(deadline, state.deadline);
        }
        const scheduled = await this.ctx.storage.getAlarm();
        if (deadline !== Infinity) {
            if (scheduled !== deadline) await this.ctx.storage.setAlarm(deadline);
        } else if (scheduled !== null) await this.ctx.storage.deleteAlarm();
    }
    fetch(request) {
        // 만료 확인부터 새 연결 등록까지 직렬화해 동시 재접속이 제어 연결을 두 개 만들지 않게 한다.
        return this.ctx.blockConcurrencyWhile(async () => {
            const response = await this.admit(request);
            await this.scheduleAlarm();
            return response;
        });
    }
    async admit(request) {
        this.expireControls();
        const path = new URL(request.url).pathname;
        const role = path.includes("/api/e2ee/") ? "client" : path.endsWith("/control") ? "control" : "data";
        let id = role === "data" ? path.split("/").at(-1) : crypto.randomUUID();
        if (role === "data" && (!ID.test(id) || this.sockets(`data:${id}`).length || !this.sockets(`client:${id}`).length)) return fail(409);
        // 제어 연결은 데몬 비밀로만 열린다. 끊김을 감지하지 못해 OPEN으로 남은 이전 연결이
        // lease 만료까지 재접속을 막지 않도록, 새 연결이 이전 세대를 즉시 대체한다.
        if (role === "control") for (const old of this.sockets("control")) this.disconnect(old, REPLACED, "control replaced");
        if (role === "client") {
            if (!this.sockets("control").length) return fail(503);
            if (this.sockets("client").length >= 64) return fail(429);
            const now = Math.floor(Date.now() / 60000);
            const rate = await this.ctx.storage.get("admission") ?? { minute: now, count: 0 };
            if (rate.minute !== now) { rate.minute = now; rate.count = 0; }
            if (rate.count >= 600) return fail(429);
            rate.count++;
            await this.ctx.storage.put("admission", rate);
            this.expireControls();
            if (!this.sockets("control").length || this.sockets("client").length >= 64) return fail(503);
        }
        const [client, server] = Object.values(new WebSocketPair());
        const generation = role === "control" ? id : role === "client"
            ? this.sockets("control")[0].deserializeAttachment().id
            : this.sockets(`client:${id}`)[0].deserializeAttachment().generation;
        this.ctx.acceptWebSocket(server, [role, `${role}:${id}`, `generation:${generation}`]);
        server.serializeAttachment({ role, id, generation, pending: role === "client", deadline: Date.now() + 10000,
            ...(role === "control" ? { leaseUntil: Date.now() + CONTROL_LEASE_MS } : {}) });
        if (role === "client") {
            const control = this.sockets("control")[0];
            try { control.send(JSON.stringify({ type: "open", id })); }
            catch { this.disconnect(control); return fail(503); }
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
        if (state.retired) { close(ws); return; }
        if (state.role === "control") {
            return this.ctx.blockConcurrencyWhile(async () => {
                this.expireControls();
                const current = ws.deserializeAttachment();
                if (!current.retired && message === "ping") {
                    ws.serializeAttachment({ ...current, leaseUntil: Date.now() + CONTROL_LEASE_MS });
                    try { ws.send("pong"); } catch { this.disconnect(ws); }
                } else this.disconnect(ws);
                await this.scheduleAlarm();
            });
        }
        const size = typeof message === "string" ? new TextEncoder().encode(message).length : message.byteLength;
        if (size > MAX_FRAME) { this.disconnect(ws); return; }
        const peer = this.sockets(`${state.role === "client" ? "data" : "client"}:${state.id}`)
            .find((peer) => peer.deserializeAttachment().generation === state.generation);
        if (peer) {
            try { peer.send(message); } catch { this.disconnect(ws); }
        } else if (state.role === "client" && state.pending && !state.hello && typeof message === "string" && size <= 256) {
            // 초기 공개키 handshake 한 개만 연결 대기 중 보관한다. API 본문·자격증명은 받지 않는다.
            ws.serializeAttachment({ ...state, hello: message });
        } else this.disconnect(ws);
    }
    disconnect(ws, code, reason) {
        const state = ws.deserializeAttachment();
        if (state.retired) { close(ws); return; }
        const peers = state.role === "control" ? this.ctx.getWebSockets(`generation:${state.id}`) :
            this.ctx.getWebSockets(`${state.role === "client" ? "data" : "client"}:${state.id}`);
        ws.serializeAttachment({ ...state, retired: true });
        for (const peer of peers) {
            const attachment = peer.deserializeAttachment();
            // 제어 연결은 자기 세대 tag에도 속한다. 자신은 아래에서 지정한 code로 닫는다.
            // hibernation 뒤에는 객체 동일성이 보장되지 않아 attachment로 구분한다.
            if (attachment.role === state.role && attachment.id === state.id) continue;
            if (attachment.generation !== state.generation) continue;
            peer.serializeAttachment({ ...attachment, retired: true });
            close(peer);
        }
        close(ws, code, reason);
    }
    webSocketClose(ws) {
        return this.ctx.blockConcurrencyWhile(async () => {
            this.disconnect(ws);
            await this.scheduleAlarm();
        });
    }
    webSocketError(ws) { return this.webSocketClose(ws); }
    alarm() {
        return this.ctx.blockConcurrencyWhile(async () => {
            this.expireControls();
            for (const ws of this.sockets("client")) {
                const state = ws.deserializeAttachment();
                if (state.pending && state.deadline <= Date.now()) this.disconnect(ws);
            }
            await this.scheduleAlarm();
        });
    }
}
