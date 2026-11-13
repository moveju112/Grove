import { expect, test } from "@playwright/test";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { frames } from "./fixture";
import { apiCall, ensureProjects, login, sessionView } from "./helpers";

test("명시적 순서·전송 확인을 저장하고 retry 뒤 실제 모델과 이유를 표시한다", async ({ page, browser }) => {
    const prefix = `fallback-${randomUUID()}`;
    const requests: { model: string }[] = [];
    const fixture = createServer((req, res) => {
        let body = "";
        req.on("data", (chunk) => { body += chunk; });
        req.on("end", () => {
            const request = JSON.parse(body) as { model: string };
            requests.push(request);
            if (request.model === `${prefix}-primary`) {
                res.writeHead(503, { "content-type": "application/json" });
                res.end(JSON.stringify({ error: { message: "local fixture unavailable" } }));
            } else {
                res.writeHead(200, { "content-type": "text/event-stream" });
                res.end(frames.text(["fallback browser fixture complete"]).map((frame) => `data: ${frame}\n\n`).join(""));
            }
        });
    });
    await new Promise<void>((resolve) => fixture.listen(0, "127.0.0.1", resolve));
    const address = fixture.address();
    if (!address || typeof address === "string") throw new Error("local fixture address");
    const base_url = `http://127.0.0.1:${address.port}/v1`;
    const primary = await apiCall<{ id: string }>("POST", "/model-profiles", {
        name: `${prefix}-source`, protocol: "openai", base_url, model: `${prefix}-primary`,
    });
    const backup = await apiCall<{ id: string }>("POST", "/model-profiles", {
        name: `${prefix}-destination`, protocol: "openai", base_url, model: `${prefix}-actual`,
    });
    const context = await browser.newContext();
    try {
        await login(page);
        await page.getByRole("banner").getByRole("button", { name: "설정", exact: true }).click();
        await page.getByLabel("설정 검색").fill("프로필");
        const row = page.getByTestId("model-profile").filter({ hasText: `${prefix}-source` });
        const control = row.getByTestId("profile-fallback");
        await expect(control).toContainText("꺼짐");
        await control.getByRole("button", { name: "fallback 설정", exact: true }).click();
        await control.getByRole("button", { name: "마지막에 후보 추가", exact: true }).click();
        await control.getByLabel("fallback 1", { exact: true }).selectOption(backup.id);
        await expect(control).toContainText(`전송 대상: openai · ${base_url} · ${prefix}-actual`);
        await expect(control.getByRole("button", { name: "fallback 저장", exact: true })).toBeDisabled();
        await control.getByRole("checkbox").check();
        await control.getByRole("button", { name: "fallback 저장", exact: true }).click();
        await expect(control.getByRole("status")).toHaveText("fallback 저장됨");
        const stored = (await apiCall<{ id: string; options: { fallback: { enabled: boolean; candidates: { profile_id: string }[] } } }[]>("GET", "/model-profiles")).find((p) => p.id === primary.id)!;
        expect(stored.options.fallback.enabled).toBe(true);
        expect(stored.options.fallback.candidates.map((c) => c.profile_id)).toEqual([backup.id]);

        const { a } = await ensureProjects();
        const session = await apiCall<{ id: string }>("POST", `/projects/${a.id}/sessions`, { title: prefix });
        await apiCall("POST", "/recent/touch", { kind: "session", project_id: a.id, resource_id: session.id });
        const app = await context.newPage();
        await login(app);
        await app.locator(".recent").getByRole("button", { name: new RegExp(prefix) }).click();
        const view = sessionView(app, session.id);
        await view.getByLabel("보내기 방식").selectOption("model");
        await view.getByLabel("모델 프로필", { exact: true }).selectOption(primary.id);
        await view.getByRole("checkbox", { name: "도구", exact: true }).uncheck();
        await view.getByLabel("추론 강도", { exact: true }).selectOption("auto");
        await view.getByLabel("메시지 입력").fill("local explicit fallback request");
        await view.getByRole("button", { name: "보내기", exact: true }).click();
        await expect(view.getByTestId("msg-assistant").last()).toContainText("fallback browser fixture complete");
        await expect(view.getByTestId("msg-model-fallback")).toContainText(`${prefix}-actual`);
        await expect(view.getByTestId("msg-model-fallback")).toContainText("HTTP 503");
        expect(requests.map((r) => r.model)).toEqual([
            `${prefix}-primary`, `${prefix}-primary`, `${prefix}-primary`, `${prefix}-actual`,
        ]);
        await app.reload();
        await expect(sessionView(app, session.id).getByTestId("msg-model-fallback")).toContainText("HTTP 503");
        expect(requests).toHaveLength(4);
    } finally {
        await context.close();
        await apiCall("DELETE", `/model-profiles/${primary.id}`);
        await apiCall("DELETE", `/model-profiles/${backup.id}`);
        await new Promise<void>((resolve, reject) => fixture.close((error) => error ? reject(error) : resolve()));
    }
});
