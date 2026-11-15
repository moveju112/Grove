import { expect, test as base } from "@playwright/test";
import { execFileSync, spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { request } from "node:https";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:tls";
import { openTool } from "./helpers";

type Reply = { status: number; body: unknown };
type TlsHost = {
    origin: string; token: string; name: string; project: string; link: string;
    api: (method: string, path: string, body?: unknown, headers?: Record<string, string>) => Promise<Reply>;
};

const test = base.extend<{}, { tlsHost: TlsHost }>({
    tlsHost: [async ({}, use) => {
        const work = mkdtempSync(join(tmpdir(), "grove-tls-"));
        const key = join(work, "key.pem");
        const cert = join(work, "cert.pem");
        // 시험 전용 하루짜리 인증서다. 운영 trust store·서비스·인증서 설정은 변경하지 않는다.
        execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert, "-days", "1",
            "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1"], { stdio: "pipe" });
        const ca = readFileSync(cert);
        const sockets = new Set<Socket>();
        const proxy = createServer({ key: readFileSync(key), cert: ca }, (client) => {
            const upstream = connect(17745, "127.0.0.1");
            for (const socket of [client, upstream]) {
                sockets.add(socket);
                socket.on("close", () => sockets.delete(socket));
            }
            client.on("error", () => upstream.destroy());
            upstream.on("error", () => client.destroy());
            client.on("close", () => upstream.destroy());
            upstream.on("close", () => client.destroy());
            client.pipe(upstream).pipe(client);
        });
        await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
        const port = (proxy.address() as { port: number }).port;
        const origin = `https://127.0.0.1:${port}`;
        let token = "";
        const api: TlsHost["api"] = (method, path, body, extra = {}) => new Promise((resolve, reject) => {
            const req = request(origin + (path === "/e2ee" ? "/api/e2ee" : "/api/v1" + path), {
                method, ca,
                headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), "content-type": "application/json", "idempotency-key": randomUUID(), ...extra },
            }, (response) => {
                let text = "";
                response.setEncoding("utf8");
                response.on("data", (chunk: string) => { text += chunk; });
                response.on("end", () => resolve({ status: response.statusCode!, body: text ? JSON.parse(text) : null }));
                response.on("error", reject);
            });
            // 예상과 달리 upgrade되면 소켓을 남기지 않고 응답 상태로 판정한다.
            req.on("upgrade", (response, socket) => { socket.destroy(); resolve({ status: response.statusCode!, body: null }); });
            req.on("error", reject);
            req.setTimeout(5000, () => req.destroy(new Error("TLS fixture request timeout")));
            req.end(body === undefined ? undefined : JSON.stringify(body));
        });
        const root = new URL("../..", import.meta.url).pathname;
        const child = spawn(process.env.GROVE_BIN!, ["serve", "--listen", "127.0.0.1:17745", "--data-dir", join(work, "data")], {
            env: { ...process.env, GROVE_WEB_DIR: join(root, "web/build/client"), GROVE_TLS_TERMINATED: "1", GROVE_ALLOWED_ORIGINS: "", GROVE_ALLOWED_HOSTS: `127.0.0.1:${port}`, GROVE_LOG: "warn" },
            stdio: ["ignore", "inherit", "inherit"],
        });
        const exited = once(child, "exit");
        try {
            await expect.poll(async () => {
                try { return (await api("GET", "/health")).status; }
                catch { return 0; }
            }, { timeout: 20_000 }).toBe(426);
            token = readFileSync(join(work, "data/owner-token"), "utf8").trim();
            const project = join(work, "project");
            mkdirSync(project);
            const name = "project";
            const link = execFileSync(process.env.GROVE_BIN!, ["connect-link", origin.replace("https:", "wss:") + "/api/e2ee",
                "--data-dir", join(work, "data")], { encoding: "utf8" }).trim();
            // CA 신뢰 없이는 실제 TLS 인증서 검증이 실패한다.
            await expect(new Promise<void>((resolve, reject) => {
                const req = request(origin, (response) => { response.resume(); resolve(); });
                req.on("error", reject);
                req.end();
            })).rejects.toMatchObject({ code: "DEPTH_ZERO_SELF_SIGNED_CERT" });
            // 같은 CA를 신뢰하더라도 다른 hostname이면 거절한다.
            await expect(new Promise<void>((resolve, reject) => {
                const req = request(origin, { ca, servername: "wrong.example" }, (response) => { response.resume(); resolve(); });
                req.on("error", reject);
                req.end();
            })).rejects.toMatchObject({ code: "ERR_TLS_CERT_ALTNAME_INVALID" });
            await use({ origin, token, name, api, project, link });
        } finally {
            child.kill("SIGTERM");
            await exited;
            for (const socket of sockets) socket.destroy();
            await new Promise<void>((resolve, reject) => proxy.close((error) => error ? reject(error) : resolve()));
            rmSync(work, { recursive: true });
        }
    }, { scope: "worker" }],
});

test("실제 TLS proxy 위에서 E2EE 로그인·봉인 refresh·SSE·터미널을 유지하고 평문 API를 막는다", async ({ browser, tlsHost }) => {
    // 브라우저의 인증서 예외는 이 임시 self-signed fixture의 context에만 둔다.
    const context = await browser.newContext({ ignoreHTTPSErrors: true });
    try {
        const page = await context.newPage();
        const socketProtocols: string[] = [];
        const wire: Buffer[] = [];
        page.on("websocket", (socket) => {
            socketProtocols.push(new URL(socket.url()).protocol);
            socket.on("framesent", ({ payload }) => wire.push(Buffer.from(payload)));
            socket.on("framereceived", ({ payload }) => wire.push(Buffer.from(payload)));
        });
        await page.goto(tlsHost.origin + "/" + new URL(tlsHost.link).hash);
        await page.locator("html[data-hydrated=true]").waitFor();
        await page.getByRole("button", { name: "서버 확인 후 연결" }).click();
        await page.getByLabel("토큰").fill(tlsHost.token);
        await page.getByRole("button", { name: "로그인", exact: true }).click();
        await expect(page.getByTestId("conn")).toHaveText("연결됨", { timeout: 15_000 });
        const cookies = await context.cookies(tlsHost.origin + "/api/v1/auth/refresh");
        expect(cookies.some((cookie) => cookie.name.startsWith("grove_refresh_"))).toBe(false);
        await page.getByRole("button", { name: "만들기", exact: true }).click();
        await page.getByRole("button", { name: "프로젝트 추가", exact: true }).click();
        await page.getByLabel("폴더 경로", { exact: true }).fill(tlsHost.project);
        await page.getByRole("button", { name: "이 폴더를 프로젝트로 추가" }).click();
        await page.getByTestId("project-row").getByRole("button", { name: tlsHost.name, exact: true }).click();
        const terminals = page.getByTestId("terminal-list");
        await openTool(page.getByTestId("project-view"), "터미널");
        await terminals.getByRole("button", { name: "새 터미널" }).click();
        const terminal = page.getByTestId("terminal-view");
        await expect(terminal).toHaveAttribute("data-conn", "open");
        await terminal.locator(".xterm").click();
        await page.keyboard.type("echo tls-$((20+22))");
        await page.keyboard.press("Enter");
        await expect(terminal.locator(".xterm-rows")).toContainText("tls-42");
        expect((await tlsHost.api("GET", "/projects")).status).toBe(426);
        const rejected = await tlsHost.api("GET", "/e2ee", undefined, {
            origin: tlsHost.origin.replace("https:", "http:"), "x-forwarded-proto": "https",
            connection: "Upgrade", upgrade: "websocket", "sec-websocket-key": randomBytes(16).toString("base64"), "sec-websocket-version": "13",
        });
        expect(rejected.status).toBe(403);
        const connected = await page.evaluate((path) => new Promise<boolean>((resolve) => {
            const socket = new WebSocket(`wss://${location.host}${path}`);
            socket.onopen = () => { socket.close(); resolve(true); };
            socket.onerror = () => resolve(false);
        }), "/api/e2ee");
        expect(connected).toBe(true);
        await page.reload();
        await expect(page.getByTestId("conn")).toHaveText("연결됨", { timeout: 15_000 });
        await expect(page.getByTestId("terminal-view")).toHaveAttribute("data-conn", "open");
        await expect(page.getByTestId("terminal-view").locator(".xterm-rows")).toContainText("tls-42");
        expect(socketProtocols.length >= 3).toBe(true);
        expect(socketProtocols.every((protocol) => protocol === "wss:")).toBe(true);
        expect(wire.length).toBeGreaterThan(10);
        expect(wire.some((frame) => frame.includes(Buffer.from(tlsHost.token)))).toBe(false);
        expect(wire.some((frame) => frame.includes(Buffer.from("echo tls-$((20+22))")))).toBe(false);
        const sealed = await page.evaluate(async () => {
            const db = await new Promise<IDBDatabase>((resolve, reject) => {
                const request = indexedDB.open("grove.e2ee.credentials.v1");
                request.onsuccess = () => resolve(request.result);
                request.onerror = () => reject(request.error);
            });
            const entries = await new Promise<Array<{ key: CryptoKey; data: ArrayBuffer }>>((resolve, reject) => {
                const request = db.transaction("credentials").objectStore("credentials").getAll();
                request.onsuccess = () => resolve(request.result);
                request.onerror = () => reject(request.error);
            });
            db.close();
            return entries.map((entry) => ({ extractable: entry.key.extractable, algorithm: entry.key.algorithm.name, bytes: entry.data.byteLength }));
        });
        expect(sealed).toHaveLength(1);
        expect(sealed[0]).toMatchObject({ extractable: false, algorithm: "AES-GCM" });
        page.once("dialog", (dialog) => dialog.accept());
        await page.getByTestId("terminal-view").getByRole("button", { name: "종료", exact: true }).click();
        await expect(page.getByTestId("terminal-view")).toHaveAttribute("data-conn", "readonly");
    } finally {
        await context.close();
    }
});
