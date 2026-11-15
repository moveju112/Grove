import { expect, test } from "@playwright/test";
import { apiCall, composerOption, ensureProjects, login } from "./helpers";

// UI-028: 서버가 처리했는지 모르는 전송 실패는 입력을 보관하고 자동 재전송하지 않으며, 다시 보내도 중복되지 않는다.
test("응답을 잃은 전송은 입력을 보관하고, 같은 내용 재전송은 같은 요청으로 처리된다", async ({ page }) => {
    const { a } = await ensureProjects();
    const title = `불명 전송 ${Date.now()}`;
    const s = await apiCall<{ id: string }>("POST", `/projects/${a.id}/sessions`, { title });
    await apiCall("POST", "/recent/touch", { kind: "session", project_id: a.id, resource_id: s.id });
    await login(page);
    await page.getByRole("region", { name: "최근", exact: true }).getByRole("button", { name: new RegExp(title) }).first().click();
    const view = page.getByTestId("session-view");
    await composerOption(view, "보내기 방식", "save");
    const box = view.getByLabel("메시지 입력");

    // 서버에는 도착하지만 응답은 브라우저에 오지 않는다
    const keys: string[] = [];
    let lose = true;
    await page.route(`**/api/v1/sessions/${s.id}/messages`, async (r) => {
        if (r.request().method() !== "POST") return r.fallback();
        keys.push(r.request().headers()["idempotency-key"] ?? "");
        if (lose) {
            await r.fetch();
            return r.abort("connectionreset");
        }
        return r.fallback();
    });
    await box.fill("한 번만 저장돼야 하는 글");
    await view.getByRole("button", { name: "보내기", exact: true }).click();
    await expect(view.getByTestId("send-unsure")).toBeVisible();
    await expect(box).toHaveValue("한 번만 저장돼야 하는 글");
    // 자동 재전송 없음
    await page.waitForTimeout(800);
    expect(keys).toHaveLength(1);
    // 서버에는 실제로 저장됐다(이벤트로 화면에도 보인다)
    await expect(view.getByTestId("msg-user")).toHaveCount(1);

    // 내용을 바꾸지 않고 다시 보내면 같은 key → 서버가 이전 결과를 돌려주고 중복 저장하지 않는다
    lose = false;
    await view.getByRole("button", { name: "같은 요청 확인", exact: true }).click();
    await expect(box).toHaveValue("");
    await expect(view.getByTestId("send-unsure")).toHaveCount(0);
    expect(keys).toHaveLength(2);
    expect(keys[1]).toBe(keys[0]);
    const msgs = await apiCall<{ items: { role: string }[] }>("GET", `/sessions/${s.id}/messages`);
    expect(msgs.items.filter((m) => m.role === "user")).toHaveLength(1);

    // 다음 새 글은 새 key
    await box.fill("다음 글");
    await view.getByRole("button", { name: "보내기", exact: true }).click();
    await expect(view.getByTestId("msg-user")).toHaveCount(2);
    expect(keys[2]).not.toBe(keys[0]);
});

test("결과를 모르는 실패 뒤 내용을 고쳐 보내면 새 요청이 된다", async ({ page }) => {
    const { a } = await ensureProjects();
    const title = `불명 수정 ${Date.now()}`;
    const s = await apiCall<{ id: string }>("POST", `/projects/${a.id}/sessions`, { title });
    await apiCall("POST", "/recent/touch", { kind: "session", project_id: a.id, resource_id: s.id });
    await login(page);
    await page.getByRole("region", { name: "최근", exact: true }).getByRole("button", { name: new RegExp(title) }).first().click();
    const view = page.getByTestId("session-view");
    await composerOption(view, "보내기 방식", "save");
    const box = view.getByLabel("메시지 입력");
    const keys: string[] = [];
    let fail = true;
    await page.route(`**/api/v1/sessions/${s.id}/messages`, async (r) => {
        if (r.request().method() !== "POST") return r.fallback();
        keys.push(r.request().headers()["idempotency-key"] ?? "");
        // 서버에 닿기 전에 끊김
        return fail ? r.abort("connectionrefused") : r.fallback();
    });
    await box.fill("처음 글");
    await view.getByRole("button", { name: "보내기", exact: true }).click();
    await expect(view.getByTestId("send-unsure")).toBeVisible();
    fail = false;
    await box.fill("고친 글");
    await view.getByRole("button", { name: "보내기", exact: true }).click();
    await expect(view.getByTestId("msg-user")).toHaveCount(1);
    await expect(view.getByTestId("msg-user")).toContainText("고친 글");
    expect(keys[1]).not.toBe(keys[0]);
});
