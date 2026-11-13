import { expect, test, type Page } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { apiCall, ensureProfile, login, openDetails, script, sessionView, state } from "./helpers";
import { frames } from "./fixture";

type Run = { id: string; status: string; child_session_id: string; last_turn_id: string; result: string | null };
type Turn = { status: string; tool_calls: { status: string; result: { error?: { code: string } } }[]; definition: { agents_available: { id: string }[] } };

async function setup(settings: Page, chat: Page) {
    await ensureProfile();
    const root = mkdtempSync(join(state().projA, "agent-policy-"));
    const project = await apiCall<{ id: string; name: string }>("POST", "/projects", { root_path: root });
    const session = await apiCall<{ id: string; title: string }>("POST", `/projects/${project.id}/sessions`, { title: `역할 정책 ${project.id}` });
    await apiCall("POST", "/recent/touch", { kind: "session", project_id: project.id, resource_id: session.id });
    await login(settings);
    await settings.getByTestId("project-row").getByRole("button", { name: project.name, exact: true }).click();
    await settings.getByRole("button", { name: "프로젝트 설정", exact: true }).click();
    await save(settings, "agents.allowed_roles", "위임 허용 역할", "reviewer");
    await login(chat);
    await chat.locator(".recent").getByRole("button", { name: new RegExp(session.title) }).click();
    const view = sessionView(chat, session.id);
    await view.getByLabel("보내기 방식").selectOption("model");
    await view.getByLabel("도구", { exact: true }).check();
    return { project, session, view };
}

async function save(page: Page, key: string, label: string, value: string) {
    await page.getByLabel("설정 검색", { exact: true }).fill(label);
    const row = page.getByTestId(`setting-${key}`);
    const control = row.getByLabel(label, { exact: true });
    if (key === "agents.allowed_roles") await control.fill(value);
    else await control.selectOption(value);
    await row.getByRole("button", { name: "저장", exact: true }).click();
    await expect(row).toContainText("저장됨 · 즉시 적용");
    return row;
}

async function modelTool(session: string, action: unknown, final: string) {
    const prompt = `${final} ${session}`;
    await script({ frames: frames.tool(`call-${Date.now()}`, "agent", action), marker: prompt });
    await script({ frames: frames.text([final]), marker: prompt });
    return prompt;
}

async function latestTurn(session: string): Promise<Turn> {
    const turns = await apiCall<{ id: string }[]>("GET", `/sessions/${session}/turns`);
    return apiCall<Turn>("GET", `/turns/${turns[0]!.id}`);
}

test("설정한 역할만 안내·실행하고 승인 응답 유실 뒤에도 결과를 한 번만 보존한다", async ({ page, browser }) => {
    const chat = await browser.newPage();
    try {
        const { session, view } = await setup(page, chat);
        const deniedPrompt = await modelTool(session.id, { action: "spawn", agent_id: "worker", brief: "금지된 역할" }, "역할 거부 확인");
        await view.getByLabel("메시지 입력").fill(deniedPrompt);
        await view.getByRole("button", { name: "보내기", exact: true }).click();
        await expect.poll(async () => (await latestTurn(session.id)).status).toBe("completed");
        const denied = await latestTurn(session.id);
        expect(denied.tool_calls[0]!.result.error?.code).toBe("delegation_disabled");
        expect(denied.definition.agents_available.map((d) => d.id)).toEqual(["reviewer"]);
        expect((await apiCall<{ runs: Run[] }>("GET", `/sessions/${session.id}/agent-runs`)).runs).toHaveLength(0);
        await expect(view.getByTestId("approval")).toHaveCount(0);

        const prompt = await modelTool(session.id, { action: "spawn", agent_id: "reviewer", brief: "허용된 역할" }, "위임 접수");
        await script({ frames: frames.text(["결과 확인"]), marker: prompt });
        await script({ frames: frames.text(["보존할 검토 결과"]), marker: "Delegated task" });
        await view.getByLabel("메시지 입력").fill(prompt);
        await view.getByRole("button", { name: "보내기", exact: true }).click();
        const approval = view.getByTestId("approval");
        await expect(approval).toContainText("reviewer");
        await expect(approval.getByRole("button", { name: "이 대화에서 계속 허용" })).toHaveCount(0);
        const requests: { key: string; body: unknown }[] = [];
        await chat.route("**/api/v1/tool-calls/*/decision", async (route) => {
            requests.push({ key: route.request().headers()["idempotency-key"]!, body: route.request().postDataJSON() });
            if (requests.length === 1) {
                await route.fetch();
                await route.abort("failed");
            } else await route.continue();
        });
        await approval.getByRole("button", { name: "이번만 승인" }).click();
        await expect(view.getByTestId("msg-agent-result")).toHaveCount(1);
        await expect(view.getByTestId("msg-agent-result")).toContainText("보존할 검토 결과");
        const list = (await apiCall<{ runs: Run[] }>("GET", `/sessions/${session.id}/agent-runs`)).runs;
        expect(list).toHaveLength(1);
        expect(list[0]!.status).toBe("completed");
        // 결과 카드가 SSE로 확정되면 유실된 승인 응답 때문에 새 자식을 만들지 않는다.
        expect(requests).toHaveLength(1);
        await save(page, "agents.allowed_roles", "위임 허용 역할", "worker");
        const followup = await modelTool(session.id, { action: "send", run_id: list[0]!.id, brief: "금지된 후속 지시" }, "후속 거부 확인");
        await view.getByLabel("메시지 입력").fill(followup);
        await view.getByRole("button", { name: "보내기", exact: true }).click();
        await expect.poll(async () => (await latestTurn(session.id)).status).toBe("completed");
        expect((await latestTurn(session.id)).tool_calls[0]!.result.error?.code).toBe("delegation_disabled");
        const after = (await apiCall<{ runs: Run[] }>("GET", `/sessions/${session.id}/agent-runs`)).runs;
        expect(after).toEqual(list);
        await openDetails(view.getByTestId("agent-runs").locator("details"));
        await expect(view.getByTestId("agent-run")).toHaveAttribute("data-status", "completed");
        await view.getByTestId("agent-runs").getByRole("button", { name: "자식 대화", exact: true }).click();
        await expect(sessionView(chat, list[0]!.child_session_id).getByTestId("msg-assistant").last()).toContainText("보존할 검토 결과");
    } finally {
        await chat.close();
    }
});

test("승인 대기 중 철회를 실행 직전에 검사하고 solo 전환 뒤에도 기존 작업을 관측·취소한다", async ({ page, browser }) => {
    const chat = await browser.newPage();
    try {
        const { session, view } = await setup(page, chat);
        const prompt = await modelTool(session.id, { action: "spawn", agent_id: "reviewer", brief: "승인 대기 철회" }, "철회 확인");
        await view.getByLabel("메시지 입력").fill(prompt);
        await view.getByRole("button", { name: "보내기", exact: true }).click();
        const approval = view.getByTestId("approval");
        await expect(approval).toContainText("reviewer");
        await save(page, "agents.allowed_roles", "위임 허용 역할", "");
        await approval.getByRole("button", { name: "이번만 승인" }).click();
        await expect.poll(async () => (await latestTurn(session.id)).status).toBe("completed");
        expect((await latestTurn(session.id)).tool_calls[0]!.result.error?.code).toBe("delegation_disabled");
        expect((await apiCall<{ runs: Run[] }>("GET", `/sessions/${session.id}/agent-runs`)).runs).toHaveLength(0);

        await save(page, "agents.allowed_roles", "위임 허용 역할", "reviewer");
        await save(page, "agents.delegation", "자식 에이전트 위임", "auto");
        const start = await modelTool(session.id, { action: "spawn", agent_id: "reviewer", brief: "실행 중 solo" }, "실행 접수");
        await script({ frames: frames.text(["취소 결과 확인"]), marker: start });
        await script({ frames: frames.text(["작업 진행 중"]).slice(0, 1), hang: true, marker: "Delegated task" });
        await view.getByLabel("메시지 입력").fill(start);
        await view.getByRole("button", { name: "보내기", exact: true }).click();
        const run = view.getByTestId("agent-run");
        await expect(run).toHaveAttribute("data-status", "running");
        await save(page, "agents.orchestration", "에이전트 실행 방식", "solo");
        await openDetails(view.getByTestId("agent-runs").locator("details"));
        await run.getByRole("button", { name: "취소", exact: true }).click();
        await expect(run).toHaveAttribute("data-status", "cancelled");
        await expect(view.getByTestId("msg-agent-result")).toHaveCount(1);
        await chat.reload();
        await expect(sessionView(chat, session.id).getByTestId("agent-run")).toHaveAttribute("data-status", "cancelled");
        const noSpawn = await modelTool(session.id, { action: "spawn", agent_id: "reviewer", brief: "solo 거부" }, "solo 거부 확인");
        const reloaded = sessionView(chat, session.id);
        await reloaded.getByLabel("메시지 입력").fill(noSpawn);
        await reloaded.getByRole("button", { name: "보내기", exact: true }).click();
        await expect.poll(async () => (await latestTurn(session.id)).status).toBe("completed");
        expect((await latestTurn(session.id)).definition.agents_available).toEqual([]);
        expect((await apiCall<{ runs: Run[] }>("GET", `/sessions/${session.id}/agent-runs`)).runs).toHaveLength(1);
    } finally {
        await chat.close();
    }
});
