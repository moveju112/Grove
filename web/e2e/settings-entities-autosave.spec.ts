import { expect, test } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { apiCall, login, openSettings, selectChoice, state } from "./helpers";

type Bot = { id: string; name: string; description: string; persona: string; featured: boolean; revision: number };
async function bot(id: string) {
    return (await apiCall<{ bots: Bot[] }>("GET", "/bots")).bots.find((bot) => bot.id === id)!;
}

test("기존 봇의 입력·선택은 편집기를 닫지 않고 자동 저장한다", async ({ page }) => {
    const name = `autosave-bot-${Date.now()}`;
    const project = await apiCall<{ id: string }>("POST", "/projects", { root_path: mkdtempSync(join(state().projA, "bot-autosave-")) });
    const created = await apiCall<Bot>("POST", "/bots", {
        name, description: "", persona: "", instructions: "", profile_id: null, project_id: project.id, featured: false,
    });
    try {
        await login(page);
        await openSettings(page);
        await page.getByLabel("설정 검색").fill("봇");
        const panel = page.getByTestId("bots-panel");
        const row = panel.getByTestId("bot").filter({ hasText: name });
        await row.getByRole("button", { name: `${name} 관리`, exact: true }).click();
        await page.getByRole("group", { name: `${name} 관리`, exact: true }).getByRole("button", { name: "편집", exact: true }).click();
        const editor = panel.getByTestId("bot-editor");
        const description = editor.getByLabel("봇 설명", { exact: true });
        await description.fill("changed description");
        expect((await bot(created.id)).description).toBe("");
        await description.blur();
        await expect(editor).toContainText("저장됨");
        await expect(description).toHaveValue("changed description");
        expect((await bot(created.id)).description).toBe("changed description");
        await selectChoice(editor.getByLabel("대표 봇", { exact: true }), "true");
        await expect.poll(async () => (await bot(created.id)).featured).toBe(true);
        await expect(editor.getByRole("button", { name: "저장", exact: true })).toHaveCount(0);
        await editor.getByLabel("persona", { exact: true }).fill("saved on close");
        await editor.getByRole("button", { name: "닫기", exact: true }).click();
        await expect.poll(async () => (await bot(created.id)).persona).toBe("saved on close");
    } finally {
        const current = await bot(created.id);
        await apiCall("POST", `/bots/${created.id}/status`, { expected_revision: current.revision, action: "delete" });
    }
});

test("클라이언트 이름은 blur 때 한 번 저장하고 새로고침 뒤에도 유지한다", async ({ page }) => {
    await login(page);
    await openSettings(page, "local");
    await page.getByLabel("설정 검색").fill("클라이언트 이름");
    const row = page.getByTestId("setting-device-name");
    const input = row.getByLabel("이 기기 이름", { exact: true });
    await expect(input).toBeVisible();
    let writes = 0;
    page.on("request", (request) => {
        if (request.method() === "PUT" && new URL(request.url()).pathname === "/api/v1/auth/device") writes++;
    });
    await input.fill("autosave client");
    expect(writes).toBe(0);
    await input.blur();
    await expect(row).toContainText("저장됨");
    await input.focus(); await input.blur();
    expect(writes).toBe(1);
    await expect(row.getByRole("button", { name: /저장/ })).toHaveCount(0);
    await page.reload();
    await openSettings(page, "local");
    await page.getByLabel("설정 검색").fill("클라이언트 이름");
    await expect(input).toHaveValue("autosave client");
});

test("새 봇은 입력·blur만으로 만들지 않고 명시적인 생성 요청 한 번만 보낸다", async ({ page }) => {
    const name = `new-bot-${Date.now()}`;
    const project = await apiCall<{ id: string }>("POST", "/projects", { root_path: mkdtempSync(join(state().projA, "new-bot-autosave-")) });
    await login(page);
    await openSettings(page);
    await page.getByLabel("설정 검색").fill("봇");
    const panel = page.getByTestId("bots-panel");
    await panel.getByRole("button", { name: "봇 작업", exact: true }).click();
    await panel.getByRole("button", { name: "봇 만들기", exact: true }).click();
    const editor = panel.getByTestId("bot-editor");
    const requests: { project_id: string; name: string }[] = [];
    page.on("request", (request) => {
        if (request.method() === "POST" && new URL(request.url()).pathname === "/api/v1/bots") requests.push(request.postDataJSON());
    });
    await editor.getByLabel("봇 이름", { exact: true }).fill(name);
    await editor.getByLabel("봇 이름", { exact: true }).blur();
    await selectChoice(editor.getByLabel("봇 프로젝트", { exact: true }), project.id);
    expect(requests).toHaveLength(0);
    await editor.getByRole("button", { name: "봇 만들기", exact: true }).click();
    await expect(panel.getByTestId("bot").filter({ hasText: name })).toBeVisible();
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ name, project_id: project.id });
    const created = (await apiCall<{ bots: Bot[] }>("GET", "/bots")).bots.find((bot) => bot.name === name)!;
    await apiCall("POST", `/bots/${created.id}/status`, { expected_revision: created.revision, action: "delete" });
});
