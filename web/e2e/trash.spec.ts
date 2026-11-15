import { expect, test } from "@playwright/test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { apiCall, ensureProjects, login, openDetails } from "./helpers";

// DB-018: 프로젝트 화면의 휴지통에서 지운 파일을 복원하고, 확인 문구를 넣어 영구 삭제한다.
test("휴지통에서 지운 파일을 복원하고 확인 후 영구 삭제한다", async ({ page }) => {
    const { b } = await ensureProjects();
    const root = (await apiCall<{ id: string; root_path: string }[]>("GET", "/projects")).find((p) => p.id === b.id)!.root_path;
    const name = `trash-${Date.now()}.txt`;
    writeFileSync(join(root, name), "복원할 내용");
    await apiCall("POST", `/projects/${b.id}/files/op`, { op: "delete", path: name, confirm: name });
    expect(existsSync(join(root, name))).toBe(false);

    await login(page);
    await page.getByTestId("sidebar").getByTestId("projects").getByRole("button", { name: new RegExp(b.name) }).first().click();
    const panel = page.getByTestId("project-view").filter({ has: page.locator("h1", { hasText: b.name }) }).getByTestId("trash-panel");
    await openDetails(panel, "휴지통");
    const row = panel.getByTestId("trash-row").filter({ hasText: name });
    await row.getByRole("button", { name: "복원" }).click();
    await expect(row).toHaveCount(0);
    expect(readFileSync(join(root, name), "utf8")).toBe("복원할 내용");

    // 다시 지운 뒤 영구 삭제(확인 문구 입력)
    await apiCall("POST", `/projects/${b.id}/files/op`, { op: "delete", path: name, confirm: name });
    await expect(row).toHaveCount(1);
    page.once("dialog", (d) => void d.accept(name));
    await row.getByRole("button", { name: "영구 삭제" }).click();
    await expect(row).toHaveCount(0);
    expect(existsSync(join(root, name))).toBe(false);
    const left = await apiCall<{ items: { path: string }[] }>("GET", `/projects/${b.id}/trash`);
    expect(left.items.some((i) => i.path === name)).toBe(false);
});

test("복원 응답을 잃어도 같은 요청 결과를 확인하고 다른 창에 영구 삭제를 전달한다", async ({ page, browser }) => {
    const { b } = await ensureProjects();
    const root = (await apiCall<{ id: string; root_path: string }[]>("GET", "/projects")).find((p) => p.id === b.id)!.root_path;
    const name = `lost-trash-${Date.now()}.txt`;
    writeFileSync(join(root, name), "응답 유실 원본");
    const deleted = await apiCall<{ trash: string }>("POST", `/projects/${b.id}/files/op`, { op: "delete", path: name, confirm: name });
    await login(page);
    await page.getByTestId("sidebar").getByTestId("projects").getByRole("button", { name: new RegExp(b.name) }).first().click();
    const panel = page.getByTestId("project-view").filter({ has: page.locator("h1", { hasText: b.name }) }).getByTestId("trash-panel");
    await openDetails(panel, "휴지통");
    const row = panel.getByTestId("trash-row").filter({ hasText: name });
    const keys: string[] = [];
    let lose = true;
    await page.route(`**/api/v1/trash/${deleted.trash}/restore`, async (route) => {
        keys.push(route.request().headers()["idempotency-key"] ?? "");
        if (lose) {
            await route.fetch();
            return route.abort("connectionreset");
        }
        return route.fallback();
    });
    await row.getByRole("button", { name: "복원" }).click();
    await expect(panel.getByRole("alert")).toContainText("응답을 받지 못했습니다");
    await expect(row).toHaveCount(0);
    expect(keys).toHaveLength(1);
    expect(readFileSync(join(root, name), "utf8")).toBe("응답 유실 원본");
    // 새 파일이 생겨도 재확인은 저장된 응답만 읽고 다시 쓰지 않는다.
    writeFileSync(join(root, name), "사용자가 수정한 파일");
    lose = false;
    await panel.getByRole("button", { name: "같은 요청 결과 확인" }).click();
    await expect(panel.getByRole("alert")).toHaveCount(0);
    expect(keys).toHaveLength(2);
    expect(keys[1]).toBe(keys[0]);
    expect(readFileSync(join(root, name), "utf8")).toBe("사용자가 수정한 파일");

    const context = await browser.newContext();
    try {
        const other = await context.newPage();
        await login(other);
        await other.getByTestId("sidebar").getByTestId("projects").getByRole("button", { name: new RegExp(b.name) }).first().click();
        const otherPanel = other.getByTestId("project-view").filter({ has: other.locator("h1", { hasText: b.name }) }).getByTestId("trash-panel");
        await openDetails(otherPanel, "휴지통");
        await apiCall("POST", `/projects/${b.id}/files/op`, { op: "delete", path: name, confirm: name });
        const otherRow = otherPanel.getByTestId("trash-row").filter({ hasText: name });
        await expect(otherRow).toHaveCount(1);
        await expect(row).toHaveCount(1);
        page.once("dialog", (d) => void d.accept(name));
        await row.getByRole("button", { name: "영구 삭제" }).click();
        await expect(row).toHaveCount(0);
        await expect(otherRow).toHaveCount(0);
    } finally {
        await context.close();
    }
});
