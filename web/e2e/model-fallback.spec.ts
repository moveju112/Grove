import { expect, test } from "@playwright/test";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { frames } from "./fixture";
import { apiCall, composerOption, ensureProjects, login, openDetails, openSettings, selectChoice, sessionView } from "./helpers";

test("명시적 순서·전송 확인을 저장하고 retry 뒤 실제 모델과 이유를 표시한다", async ({ page, browser }) => {
    const prefix = `fallback-${randomUUID().slice(0, 8)}`;
    const requests: { model: string }[] = [];
    const fixture = createServer((req, res) => {
        if (req.method === "GET" && req.url === "/v1/models") {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ data: [{ id: `${prefix}-primary` }, { id: `${prefix}-actual` }] }));
            return;
        }
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
        await openSettings(page);
        await page.getByLabel("설정 검색").fill("프로필");
        const row = page.getByTestId("model-profile").filter({ hasText: `${prefix}-source` });
        await openDetails(row);
        const control = row.getByTestId("profile-fallback");
        await expect(control).toContainText("꺼짐");
        await control.getByRole("button", { name: "마지막에 후보 추가", exact: true }).click();
        await selectChoice(control.getByLabel("fallback 1", { exact: true }), backup.id);
        await expect(control).toContainText(`전송 대상: openai · ${base_url} · ${prefix}-actual`);
        await expect(control.getByRole("button", { name: "fallback 저장", exact: true })).toHaveCount(0);
        await selectChoice(control.getByLabel("위 순서의 다른 전송 대상·모델·가격으로 대화가 전달되는 것을 확인했습니다"), "true");
        await expect(control.getByRole("status").filter({ hasText: /\S/ })).toHaveText("저장됨");
        const stored = (await apiCall<{ id: string; options: { fallback: { enabled: boolean; candidates: { profile_id: string }[] } } }[]>("GET", "/model-profiles")).find((p) => p.id === primary.id)!;
        expect(stored.options.fallback.enabled).toBe(true);
        expect(stored.options.fallback.candidates.map((c) => c.profile_id)).toEqual([backup.id]);
        await row.getByRole("dialog").getByRole("button", { name: "닫기", exact: true }).click();
        await page.getByRole("button", { name: "설정 닫기", exact: true }).click();

        const { a } = await ensureProjects();
        const session = await apiCall<{ id: string }>("POST", `/projects/${a.id}/sessions`, { title: prefix });
        await apiCall("POST", "/recent/touch", { kind: "session", project_id: a.id, resource_id: session.id });
        const app = await context.newPage();
        await login(app);
        await app.getByRole("region", { name: "최근", exact: true }).getByRole("button", { name: prefix, exact: true }).click();
        const view = sessionView(app, session.id);
        await composerOption(view, "보내기 방식", "model");
        await composerOption(view, "모델 프로필", primary.id);
        await composerOption(view, "도구", false);
        await composerOption(view, "추론", "auto");
        await view.getByLabel("메시지 입력").fill("local explicit fallback request");
        await view.getByRole("button", { name: "보내기", exact: true }).click();
        await expect(view.getByTestId("msg-assistant").last()).toContainText("fallback browser fixture complete");
        const record = view.getByTestId("msg-model-fallback");
        await expect(record).toContainText(`${prefix}-actual`);
        await expect(record).toContainText("HTTP 503");
        await openDetails(record);
        await expect(record.getByText(/전환 이유: provider_unavailable/)).toBeVisible();
        await expect(record.getByText("이후 호출 대상:", { exact: false })).toContainText(base_url);
        await expect(record.getByText("원래 선택:", { exact: false })).toContainText(primary.id);
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
