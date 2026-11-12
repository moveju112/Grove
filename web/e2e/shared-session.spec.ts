import { expect, test, type Page } from "@playwright/test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { frames } from "./fixture";
import { apiCall, ensureProfile, ensureProjects, login, script, state } from "./helpers";

async function shared(page: Page) {
    const { a } = await ensureProjects();
    await ensureProfile();
    const title = `shared-session-${Date.now()}`;
    const s = await apiCall<{ id: string }>("POST", `/projects/${a.id}/sessions`, { title });
    await apiCall("POST", "/recent/touch", { kind: "session", project_id: a.id, resource_id: s.id });
    await login(page);
    await expect(page.locator(".boot")).toHaveCount(0);
    const recent = page.locator(".recent").getByTestId("recent-item").filter({ hasText: title });
    let messageQueries = 0;
    const subscriptions: string[][] = [];
    page.on("request", (r) => {
        const url = new URL(r.url());
        if (r.method() === "GET" && url.pathname === `/api/v1/sessions/${s.id}/messages`) messageQueries++;
        if (url.pathname === "/api/v1/events") subscriptions.push((url.searchParams.get("sessions") ?? "").split(",").filter(Boolean));
    });
    const loaded = page.waitForResponse((r) => new URL(r.url()).pathname === `/api/v1/sessions/${s.id}/messages` && r.request().method() === "GET");
    await recent.getByRole("button", { name: new RegExp(title) }).click();
    await loaded;
    await expect(page.getByTestId("conn")).toHaveText("연결됨");
    const before = messageQueries;
    await recent.getByRole("button", { name: "오른쪽에 열기", exact: true }).click();
    await expect(page.getByTestId("pane")).toHaveCount(2);
    const left = page.getByTestId("pane").nth(0).getByTestId("session-view");
    const right = page.getByTestId("pane").nth(1).getByTestId("session-view");
    await right.getByLabel("메시지 입력").fill("right independent draft fixture");
    expect(messageQueries).toBe(before);
    for (const ids of subscriptions) expect(new Set(ids).size).toBe(ids.length);
    return { project: a, session: s, title, left, right };
}

test("같은 대화의 두 승인 카드가 동시에 눌려도 도구와 모델 실행은 한 번만 이어진다", async ({ page }) => {
    const { project, session, title, left, right } = await shared(page);
    const name = `${title}.txt`;
    const p = await apiCall<{ root_path: string }>("GET", `/projects/${project.id}`);
    const path = join(p.root_path, name);
    writeFileSync(path, "");
    let starts = 0;
    const decisions: number[] = [];
    page.on("request", (r) => { if (r.method() === "POST" && r.url().endsWith(`/sessions/${session.id}/turns`)) starts++; });
    page.on("response", (r) => {
        if (r.request().method() === "POST" && /\/tool-calls\/[^/]+\/decision$/.test(new URL(r.url()).pathname)) decisions.push(r.status());
    });
    try {
        await script({ frames: frames.tool("shared-shell", "shell", { command: `printf 'once\\n' >> '${name}'` }) });
        await left.getByLabel("도구", { exact: true }).check();
        await left.getByLabel("보내기 방식").selectOption("model");
        await left.getByLabel("메시지 입력").fill(title);
        await left.getByRole("button", { name: "보내기", exact: true }).click();
        await expect(left.getByTestId("approval")).toHaveCount(1);
        await expect(right.getByTestId("approval")).toHaveCount(1);
        await script({ frames: frames.text(["shared answer fixture"]) });
        // 같은 revision의 두 실제 UI 요청을 서버로 보내 승인 경합을 재현한다.
        await page.getByTestId("approval").getByRole("button", { name: "이번만 승인", exact: true })
            .evaluateAll((buttons) => buttons.forEach((button) => button.dispatchEvent(new MouseEvent("click", { bubbles: true }))));
        await expect(left.getByTestId("msg-assistant").filter({ hasText: "shared answer fixture" })).toHaveCount(1);
        await expect(right.getByTestId("msg-assistant").filter({ hasText: "shared answer fixture" })).toHaveCount(1);
        await expect(left.getByTestId("approval")).toHaveCount(0);
        await expect(right.getByTestId("approval")).toHaveCount(0);
        await expect(right.getByLabel("메시지 입력")).toHaveValue("right independent draft fixture");
        await expect.poll(() => [...decisions].sort((a, b) => a - b)).toEqual([200, 409]);
        expect(starts).toBe(1);
        expect(readFileSync(path, "utf8")).toBe("once\n");
        const requests = await (await fetch(`http://127.0.0.1:${state().fixturePort}/requests`)).json() as { messages: unknown[] }[];
        expect(requests.filter((r) => JSON.stringify(r.messages).includes(title))).toHaveLength(2);
        await expect.poll(async () => (await apiCall<{ status: string }[]>("GET", `/sessions/${session.id}/turns?limit=1`))[0]?.status).toBe("completed");
    } finally {
        const turns = await apiCall<{ id: string; status: string }[]>("GET", `/sessions/${session.id}/turns?limit=5`);
        for (const turn of turns) if (["queued", "running", "awaiting_approval", "awaiting_input"].includes(turn.status)) await apiCall("POST", `/turns/${turn.id}/cancel`, {});
    }
});

test("같은 대화의 서버 초안 충돌은 두 입력을 보존하고 비교·합치기를 명시적으로 선택한다", async ({ page }) => {
    const { session, left, right } = await shared(page);
    const first = "left shared draft fixture";
    const second = "right shared draft fixture";
    await left.getByLabel("메시지 입력").fill(first);
    await right.getByLabel("메시지 입력").fill(second);
    await left.getByRole("button", { name: "초안 서버 저장", exact: true }).click();
    await expect(left.getByRole("status")).toContainText("서버에 초안을 저장했습니다");
    await right.getByRole("button", { name: "초안 서버 저장", exact: true }).click();
    const conflict = right.getByRole("alert").filter({ hasText: "서버 초안" });
    await expect(conflict).toBeVisible();
    await expect(left.getByLabel("메시지 입력")).toHaveValue(first);
    await expect(right.getByLabel("메시지 입력")).toHaveValue(second);
    await conflict.locator("summary").click();
    await expect(conflict.locator("pre")).toHaveText(first);
    await conflict.getByRole("button", { name: "합치기", exact: true }).click();
    await expect(right.getByLabel("메시지 입력")).toHaveValue(`${second}\n\n${first}`);
    await right.getByRole("button", { name: "초안 서버 저장", exact: true }).click();
    await expect(right.getByRole("status")).toContainText("서버에 초안을 저장했습니다");
    await expect(left.getByLabel("메시지 입력")).toHaveValue(first);
    const saved = await apiCall<{ revision: number; text: string }>("GET", `/drafts/session:${session.id}`);
    expect(saved).toMatchObject({ revision: 2, text: `${second}\n\n${first}` });
});
