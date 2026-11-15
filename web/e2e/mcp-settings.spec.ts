import { expect, test } from "@playwright/test";
import { apiCall, ensureProjects, login, sessionView } from "./helpers";
import { createServer } from "node:http";

type Server = { id: string; name: string; config: unknown; enabled: boolean; revision: number; timeout_secs: number };

test("MCP 등록·편집·사용 설정·삭제는 실제 연결과 구분하고 secret 원문을 표시하지 않는다", async ({ page }) => {
    const name = `mcp-ui-${Date.now()}`;
    const secret = await apiCall<{ id: string }>("POST", "/secrets", { label: name, value: "Bearer mcp-ui-fixture-private" });
    try {
        await login(page);
        await page.getByRole("button", { name: "설정", exact: true }).click();
        await page.getByLabel("설정 검색", { exact: true }).fill("MCP");
        const panel = page.getByTestId("mcp-panel");
        await panel.getByLabel("MCP 이름", { exact: true }).fill(name);
        await panel.getByLabel("MCP 설정 JSON", { exact: true }).fill(JSON.stringify({
            transport: "http", endpoint: "https://example.com/mcp", header_secrets: { Authorization: secret.id },
        }));
        await panel.getByRole("button", { name: "MCP 설정 저장", exact: true }).click();
        const row = panel.getByTestId("mcp-row").filter({ hasText: name });
        await expect(row).toContainText("사용 안 함");
        await expect(panel).not.toContainText("mcp-ui-fixture-private");
        await row.getByRole("button", { name: "MCP 사용 켜기", exact: true }).click();
        await expect(row).toContainText("사용 설정 · 미연결");
        await row.getByRole("button", { name: "MCP 편집", exact: true }).click();
        await panel.getByLabel("MCP timeout(초)", { exact: true }).fill("90");
        await panel.getByRole("button", { name: "MCP 설정 저장", exact: true }).click();
        await expect(row).toContainText("revision 3");
        await page.reload();
        await page.getByLabel("설정 검색", { exact: true }).fill("MCP");
        await expect(row).toContainText("사용 설정 · 미연결");
        await row.getByRole("button", { name: "MCP 사용 끄기", exact: true }).click();
        await expect(row).toContainText("사용 안 함");
        await row.getByRole("button", { name: "MCP 삭제 확인", exact: true }).click();
        await panel.getByRole("button", { name: "삭제 취소", exact: true }).click();
        await expect(row).toHaveCount(1);
        await row.getByRole("button", { name: "MCP 삭제 확인", exact: true }).click();
        await panel.getByRole("button", { name: "이 MCP 설정 삭제", exact: true }).click();
        await expect(row).toHaveCount(0);
        const secrets = await apiCall<{ id: string }[]>("GET", "/secrets");
        expect(secrets.some((s) => s.id === secret.id)).toBe(true);
    } finally {
        const list = await apiCall<Server[]>("GET", "/mcp/servers");
        for (const s of list.filter((s) => s.name === name)) await apiCall("DELETE", `/mcp/servers/${s.id}?expected_revision=${s.revision}`);
        await apiCall("DELETE", `/secrets/${secret.id}`);
    }
});

test("MCP 오래된 revision·잘못된 설정은 덮어쓰지 않고 응답 유실은 같은 키로 확인한다", async ({ page }) => {
    const name = `mcp-conflict-${Date.now()}`;
    const config = { transport: "stdio", command: "not-executed-fixture", args: [], env_secrets: {} };
    const created = await apiCall<Server>("POST", "/mcp/servers", { name, config });
    try {
        await login(page);
        await page.getByRole("button", { name: "설정", exact: true }).click();
        await page.getByLabel("설정 검색", { exact: true }).fill("MCP");
        const panel = page.getByTestId("mcp-panel");
        const row = panel.getByTestId("mcp-row").filter({ hasText: name });
        await row.getByRole("button", { name: "MCP 편집", exact: true }).click();
        await panel.getByLabel("MCP timeout(초)", { exact: true }).fill("80");
        await apiCall("PUT", `/mcp/servers/${created.id}`, { expected_revision: 1, server: { name, config, timeout_secs: 70 } });
        await panel.getByRole("button", { name: "MCP 설정 저장", exact: true }).click();
        await expect(panel.getByRole("alert")).toContainText("다른 요청으로 변경");
        await expect(panel.getByLabel("MCP timeout(초)", { exact: true })).toHaveValue("80");
        await panel.getByRole("button", { name: "최신 MCP 설정 사용", exact: true }).click();
        await panel.getByLabel("MCP 설정 JSON", { exact: true }).fill('{"transport":"stdio","command":""}');
        await panel.getByRole("button", { name: "MCP 설정 저장", exact: true }).click();
        await expect(panel.getByRole("alert")).toContainText("실행 파일");
        await expect(row).toContainText("revision 2");
        await panel.getByLabel("MCP 설정 JSON", { exact: true }).fill(JSON.stringify(config));
        const keys: string[] = [];
        await page.route(`**/api/v1/mcp/servers/${created.id}`, async (route) => {
            if (route.request().method() !== "PUT") return route.continue();
            keys.push(route.request().headers()["idempotency-key"]!);
            const response = await route.fetch();
            if (keys.length === 1) await route.abort("connectionfailed");
            else await route.fulfill({ response });
        });
        await panel.getByRole("button", { name: "MCP 설정 저장", exact: true }).click();
        await expect(panel.getByRole("group", { name: "MCP 결과 재확인", exact: true })).toBeVisible();
        await expect(panel.getByLabel("MCP 이름", { exact: true })).toBeDisabled();
        await panel.getByRole("button", { name: "같은 MCP 요청 확인", exact: true }).click();
        await expect(panel.getByRole("group", { name: "MCP 결과 재확인", exact: true })).toHaveCount(0);
        await expect(row).toContainText("revision 3");
        expect(keys).toHaveLength(2);
        expect(keys[0]).toBe(keys[1]);
    } finally {
        const list = await apiCall<Server[]>("GET", "/mcp/servers");
        for (const s of list.filter((s) => s.id === created.id)) await apiCall("DELETE", `/mcp/servers/${s.id}?expected_revision=${s.revision}`);
    }
});

test("MCP 연결 검사는 실행 확인·handshake·도구 목록·연결 정리를 표시하고 응답 유실을 재실행하지 않는다", async ({ page }) => {
    const calls: string[] = [];
    let reject = false;
    const remote = createServer(async (request, response) => {
        if (request.method === "DELETE") {
            calls.push("DELETE");
            response.end();
            return;
        }
        let text = "";
        for await (const chunk of request) text += chunk.toString();
        const message = JSON.parse(text) as { id?: number; method: string };
        calls.push(message.method);
        if (reject) { response.writeHead(401); response.end("fixture-private-mcp-check"); return; }
        if (message.method === "notifications/initialized") { response.writeHead(202); response.end(); return; }
        response.setHeader("content-type", "application/json");
        response.setHeader("mcp-session-id", "fixture-ui-session");
        response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: message.method === "initialize"
            ? { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" } }
            : { tools: [{ name: "read", description: "fixture-private-mcp-check", inputSchema: { type: "object" } }] } }));
    });
    await new Promise<void>((resolve) => remote.listen(0, "127.0.0.1", resolve));
    const address = remote.address();
    if (!address || typeof address === "string") throw new Error("fixture address missing");
    const name = `mcp-check-${Date.now()}`;
    const secret = await apiCall<{ id: string }>("POST", "/secrets", { label: name, value: "fixture-private-mcp-check" });
    const server = await apiCall<Server>("POST", "/mcp/servers", {
        name, config: { transport: "http", endpoint: `http://127.0.0.1:${address.port}/mcp`, header_secrets: { Authorization: secret.id } },
    });
    try {
        await login(page);
        await page.getByRole("button", { name: "설정", exact: true }).click();
        await page.getByLabel("설정 검색", { exact: true }).fill("MCP");
        const panel = page.getByTestId("mcp-panel");
        const row = panel.getByTestId("mcp-row").filter({ hasText: name });
        await row.getByRole("button", { name: "MCP 연결 확인 준비", exact: true }).click();
        await expect(panel.getByRole("group", { name: "MCP 실행·외부 연결 확인", exact: true })).toContainText("외부 서버");
        await panel.getByRole("button", { name: "MCP 검사 취소", exact: true }).click();
        expect(calls).toEqual([]);
        const keys: string[] = [];
        await page.route(`**/api/v1/mcp/servers/${server.id}/check`, async (route) => {
            if (route.request().method() !== "POST") return route.continue();
            keys.push(route.request().headers()["idempotency-key"]!);
            const response = await route.fetch();
            if (keys.length === 1) await route.abort("connectionfailed");
            else await route.fulfill({ response });
        });
        await row.getByRole("button", { name: "MCP 연결 확인 준비", exact: true }).click();
        await panel.getByRole("button", { name: "확인하고 MCP 연결 검사", exact: true }).click();
        await expect(panel.getByRole("group", { name: "MCP 결과 재확인", exact: true })).toBeVisible();
        await panel.getByRole("button", { name: "같은 MCP 요청 확인", exact: true }).click();
        await expect(row).toContainText("성공 · 확인 후 연결 닫힘");
        await expect(row).toContainText("도구 1개");
        expect(keys).toHaveLength(2);
        expect(keys[0]).toBe(keys[1]);
        expect(calls).toEqual(["initialize", "notifications/initialized", "tools/list", "DELETE"]);
        await row.getByRole("button", { name: "MCP 확인 상세", exact: true }).click();
        await expect(panel.getByRole("group", { name: "MCP 확인 상세", exact: true })).toContainText(`${name}/read`);
        await expect(panel).not.toContainText("fixture-private-mcp-check");
        reject = true;
        await row.getByRole("button", { name: "MCP 연결 확인 준비", exact: true }).click();
        await panel.getByRole("button", { name: "확인하고 MCP 연결 검사", exact: true }).click();
        await expect(row).toContainText("실패");
        await expect(row).toContainText("인증이 필요");
        await expect(panel.getByRole("group", { name: "MCP 확인 상세", exact: true })).toContainText('"status": "failed"');
        await expect(panel.getByRole("group", { name: "MCP 확인 상세", exact: true })).not.toContainText(`${name}/read`);
        await expect(panel).not.toContainText("fixture-private-mcp-check");
    } finally {
        remote.closeAllConnections();
        await new Promise<void>((resolve, reject) => remote.close((error) => error ? reject(error) : resolve()));
        const list = await apiCall<Server[]>("GET", "/mcp/servers");
        for (const s of list.filter((s) => s.id === server.id)) await apiCall("DELETE", `/mcp/servers/${s.id}?expected_revision=${s.revision}`);
        await apiCall("DELETE", `/secrets/${secret.id}`);
    }
});

test("MCP 외부 호출은 인자 원문을 가리고 namespace·대상을 확인한 이번만 승인 뒤에 실행하며 거부는 전달하지 않는다", async ({ page }) => {
    let invocations = 0;
    const remote = createServer(async (request, response) => {
        if (request.method === "DELETE") { response.end(); return; }
        let text = "";
        for await (const chunk of request) text += chunk.toString();
        const message = JSON.parse(text) as { id?: number; method: string };
        if (message.method === "notifications/initialized") { response.writeHead(202); response.end(); return; }
        response.setHeader("content-type", "application/json");
        let result: unknown;
        if (message.method === "initialize") result = { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" } };
        else if (message.method === "tools/list") result = { tools: [{ name: "echo", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } }] };
        else { invocations++; result = { content: [{ type: "text", text: "mcp-ui-result" }] }; }
        response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
    });
    await new Promise<void>((resolve) => remote.listen(0, "127.0.0.1", resolve));
    const address = remote.address();
    if (!address || typeof address === "string") throw new Error("fixture address missing");
    const name = `mcp-exec-${Date.now()}`;
    const server = await apiCall<Server>("POST", "/mcp/servers", {
        name, enabled: true, config: { transport: "http", endpoint: `http://127.0.0.1:${address.port}/mcp` },
    });
    try {
        await apiCall("POST", `/mcp/servers/${server.id}/check`, { expected_revision: 1, confirmed: true });
        const { a } = await ensureProjects();
        const session = await apiCall<{ id: string }>("POST", `/projects/${a.id}/sessions`, { title: name });
        await apiCall("POST", "/recent/touch", { kind: "session", project_id: a.id, resource_id: session.id });
        await login(page);
        await page.getByRole("region", { name: "최근", exact: true }).getByRole("button", { name: new RegExp(name) }).click();
        const view = sessionView(page, session.id);
        const body = { name: "mcp_call", args: { server_id: server.id, tool: `${name}/echo`, arguments: { message: "approved-argument" } } };
        await apiCall("POST", `/sessions/${session.id}/tool-requests`, body);
        const approval = view.getByTestId("approval");
        await expect(approval.getByTestId("approval-target")).toContainText(`${name}/echo`);
        await expect(approval).not.toContainText("approved-argument");
        await expect(approval.getByTestId("approval-target")).toContainText(`http://127.0.0.1:${address.port}/mcp`);
        await expect(approval.getByRole("button", { name: "이 대화에서 계속 허용", exact: true })).toHaveCount(0);
        expect(invocations).toBe(0);
        await approval.getByRole("button", { name: "거부", exact: true }).click();
        await expect(approval).toHaveCount(0);
        expect(invocations).toBe(0);
        const call = await apiCall<{ id: string }>("POST", `/sessions/${session.id}/tool-requests`, body);
        await expect(approval).toContainText(`${name}/echo`);
        await approval.getByRole("button", { name: "이번만 승인", exact: true }).click();
        await expect.poll(() => invocations).toBe(1);
        await expect.poll(async () => (await apiCall<{ status: string }>("GET", `/tool-calls/${call.id}`)).status).toBe("succeeded");
        expect(invocations).toBe(1);
    } finally {
        remote.closeAllConnections();
        await new Promise<void>((resolve, reject) => remote.close((error) => error ? reject(error) : resolve()));
        const list = await apiCall<Server[]>("GET", "/mcp/servers");
        for (const s of list.filter((s) => s.id === server.id)) await apiCall("DELETE", `/mcp/servers/${s.id}?expected_revision=${s.revision}`);
    }
});

test("MCP 진행은 새로고침 뒤 복원되고 중지 뒤에는 서버 종료가 아닌 결과 불명 원인을 보여준다",async({page})=>{
    let invocations=0;
    const remote=createServer(async(request,response)=>{
        if (request.method==="DELETE") { response.end();return; }
        let text="";
        for await (const chunk of request) text+=chunk.toString();
        const q=JSON.parse(text) as {id?:number;method:string;params?:{_meta?:{progressToken?:string}}};
        if (q.method==="notifications/initialized" || q.method==="notifications/cancelled") { response.writeHead(202);response.end();return; }
        if (q.method==="tools/call") {
            invocations++;
            response.setHeader("content-type","text/event-stream");
            const token=q.params?._meta?.progressToken;
            for (const [progressToken,progress] of [["wrong-token",99],[token,50],[token,40]] as const) {
                response.write(`data: ${JSON.stringify({jsonrpc:"2.0",method:"notifications/progress",params:{progressToken,progress,total:100,message:"DO-NOT-STORE-PROGRESS-TEXT"}})}\n\n`);
            }
            return;
        }
        response.setHeader("content-type","application/json");
        response.end(JSON.stringify({jsonrpc:"2.0",id:q.id,result:q.method==="initialize"
            ? {protocolVersion:"2025-06-18",capabilities:{tools:{}},serverInfo:{name:"fixture",version:"1"}}
            : {tools:[{name:"long_job",inputSchema:{type:"object"}}]}}));
    });
    await new Promise<void>((resolve)=>remote.listen(0,"127.0.0.1",resolve));
    const address=remote.address();
    if (!address || typeof address==="string") throw new Error("fixture address missing");
    const name=`mcp-progress-${Date.now()}`;
    const server=await apiCall<Server>("POST","/mcp/servers",{
        name,enabled:true,timeout_secs:30,config:{transport:"http",endpoint:`http://127.0.0.1:${address.port}/mcp`},
    });
    try {
        await apiCall("POST",`/mcp/servers/${server.id}/check`,{expected_revision:1,confirmed:true});
        const {a}=await ensureProjects();
        const session=await apiCall<{id:string}>("POST",`/projects/${a.id}/sessions`,{title:name});
        await apiCall("POST","/recent/touch",{kind:"session",project_id:a.id,resource_id:session.id});
        await login(page);
        await page.getByRole("region", { name: "최근", exact: true }).getByRole("button",{name:new RegExp(name)}).click();
        const view=sessionView(page,session.id);
        const call=await apiCall<{id:string}>("POST",`/sessions/${session.id}/tool-requests`,{
            name:"mcp_call",args:{server_id:server.id,tool:`${name}/long_job`,arguments:{}},
        });
        await view.getByTestId("approval").getByRole("button",{name:"이번만 승인",exact:true}).click();
        await expect(view.getByTestId("mcp-running")).toContainText("50 / 100");
        await expect(view).not.toContainText("DO-NOT-STORE-PROGRESS-TEXT");
        await page.getByRole("banner").getByRole("button",{name:"설정",exact:true}).click();
        await page.getByLabel("설정 검색",{exact:true}).fill("MCP");
        const row=page.getByTestId("mcp-row").filter({hasText:name});
        await expect(row).toContainText("호출 1개 실행 중");
        await expect(row.getByRole("button",{name:"MCP 편집",exact:true})).toBeDisabled();
        await page.getByRole("region", { name: "최근", exact: true }).getByRole("button",{name:new RegExp(name)}).click();
        await page.reload();
        await expect(page.getByTestId("conn")).toHaveText("연결됨");
        await page.getByRole("region", { name: "최근", exact: true }).getByRole("button",{name:new RegExp(name)}).click();
        await expect(view.getByTestId("mcp-running")).toContainText("50 / 100");
        await view.getByTestId("mcp-running").getByRole("button",{name:"MCP 호출 중지",exact:true}).click();
        await expect(view.getByTestId("mcp-running")).toHaveCount(0);
        await expect(view.getByTestId("unknown")).toContainText("cancelled");
        await expect(view.getByTestId("unknown")).not.toContainText("서버가 종료됨");
        expect((await apiCall<{status:string}>("GET",`/tool-calls/${call.id}`)).status).toBe("unknown");
        expect(invocations).toBe(1);
        await page.getByRole("banner").getByRole("button",{name:"설정",exact:true}).click();
        await page.getByLabel("설정 검색",{exact:true}).fill("MCP");
        await expect(row).toContainText("미연결");
    } finally {
        remote.closeAllConnections();
        await new Promise<void>((resolve,reject)=>remote.close((error)=>error?reject(error):resolve()));
        const list=await apiCall<Server[]>("GET","/mcp/servers");
        for (const s of list.filter((s)=>s.id===server.id)) await apiCall("DELETE",`/mcp/servers/${s.id}?expected_revision=${s.revision}`);
    }
});
