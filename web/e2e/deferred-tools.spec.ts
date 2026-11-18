import { expect, test, type Page } from "@playwright/test";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { frames } from "./fixture";
import { apiCall, composerCommand, composerOption, ensureProjects, login, requireToolApproval, sessionView } from "./helpers";

type Request = {
    tools?: { function: { name: string; parameters: unknown; description: string } }[];
    messages: { role: string; tool_call_id?: string; content?: string; tool_calls?: { id: string }[] }[];
};
type Call = { id: string; name: string; provider_call_id: string; status: string; result: unknown };
type Turn = { status: string; tool_calls: Call[] };

async function setup(page: Page) {
    const requests: Request[] = [];
    const replies: string[][] = [];
    const fixture = createServer((req, res) => {
        if (req.method === "GET" && req.url === "/v1/models") {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ data: [{ id: "local-fixture" }] }));
            return;
        }
        let body = "";
        req.on("data", (chunk) => { body += chunk; });
        req.on("end", () => {
            requests.push(JSON.parse(body) as Request);
            const reply = replies.shift();
            if (!reply) {
                res.writeHead(400);
                res.end("unexpected local fixture request");
                return;
            }
            res.writeHead(200, { "content-type": "text/event-stream" });
            res.end(reply.map((frame) => `data: ${frame}\n\n`).join(""));
        });
    });
    await new Promise<void>((resolve) => fixture.listen(0, "127.0.0.1", resolve));
    const address = fixture.address();
    if (!address || typeof address === "string") throw new Error("local fixture address");
    const title = `CTX-013-${randomUUID()}`;
    const profile = await apiCall<{ id: string }>("POST", "/model-profiles", {
        name: title, protocol: "openai", base_url: `http://127.0.0.1:${address.port}/v1`, model: "local-fixture",
    });
    const { a } = await ensureProjects();
    await requireToolApproval(a.id);
    const projects = await apiCall<{ id: string; root_path: string }[]>("GET", "/projects");
    const root = projects.find((p) => p.id === a.id)!.root_path;
    const session = await apiCall<{ id: string }>("POST", `/projects/${a.id}/sessions`, { title });
    await apiCall("POST", "/recent/touch", { kind: "session", project_id: a.id, resource_id: session.id });
    await login(page);
    await page.getByRole("region", { name: "최근", exact: true }).getByRole("button", { name: title }).click();
    const view = sessionView(page, session.id);
    await composerOption(view, "보내기 방식", "model");
    await composerCommand(view, `/model ${title}`);
    await composerOption(view, "추론", "auto");
    await composerOption(view, "도구", true);
    return {
        requests, replies, session, view, root,
        request: (index: number) => requests[index]!,
        send: async (text: string) => {
            await view.getByLabel("메시지 입력").fill(text);
            await view.getByRole("button", { name: "보내기", exact: true }).click();
        },
        turn: async () => {
            const turns = await apiCall<{ id: string }[]>("GET", `/sessions/${session.id}/turns`);
            return apiCall<Turn>("GET", `/turns/${turns[0]!.id}`);
        },
        close: async () => {
            await apiCall("DELETE", `/model-profiles/${profile.id}`);
            await new Promise<void>((resolve, reject) => fixture.close((error) => error ? reject(error) : resolve()));
        },
    };
}

test("제한된 첫 schema에서 로딩·다음 요청·실제 승인·결과 표시까지 연결하고 새로고침은 재실행하지 않는다", async ({ page }) => {
    const flow = await setup(page);
    const file = `deferred-${flow.session.id}.txt`;
    const path = join(flow.root, file);
    try {
        flow.replies.push(
            frames.tool("load-first", "load_tool", { names: ["write", "list", "write"] }),
            frames.tool("write-approved", "write", { path: file, content: "CTX-013 approved once" }),
            frames.tool("load-again", "load_tool", { names: ["list", "write"] }),
            frames.text(["CTX-013 승인 결과를 확인했어"]),
        );
        await flow.send("파일 schema를 로딩한 뒤 승인을 받고 파일을 만들어");
        const approval = flow.view.getByTestId("approval");
        await expect(approval).toBeVisible();
        expect(flow.requests).toHaveLength(2);
        expect(flow.request(0).tools!.map((t) => t.function.name)).toEqual(["edit", "load_tool", "read"]);
        expect(flow.request(0).tools!.find((t) => t.function.name === "load_tool")!.function.description).toContain("write:");
        expect(flow.request(0).tools!.some((t) => t.function.name === "write")).toBe(false);
        expect(flow.request(1).tools!.map((t) => t.function.name)).toEqual(["edit", "list", "load_tool", "read", "write"]);
        const registry = await apiCall<{ name: string; schema: unknown }[]>("GET", "/tools");
        expect(flow.request(1).tools!.find((t) => t.function.name === "write")!.function.parameters)
            .toEqual(registry.find((t) => t.name === "write")!.schema);
        const receipt = flow.request(1).messages.find((m) => m.role === "tool" && m.tool_call_id === "load-first")!;
        expect(JSON.parse(receipt.content!).selected).toEqual(["list", "write"]);
        expect(JSON.parse(receipt.content!).executed).toBe(false);
        expect(existsSync(path)).toBe(false);
        await expect(approval.getByTestId("approval-target")).toContainText(file);
        await approval.getByRole("button", { name: "이번만 승인", exact: true }).click();
        await expect(flow.view.getByTestId("msg-assistant").last()).toContainText("CTX-013 승인 결과를 확인했어");
        expect(readFileSync(path, "utf8")).toBe("CTX-013 approved once");
        expect(flow.requests).toHaveLength(4);
        expect(flow.request(3).tools).toEqual(flow.request(1).tools);
        for (const [index, id] of [[1, "load-first"], [2, "write-approved"], [3, "load-again"]] as const) {
            expect(flow.request(index).messages.filter((m) => m.role === "tool" && m.tool_call_id === id)).toHaveLength(1);
            expect(flow.request(index).messages.some((m) => m.tool_calls?.some((c) => c.id === id))).toBe(true);
        }
        expect(JSON.stringify((await flow.turn()).tool_calls.find((call) => call.name === "write")!.result)).toContain(file);
        await expect(flow.view.getByTestId("msg-tool")).toHaveCount(0);
        writeFileSync(path, "reload must not replay");
        await page.reload();
        await expect(sessionView(page, flow.session.id).getByTestId("msg-assistant").last()).toContainText("CTX-013 승인 결과를 확인했어");
        expect(readFileSync(path, "utf8")).toBe("reload must not replay");
        expect(flow.requests).toHaveLength(4);
        expect((await flow.turn()).tool_calls.map((c) => c.status)).toEqual(["succeeded", "succeeded", "succeeded"]);
    } finally {
        await flow.close();
    }
});

test("읽기 전용에서 금지된 schema는 명시적으로 실패하고 tools=false는 목록도 보내지 않는다", async ({ page }) => {
    const flow = await setup(page);
    try {
        await apiCall("PUT", `/settings/session/${flow.session.id}/tools.mode`, { expected_revision: 0, value: "read_only" });
        flow.replies.push(
            frames.tool("forbidden-load", "load_tool", { names: ["write"] }),
            frames.text(["CTX-013 읽기 전용 유지"]),
        );
        await flow.send("읽기 전용 schema 로딩 거부를 확인해");
        await expect(flow.view.getByTestId("msg-assistant").last()).toContainText("CTX-013 읽기 전용 유지");
        const first = flow.request(0);
        expect(first.tools!.some((t) => t.function.name === "edit")).toBe(false);
        expect(first.tools!.find((t) => t.function.name === "load_tool")!.function.description).not.toContain("write:");
        const failure = (await flow.turn()).tool_calls[0]!;
        expect(failure.status).toBe("failed");
        expect(JSON.stringify(failure.result)).toContain("read_only");
        await expect(flow.view.getByTestId("msg-tool")).toHaveCount(0);
        await expect(flow.view.getByTestId("approval")).toHaveCount(0);
        await composerOption(flow.view, "도구", false);
        flow.replies.push(frames.text(["CTX-013 tools off"]));
        await flow.send("도구 없이 답해");
        await expect(flow.view.getByTestId("msg-assistant").last()).toContainText("CTX-013 tools off");
        expect(flow.requests).toHaveLength(3);
        expect(flow.request(2).tools).toBeUndefined();
    } finally {
        await flow.close();
    }
});

test("schema 로딩 뒤 승인 대기에서 취소하면 재접속해도 파일을 만들지 않는다", async ({ page }) => {
    const flow = await setup(page);
    const file = `cancel-deferred-${flow.session.id}.txt`;
    try {
        flow.replies.push(
            frames.tool("load-cancel", "load_tool", { names: ["write"] }),
            frames.tool("cancel-write", "write", { path: file, content: "must not exist" }),
        );
        await flow.send("schema만 로딩하고 승인 대기해");
        await expect(flow.view.getByTestId("approval")).toBeVisible();
        expect(flow.requests).toHaveLength(2);
        page.once("dialog", (dialog) => dialog.accept());
        await flow.view.getByRole("button", { name: "취소", exact: true }).click();
        await expect.poll(async () => (await flow.turn()).status).toBe("cancelled");
        await page.reload();
        await expect(sessionView(page, flow.session.id).getByTestId("approval")).toHaveCount(0);
        expect(existsSync(join(flow.root, file))).toBe(false);
        expect((await flow.turn()).tool_calls.map((c) => c.status)).toEqual(["succeeded", "cancelled"]);
        expect(flow.requests).toHaveLength(2);
    } finally {
        await flow.close();
    }
});
