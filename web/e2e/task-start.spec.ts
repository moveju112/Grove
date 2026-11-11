import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { apiCall, ensureProjects, login, openDetails, sessionView, state } from "./helpers";

for (const delivered of [false, true]) {
    test(`작업 시작 ${delivered ? "서버 처리 후" : "서버 도착 전"} 응답 유실을 같은 키로 확인한다`, async ({ page }) => {
        const { a } = await ensureProjects();
        const title = `작업 접수 ${delivered} ${Date.now()}`;
        const s = await apiCall<{ id: string }>("POST", `/projects/${a.id}/sessions`, { title });
        await apiCall("POST", "/recent/touch", { kind: "session", project_id: a.id, resource_id: s.id });
        await login(page);
        await page.locator(".recent").getByRole("button", { name: new RegExp(title) }).click();
        const panel = sessionView(page, s.id).getByTestId("tasks-panel");
        await openDetails(panel);
        const keys: string[] = [];
        let release = () => {};
        const gate = new Promise<void>((resolve) => { release = resolve; });
        await page.route(`**/api/v1/sessions/${s.id}/tasks`, async (route) => {
            if (route.request().method() !== "POST") return route.fallback();
            keys.push(route.request().headers()["idempotency-key"] ?? "");
            if (keys.length !== 1) return route.fallback();
            if (delivered) await route.fetch();
            await gate;
            return route.abort("connectionreset");
        });
        const marker = `task-${s.id}.txt`;
        const command = `printf once >> ${marker}`;
        await panel.getByLabel("백그라운드 명령").fill(command);
        try {
            // 같은 이벤트 루프의 이중 submit도 하나만 접수한다.
            await panel.locator("form").evaluate((form: HTMLFormElement) => { form.requestSubmit(); form.requestSubmit(); });
            await expect(panel.getByRole("button", { name: "실행", exact: true })).toBeDisabled();
            await expect(panel.getByLabel("백그라운드 명령")).toBeDisabled();
        } finally {
            release();
        }
        const retry = panel.getByRole("button", { name: "같은 요청 결과 확인", exact: true });
        await expect(retry).toBeVisible();
        expect(keys).toHaveLength(1);
        await expect(panel.getByLabel("백그라운드 명령")).toHaveValue(command);
        await retry.click();
        await expect(retry).toHaveCount(0);
        await expect(panel.getByLabel("백그라운드 명령")).toHaveValue("");
        expect(keys).toHaveLength(2);
        expect(keys[0]).toBeTruthy();
        expect(keys[1]).toBe(keys[0]);
        const list = await apiCall<{ tasks: { id: string }[] }>("GET", `/sessions/${s.id}/tasks`);
        expect(list.tasks).toHaveLength(1);
        const ended = await apiCall<{ status: string }>("GET", `/tasks/${list.tasks[0]!.id}/wait?timeout_ms=10000`);
        expect(ended.status).toBe("completed");
        expect(readFileSync(join(state().projA, marker), "utf8")).toBe("once");
        const messages = await apiCall<{ items: { content: { type?: string } }[] }>("GET", `/sessions/${s.id}/messages`);
        expect(messages.items.filter((m) => m.content.type === "task_result")).toHaveLength(1);
        // 확정 뒤 명시적으로 새 명령을 실행하면 새 키를 쓴다.
        await panel.getByLabel("백그라운드 명령").fill("printf next");
        await panel.getByRole("button", { name: "실행", exact: true }).click();
        await expect(panel.getByLabel("백그라운드 명령")).toHaveValue("");
        expect(keys).toHaveLength(3);
        expect(keys[2]).not.toBe(keys[0]);
    });
}

test("최종 접수 기록 실패는 결과 불명과 같은 키를 유지하고 사용자가 다음 명령을 선택한다", async ({ page }) => {
    const { a } = await ensureProjects();
    const title = `접수 기록 실패 ${Date.now()}`;
    const s = await apiCall<{ id: string }>("POST", `/projects/${a.id}/sessions`, { title });
    await apiCall("POST", "/recent/touch", { kind: "session", project_id: a.id, resource_id: s.id });
    await login(page);
    await page.locator(".recent").getByRole("button", { name: new RegExp(title) }).click();
    const panel = sessionView(page, s.id).getByTestId("tasks-panel");
    await openDetails(panel);
    const keys: string[] = [];
    const db = join(dirname(state().projA), "data", "grove.db");
    await page.route(`**/api/v1/sessions/${s.id}/tasks`, async (route) => {
        if (route.request().method() !== "POST") return route.fallback();
        keys.push(route.request().headers()["idempotency-key"] ?? "");
        if (keys.length !== 1) return route.fallback();
        // 격리 시험 DB에 최종 receipt UPDATE 실패만 주입한다.
        execFileSync("python3", ["-c", `
import sqlite3, sys
c=sqlite3.connect(sys.argv[1])
k=c.execute('SELECT quote(?)',(sys.argv[2],)).fetchone()[0]
c.executescript("CREATE TRIGGER fail_task_ui_receipt BEFORE UPDATE ON idempotency WHEN NEW.key="+k+" AND NEW.status=201 BEGIN SELECT RAISE(ABORT,'fixture final receipt failure'); END;")
c.close()
`, db, keys[0]!]);
        try {
            const response = await route.fetch();
            expect(response.status()).toBe(409);
            await route.fulfill({ response });
        } finally {
            execFileSync("python3", ["-c", "import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); c.execute('DROP TRIGGER fail_task_ui_receipt'); c.commit(); c.close()", db]);
        }
    });
    const marker = `task-${s.id}.txt`;
    await panel.getByLabel("백그라운드 명령").fill(`printf once >> ${marker}`);
    await panel.getByRole("button", { name: "실행", exact: true }).click();
    await expect(panel.getByRole("alert")).toContainText("작업 접수 결과를 확정하지 못했습니다");
    const retry = panel.getByRole("button", { name: "같은 요청 결과 확인", exact: true });
    const replayed = page.waitForResponse((r) => r.url().endsWith(`/sessions/${s.id}/tasks`) && r.request().method() === "POST");
    await retry.click();
    expect((await replayed).headers()["idempotent-replayed"]).toBe("true");
    await expect(retry).toBeVisible();
    expect(keys).toHaveLength(2);
    expect(keys[1]).toBe(keys[0]);
    const list = await apiCall<{ tasks: { id: string }[] }>("GET", `/sessions/${s.id}/tasks`);
    expect(list.tasks).toHaveLength(1);
    const ended = await apiCall<{ status: string }>("GET", `/tasks/${list.tasks[0]!.id}/wait?timeout_ms=10000`);
    expect(ended.status).toBe("completed");
    expect(readFileSync(join(state().projA, marker), "utf8")).toBe("once");
    await panel.getByRole("button", { name: "다른 명령 입력", exact: true }).click();
    await expect(panel.getByLabel("백그라운드 명령")).toBeEnabled();
    await expect(panel.getByLabel("백그라운드 명령")).toHaveValue("");
    await panel.getByLabel("백그라운드 명령").fill("printf next");
    await panel.getByRole("button", { name: "실행", exact: true }).click();
    await expect(panel.getByLabel("백그라운드 명령")).toHaveValue("");
    expect(keys).toHaveLength(3);
    expect(keys[2]).not.toBe(keys[0]);
});
