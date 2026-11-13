import { expect, test } from "@playwright/test";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { apiCall, ensureProjects, login, sessionView } from "./helpers";

type McpServer = { id: string; revision: number; name: string; config: Record<string, unknown>; enabled: boolean };

async function fixture() {
    let base = "";
    let challenge = "";
    let exchanges = 0;
    let invocations = 0;
    const server = createServer(async (request, response) => {
        const url = new URL(request.url!, base);
        response.setHeader("content-type", "application/json");
        if (url.pathname === "/.well-known/oauth-protected-resource/mcp") {
            response.end(JSON.stringify({ resource: `${base}/mcp`, authorization_servers: [base] })); return;
        }
        if (url.pathname === "/.well-known/oauth-authorization-server") {
            response.end(JSON.stringify({ issuer: base, authorization_endpoint: `${base}/authorize`, token_endpoint: `${base}/token`,
                response_types_supported: ["code"], code_challenge_methods_supported: ["S256"],
                token_endpoint_auth_methods_supported: ["none"], authorization_response_iss_parameter_supported: true })); return;
        }
        if (url.pathname === "/authorize") {
            challenge = url.searchParams.get("code_challenge")!;
            expect(url.searchParams.get("resource")).toBe(`${base}/mcp`);
            const callback = new URL(url.searchParams.get("redirect_uri")!);
            callback.searchParams.set("state", url.searchParams.get("state")!);
            callback.searchParams.set("code", "local-one-use-code");
            callback.searchParams.set("iss", base);
            response.setHeader("content-type", "text/html; charset=utf-8");
            response.end(`<html lang="ko"><body><h1>로컬 issuer 승인</h1><p>tools scope</p><a href="${callback.href.replaceAll("&", "&amp;")}">로컬 MCP 승인</a></body></html>`); return;
        }
        if (url.pathname === "/token") {
            let text = "";
            for await (const chunk of request) text += chunk.toString();
            const form = new URLSearchParams(text);
            expect(form.get("client_id")).toBe("registered-local-client");
            expect(form.get("resource")).toBe(`${base}/mcp`);
            if (form.get("grant_type") === "authorization_code") {
                expect(createHash("sha256").update(form.get("code_verifier")!).digest("base64url")).toBe(challenge);
            } else expect(form.get("refresh_token")).toBe("synthetic-refresh-private");
            exchanges++;
            response.end(JSON.stringify({ access_token: "synthetic-access-private", refresh_token: "synthetic-refresh-private",
                token_type: "Bearer", expires_in: 3600, scope: "tools" })); return;
        }
        if (url.pathname === "/mcp") {
            if (request.headers.authorization !== "Bearer synthetic-access-private") { response.writeHead(401); response.end(); return; }
            if (request.method === "DELETE") { response.end(); return; }
            let text = "";
            for await (const chunk of request) text += chunk.toString();
            const q = JSON.parse(text) as { id?: number; method: string };
            if (q.method === "notifications/initialized") { response.writeHead(202); response.end(); return; }
            let result: unknown;
            if (q.method === "initialize") result = { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "local", version: "1" } };
            else if (q.method === "tools/list") result = { tools: [{ name: "echo", inputSchema: { type: "object" } }] };
            else { invocations++; result = { content: [{ type: "text", text: "approved OAuth MCP result synthetic-access-private" }] }; }
            response.end(JSON.stringify({ jsonrpc: "2.0", id: q.id, result })); return;
        }
        response.writeHead(404); response.end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("local fixture address missing");
    base = `http://127.0.0.1:${address.port}`;
    return { base, exchanges: () => exchanges, invocations: () => invocations, close: async () => {
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) => server.close((e) => e ? reject(e) : resolve()));
    } };
}

test("사전 등록 MCP OAuth는 취소·늦은 callback·완료 응답 유실·명시적 갱신 뒤 연결 확인과 이번만 승인까지 이어진다", async ({ page }) => {
    const remote = await fixture();
    const name = `oauth-browser-${Date.now()}`;
    let server = await apiCall<McpServer>("POST", "/mcp/servers", {
        name, enabled: true, config: { transport: "http", endpoint: `${remote.base}/mcp` },
    });
    const oauth = { issuer: remote.base, authorization_endpoint: `${remote.base}/authorize`, token_endpoint: `${remote.base}/token`,
        client_id: "registered-local-client", scopes: ["tools"], redirect_uri: `http://127.0.0.1:17741/api/mcp-oauth/callback/${server.id}` };
    server = await apiCall<McpServer>("PUT", `/mcp/servers/${server.id}`, {
        expected_revision: server.revision, server: { name, enabled: true, config: { ...server.config, oauth } },
    });
    try {
        await login(page);
        await page.getByRole("button", { name: "설정", exact: true }).click();
        await page.getByLabel("설정 검색", { exact: true }).fill("MCP");
        const panel = page.getByTestId("mcp-panel");
        const row = panel.getByTestId("mcp-row").filter({ hasText: name });
        const connection = row.getByRole("region", { name: "MCP OAuth", exact: true });
        await expect(connection).toContainText(remote.base);
        await expect(connection).toContainText("tools");
        await connection.getByRole("button", { name: "OAuth 연결 시작", exact: true }).click();
        await expect(connection).toContainText("승인 대기");
        const firstPopup = page.waitForEvent("popup");
        await connection.getByRole("button", { name: "OAuth 승인 페이지 열기", exact: true }).click();
        const cancelled = await firstPopup;
        await expect(cancelled.getByRole("heading")).toHaveText("로컬 issuer 승인");
        await connection.getByRole("button", { name: "OAuth 연결 취소", exact: true }).click();
        await expect(connection).toContainText("취소됨");
        await cancelled.getByRole("link", { name: "로컬 MCP 승인", exact: true }).click();
        await expect(cancelled.locator("#status")).toContainText("원래 MCP 설정 창");
        expect(remote.exchanges()).toBe(0);
        await cancelled.close();
        await connection.getByRole("button", { name: "OAuth 연결 시작", exact: true }).click();
        const popupEvent = page.waitForEvent("popup");
        await connection.getByRole("button", { name: "OAuth 승인 페이지 열기", exact: true }).click();
        const popup = await popupEvent;
        const keys: string[] = [];
        await page.route(`**/api/v1/mcp/servers/${server.id}/oauth/complete`, async (route) => {
            keys.push(route.request().headers()["idempotency-key"]!);
            const response = await route.fetch();
            if (keys.length === 1) await route.abort("connectionfailed");
            else await route.fulfill({ response });
        });
        await popup.getByRole("link", { name: "로컬 MCP 승인", exact: true }).click();
        await expect(connection.getByRole("group", { name: "OAuth 결과 재확인", exact: true })).toBeVisible();
        expect(remote.exchanges()).toBe(1);
        await connection.getByRole("button", { name: "같은 OAuth 요청 결과 확인", exact: true }).click();
        await expect(connection.getByRole("group", { name: "OAuth 결과 재확인", exact: true })).toHaveCount(0);
        await expect(connection).toContainText("OAuth 완료 · MCP 연결 확인 필요");
        expect(keys).toHaveLength(2); expect(keys[0]).toBe(keys[1]);
        expect(remote.exchanges()).toBe(1);
        await popup.close();
        await row.getByRole("button", { name: "MCP 연결 확인 준비", exact: true }).click();
        await panel.getByRole("button", { name: "확인하고 MCP 연결 검사", exact: true }).click();
        await expect(row).toContainText("성공 · 확인 후 연결 닫힘");
        await connection.getByRole("button", { name: "OAuth 자격 명시적 갱신", exact: true }).click();
        await expect.poll(remote.exchanges).toBe(2);
        await expect(row).not.toContainText("성공 · 확인 후 연결 닫힘");
        await expect(connection).toContainText("OAuth 완료 · MCP 연결 확인 필요");
        await row.getByRole("button", { name: "MCP 연결 확인 준비", exact: true }).click();
        await panel.getByRole("button", { name: "확인하고 MCP 연결 검사", exact: true }).click();
        await expect(row).toContainText("성공 · 확인 후 연결 닫힘");
        await expect(panel).not.toContainText("synthetic-access-private");
        await expect(panel).not.toContainText("synthetic-refresh-private");
        const { a } = await ensureProjects();
        const session = await apiCall<{ id: string }>("POST", `/projects/${a.id}/sessions`, { title: name });
        await apiCall("POST", "/recent/touch", { kind: "session", project_id: a.id, resource_id: session.id });
        await page.locator(".recent").getByRole("button", { name: new RegExp(name) }).click();
        const call = await apiCall<{ id: string }>("POST", `/sessions/${session.id}/tool-requests`, {
            name: "mcp_call", args: { server_id: server.id, tool: `${name}/echo`, arguments: { message: "explicitly-approved" } },
        });
        const view = sessionView(page, session.id);
        const approval = view.getByRole("region", { name: "mcp_call 승인 요청", exact: true });
        await expect(approval).toContainText(`${name}/echo`);
        expect(remote.invocations()).toBe(0);
        await approval.getByRole("button", { name: "이번만 승인", exact: true }).click();
        await expect.poll(async () => (await apiCall<{ status: string }>("GET", `/tool-calls/${call.id}`)).status).toBe("succeeded");
        expect(remote.invocations()).toBe(1);
        await expect(view).not.toContainText("synthetic-access-private");
    } finally {
        await remote.close();
        const list = await apiCall<McpServer[]>("GET", "/mcp/servers");
        for (const item of list.filter((s) => s.id === server.id)) await apiCall("DELETE", `/mcp/servers/${item.id}?expected_revision=${item.revision}`);
    }
});
