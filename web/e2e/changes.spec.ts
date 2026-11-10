import { expect, test } from "@playwright/test";
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { apiCall, ensureProjects, login } from "./helpers";

type Call = { id: string; status: string; revision: number };

/// 사용자 직접 도구 요청을 만들고 승인한 뒤 끝날 때까지 기다린다(모델 없이).
async function runTool(sid: string, name: string, args: object) {
    const c = await apiCall<Call>("POST", `/sessions/${sid}/tool-requests`, { name, args });
    await apiCall("POST", `/tool-calls/${c.id}/decision`, { decision: "approve", expected_revision: c.revision });
    for (let i = 0; i < 100; i++) {
        const cur = await apiCall<Call>("GET", `/tool-calls/${c.id}`);
        if (cur.status === "succeeded") return;
        if (["failed", "cancelled", "denied", "expired", "unknown"].includes(cur.status)) throw new Error(`${name}: ${cur.status}`);
        await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`도구 실행이 끝나지 않음: ${name}`);
}

// GIT-011~014: 파일 변경 이력에서 patch를 보고, 되돌리고 다시 적용하며, 바깥 변경은 충돌로 알린다.
test("파일 변경 이력에서 patch를 보고 되돌리기·다시 적용하며 바깥 변경은 충돌로 알린다", async ({ page }) => {
    const { a } = await ensureProjects();
    const projects = await apiCall<{ id: string; root_path: string }[]>("GET", "/projects");
    const root = projects.find((p) => p.id === a.id)!.root_path;
    const title = `변경 대화 ${Date.now()}`;
    const s = await apiCall<{ id: string }>("POST", `/projects/${a.id}/sessions`, { title });
    await apiCall("POST", "/recent/touch", { kind: "session", project_id: a.id, resource_id: s.id });
    const file = `e2e-change-${Date.now()}.txt`;
    await runTool(s.id, "write", { path: file, content: "v1\n" });
    await runTool(s.id, "edit", { path: file, old_string: "v1", new_string: "v2" });
    expect(readFileSync(join(root, file), "utf8")).toBe("v2\n");

    await login(page);
    await page.locator(".recent").getByRole("button", { name: new RegExp(title) }).first().click();
    const panel = page.getByTestId("session-view").getByTestId("changes-panel");
    await panel.locator("summary").click();
    const rows = panel.getByTestId("change-row");
    await expect(rows).toHaveCount(2);
    await rows.first().getByRole("button", { name: "patch" }).click();
    await expect(panel.getByTestId("change-diff")).toContainText("+v1");

    // 요청 묶음 전체 되돌리기 → 파일 없음, 다시 적용 → v2
    await panel.getByRole("button", { name: "이 요청의 변경 되돌리기" }).click();
    await expect(panel.locator('[data-testid="change-row"][data-state="undone"]')).toHaveCount(2);
    expect(existsSync(join(root, file))).toBe(false);
    await panel.getByRole("button", { name: "다시 적용" }).first().click();
    await expect(panel.locator('[data-testid="change-row"][data-state="applied"]')).toHaveCount(2);
    expect(readFileSync(join(root, file), "utf8")).toBe("v2\n");

    // 바깥에서 바꾸면 되돌리기는 충돌, 파일 유지
    writeFileSync(join(root, file), "outside\n");
    await rows.nth(1).getByRole("button", { name: "되돌리기" }).click();
    await expect(panel.getByRole("alert")).toContainText(file);
    expect(readFileSync(join(root, file), "utf8")).toBe("outside\n");

    // 전체 검토: 처음(없음)과 지금 비교
    await panel.getByRole("button", { name: /대화 전체 검토/ }).click();
    await expect(panel.getByTestId("review")).toContainText("+outside");
});
