// relay 경유 암호화 전송 측정 탐침. 브라우저 transport.ts와 같은 handshake로 인증이 필요 없는 /api/v1/health만 호출한다.
// 대상 지정(둘 중 하나):
//   --state FILE        시험 대상 상태 파일(endpoint·key·origin). 로컬은 scripts/relay_stack.py가 만든다.
//   --data DIR          데몬 데이터 디렉터리(e2ee-identity.key·relay.json). 운영 측정용. 서버 키 원문은 출력하지 않는다.
// 모드:
//   v1 N        연결당 요청 하나를 N번 순차로 보낸다(기존 방식).
//   burst N     v1 요청 N개를 동시에 보낸다.
//   mux N       연결 하나(version 2)에서 N번 순차 + N개 동시 요청을 보낸다.
// 결과는 JSON 한 줄: 성공·실패 수, 지연 p50/p95/max(ms), 실패 사유.
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { createHash, createPrivateKey, createPublicKey, webcrypto } from "node:crypto";
const require = createRequire(import.meta.url);
const WebSocket = require("ws");
const subtle = webcrypto.subtle;
const enc = new TextEncoder(), dec = new TextDecoder();
const LABEL = enc.encode("grove-e2ee-v1");

const arg = (name) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : undefined; };
function target() {
    if (arg("state")) {
        const s = JSON.parse(readFileSync(arg("state"), "utf8"));
        return { endpoint: s.endpoint, pub: Buffer.from(s.key, "base64"), origin: s.origin };
    }
    const data = arg("data");
    if (!data) { console.error("--state FILE 또는 --data DIR이 필요합니다"); process.exit(2); }
    const seed = readFileSync(`${data}/e2ee-identity.key`);
    const pkcs8 = Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]);
    const pub = createPublicKey(createPrivateKey({ key: pkcs8, format: "der", type: "pkcs8" })).export({ format: "der", type: "spki" }).subarray(-32);
    const room = createHash("sha256").update(pub).digest("hex");
    const base = JSON.parse(readFileSync(`${data}/relay.json`, "utf8")).url.replace(/\/$/, "");
    return { endpoint: `${base}/api/e2ee/${room}`, pub, origin: arg("origin") ?? "https://grove.choondoggy.com" };
}
const T = target();

class Cipher {
    constructor(key) { this.key = key; this.n = 0n; }
    iv() { const iv = new Uint8Array(12); new DataView(iv.buffer).setBigUint64(4, this.n++); return iv; }
    seal(b) { return subtle.encrypt({ name: "AES-GCM", iv: this.iv() }, this.key, b); }
    async open(b) { return new Uint8Array(await subtle.decrypt({ name: "AES-GCM", iv: this.iv() }, this.key, b)); }
}

// 연결을 열고 handshake까지 끝낸다. 이후 frame은 next()로 받는다.
function connect(version) {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(T.endpoint, { headers: { Origin: T.origin } });
        ws.binaryType = "arraybuffer";
        const queue = []; let waiter = null; let failure = null;
        const fail = (e) => { failure ??= e; if (waiter) { const w = waiter; waiter = null; w.reject(failure); } reject(failure); };
        const timer = setTimeout(() => { fail(new Error("handshake timeout 10s")); ws.terminate(); }, 10_000);
        ws.on("message", (data, binary) => { const v = binary ? data : data.toString(); if (waiter) { const w = waiter; waiter = null; w.resolve(v); } else queue.push(v); });
        ws.on("unexpected-response", (_, res) => fail(new Error(`upgrade ${res.statusCode}`)));
        ws.on("error", (e) => fail(new Error(`ws error ${e.message}`)));
        ws.on("close", (code) => fail(new Error(`closed ${code}`)));
        const next = () => queue.length ? Promise.resolve(queue.shift()) : failure ? Promise.reject(failure) : new Promise((res, rej) => { waiter = { resolve: res, reject: rej }; });
        ws.on("open", async () => {
            try {
                const pair = await subtle.generateKey({ name: "X25519" }, false, ["deriveBits"]);
                const cpub = new Uint8Array(await subtle.exportKey("raw", pair.publicKey));
                ws.send(JSON.stringify({ version, key: Buffer.from(cpub).toString("base64") }));
                const hello = JSON.parse(await next());
                const spub = Buffer.from(hello.key, "base64");
                const transcript = Buffer.concat([LABEL, cpub, spub, T.pub]);
                const vkey = await subtle.importKey("raw", T.pub, { name: "Ed25519" }, false, ["verify"]);
                if (!await subtle.verify("Ed25519", vkey, Buffer.from(hello.signature, "base64"), transcript)) throw new Error("bad signature");
                const peer = await subtle.importKey("raw", spub, "X25519", false, []);
                const shared = await subtle.deriveBits({ name: "X25519", public: peer }, pair.privateKey, 256);
                const material = await subtle.importKey("raw", shared, "HKDF", false, ["deriveKey"]);
                const salt = await subtle.digest("SHA-256", transcript);
                const key = (d) => subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt, info: enc.encode(`grove-e2ee-v1/${d}`) }, material, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
                const tx = new Cipher(await key("c2s")), rx = new Cipher(await key("s2c"));
                clearTimeout(timer);
                // 암호화는 nonce 순서가 중요하므로 송신을 직렬화한다.
                let sends = Promise.resolve();
                const send = (bytes) => (sends = sends.then(async () => ws.send(await tx.seal(bytes))));
                const receive = async () => rx.open(await next());
                resolve({ ws, send, receive });
            } catch (e) { clearTimeout(timer); fail(e); ws.terminate(); }
        });
    });
}

const health = enc.encode(JSON.stringify({ kind: "http", path: "/api/v1/health", method: "GET", headers: [["x-grove-protocol", "1"]], body: "" }));

async function v1() {
    const t0 = performance.now();
    const c = await connect(1);
    try {
        await c.send(health);
        const meta = JSON.parse(dec.decode(await c.receive()));
        for (;;) {
            const b = await c.receive();
            if (b.length === 1 && b[0] === 2) break;
            await c.send(new Uint8Array([1]));
        }
        return { ok: meta.status === 200, ms: performance.now() - t0 };
    } finally { c.ws.close(); }
}

// version 2 frame: [종류][stream ID u32][payload]. 서버 계약: src/e2ee/mux.rs
function frame(kind, id, payload = new Uint8Array()) {
    const b = new Uint8Array(5 + payload.length); b[0] = kind; new DataView(b.buffer).setUint32(1, id); b.set(payload, 5); return b;
}
async function muxSession() {
    const c = await connect(2);
    const waiting = new Map(); let nextId = 1;
    (async () => {
        try {
            for (;;) {
                const b = await c.receive();
                const id = new DataView(b.buffer, b.byteOffset).getUint32(1);
                const w = waiting.get(id); if (!w) continue;
                if (b[0] === 0x11) w.status = JSON.parse(dec.decode(b.slice(5))).status;
                else if (b[0] === 0x12) await c.send(frame(0x02, id));
                else if (b[0] === 0x13) { waiting.delete(id); w.resolve({ ok: w.status === 200, ms: performance.now() - w.t0 }); }
                else if (b[0] === 0x14) { waiting.delete(id); w.resolve({ ok: false, error: "FAIL frame", ms: performance.now() - w.t0 }); }
            }
        } catch (e) { for (const w of waiting.values()) w.resolve({ ok: false, error: String(e.message ?? e), ms: performance.now() - w.t0 }); }
    })();
    const request = () => new Promise((resolve) => {
        const id = nextId++; waiting.set(id, { resolve, t0: performance.now() });
        c.send(frame(0x01, id, health)).catch((e) => resolve({ ok: false, error: String(e.message), ms: 0 }));
    });
    return { request, close: () => c.ws.close() };
}

const caught = (p) => p.catch((e) => ({ ok: false, error: String(e.message ?? e), ms: 0 }));
function summary(label, rs) {
    const ok = rs.filter((r) => r.ok), bad = rs.filter((r) => !r.ok);
    const t = ok.map((r) => Math.round(r.ms)).sort((a, b) => a - b);
    const errors = {}; for (const r of bad) errors[r.error ?? "status"] = (errors[r.error ?? "status"] ?? 0) + 1;
    console.log(JSON.stringify({ label, ok: ok.length, fail: bad.length, p50: t[Math.floor(t.length / 2)] ?? null, p95: t[Math.floor(t.length * 0.95)] ?? null, max: t.at(-1) ?? null, errors }));
    return bad.length;
}

const [mode, count] = [process.argv[2], Number(process.argv[3] ?? 20)];
let failed = 0;
if (mode === "v1") {
    const rs = []; for (let i = 0; i < count; i++) rs.push(await caught(v1()));
    failed = summary(`v1 sequential ${count}`, rs);
} else if (mode === "burst") {
    failed = summary(`v1 concurrent ${count}`, await Promise.all(Array.from({ length: count }, () => caught(v1()))));
} else if (mode === "mux") {
    const t0 = performance.now();
    const session = await muxSession();
    console.log(JSON.stringify({ label: "mux connect", ms: Math.round(performance.now() - t0) }));
    const seq = []; for (let i = 0; i < count; i++) seq.push(await session.request());
    failed += summary(`mux sequential ${count}`, seq);
    failed += summary(`mux concurrent ${count}`, await Promise.all(Array.from({ length: count }, () => session.request())));
    session.close();
} else { console.error("모드: v1 N | burst N | mux N"); process.exit(2); }
process.exit(failed ? 1 : 0);
