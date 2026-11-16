import { expect, test } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { dirname, join } from "node:path";
import { apiCall, ensureProfile, login, script, selectChoice, sessionView, state } from "./helpers";
import { frames } from "./fixture";

type Call = { status: string; result: { total?: number; scope?: string; items?: { id: string }[]; error?: { code: string } } };
type Turn = { status: string; tool_calls: Call[] };

test("모델의 무관한 대화 조회는 기본 차단되고 대화 범위 허용·철회를 화면에서 즉시 적용한다", async ({ page }) => {
    const word = `session-access-${Date.now()}`;
    const model = await ensureProfile();
    const project = await apiCall<{ id: string }>("POST", "/projects", {
        root_path: mkdtempSync(join(dirname(state().projA), "session-access-")),
    });
    const foreign = await apiCall<{ id: string }>("POST", `/projects/${project.id}/sessions`, { title: `${word} source` });
    await apiCall("POST", `/sessions/${foreign.id}/messages`, { text: `${word} PRIVATE_FOREIGN_EVIDENCE` });
    const work = await apiCall<{ id: string }>("POST", `/projects/${project.id}/sessions`, { title: `${word} work` });
    const lookup = async (all: boolean) => {
        await script({ frames: frames.tool("access-recall", "recall", { q: word, ...(all ? { scope: "all" } : {}) }) });
        await script({ frames: frames.text(["lookup completed"]) });
        const accepted = await apiCall<{ turn: { id: string } }>("POST", `/sessions/${work.id}/turns`, { text: "Look up permitted earlier evidence.", profile_id: model, tools: true });
        await expect.poll(async () => (await apiCall<Turn>("GET", `/turns/${accepted.turn.id}`)).status).toBe("completed");
        return (await apiCall<Turn>("GET", `/turns/${accepted.turn.id}`)).tool_calls[0]!;
    };
    const limited = await lookup(false);
    expect(limited.status).toBe("succeeded");
    expect(limited.result.total).toBe(0);
    expect(limited.result.scope).toBe("current_and_inherited_history");
    await apiCall("POST", "/recent/touch", { kind: "session", project_id: project.id, resource_id: work.id });
    await login(page);
    await page.getByRole("region", { name: "최근", exact: true }).getByRole("button", { name: new RegExp(`${word} work`) }).click();
    await sessionView(page, work.id).getByRole("button", { name: "대화 작업", exact: true }).click();
    await sessionView(page, work.id).getByRole("button", { name: "대화 설정" }).click();
    await page.getByLabel("설정 검색").last().fill("관련 없는 대화");
    const row = page.getByTestId("setting-sessions.allow_unrelated").last();
    const check = row.getByRole("combobox", { name: "모델의 관련 없는 대화 조회 허용", exact: true });
    await expect(check).toHaveAttribute("data-selected-value", "false");
    await expect(row).toContainText("분기 시점까지만");
    await selectChoice(check, "true");
    await expect(row).toContainText("저장됨 · 즉시 적용");
    const allowed = await lookup(true);
    expect(allowed.status).toBe("succeeded");
    expect(allowed.result.total).toBe(1);
    expect(allowed.result.items?.[0]?.id).toBe(foreign.id);
    await selectChoice(check, "false");
    await expect(row).toContainText("저장됨 · 즉시 적용");
    const denied = await lookup(true);
    expect(denied.status).toBe("failed");
    expect(denied.result.error?.code).toBe("unrelated_sessions_disabled");
});
