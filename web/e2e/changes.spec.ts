import { expect, test } from "@playwright/test";
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";
import { apiCall, ensureProjects, login, openTool, state } from "./helpers";

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
    await openTool(page.getByTestId("session-view"), "변경");
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

for (const phase of ["before", "after", "commit"] as const) {
    test(`변경 적용 ${phase} 실패는 같은 키로 확인하고 이중 클릭은 한 번만 보낸다`, async ({ page }) => {
        const { a } = await ensureProjects();
        const projects = await apiCall<{ id: string; root_path: string }[]>("GET", "/projects");
        const root = projects.find((p) => p.id === a.id)!.root_path;
        const title = `적용 응답 유실 ${phase} ${Date.now()}`;
        const session = await apiCall<{ id: string }>("POST", `/projects/${a.id}/sessions`, { title });
        await apiCall("POST", "/recent/touch", { kind: "session", project_id: a.id, resource_id: session.id });
        const file = join(root, `e2e-undo-${phase}-${Date.now()}.txt`);
        writeFileSync(file, "before\n");
        await runTool(session.id, "edit", { path: file.slice(root.length + 1), old_string: "before", new_string: "after" });
        await login(page);
        await page.locator(".recent").getByRole("button", { name: new RegExp(title) }).first().click();
        const panel = page.getByTestId("session-view").getByTestId("changes-panel");
        await openTool(page.getByTestId("session-view"), "변경");
        const row = panel.getByTestId("change-row");
        await expect(row).toHaveCount(1);
        const sent: { op: string; key: string }[] = [];
        await page.route(`**/api/v1/sessions/${session.id}/file-changes/*`, async (route) => {
            const request = route.request();
            sent.push({ op: request.url().split("/").pop()!, key: request.headers()["idempotency-key"] ?? "" });
            if (sent.length === 1 && phase === "commit") {
                const db = join(dirname(state().projA), "data", "grove.db");
                execFileSync("python3", ["-c", `
import sqlite3,sys
c=sqlite3.connect(sys.argv[1])
k=c.execute('SELECT quote(?)',(sys.argv[2],)).fetchone()[0]
c.executescript("CREATE TRIGGER fail_change_ui_receipt BEFORE UPDATE ON idempotency WHEN NEW.key="+k+" AND NEW.status=200 BEGIN SELECT RAISE(ABORT,'fixture final change receipt'); END;")
c.close()
`, db, sent[0]!.key]);
                try {
                    const response = await route.fetch();
                    expect(response.status()).toBe(409);
                    await route.fulfill({ response });
                } finally {
                    execFileSync("python3", ["-c", "import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); c.execute('DROP TRIGGER fail_change_ui_receipt'); c.commit(); c.close()", db]);
                }
            } else if (sent.length === 1) {
                if (phase === "after") expect((await route.fetch()).status()).toBe(200);
                await route.abort("failed");
            } else {
                const response = await route.fetch();
                expect(response.status()).toBe(phase === "commit" && sent.length === 2 ? 409 : 200);
                if (sent.length === 2 && phase !== "before") expect(response.headers()["idempotent-replayed"]).toBe("true");
                await route.fulfill({ response });
            }
        });
        await row.getByRole("button", { name: "되돌리기", exact: true }).click();
        const retry = panel.getByRole("button", { name: "같은 요청 결과 확인" });
        await expect(retry).toBeVisible();
        expect(readFileSync(file, "utf8")).toBe(phase === "before" ? "after\n" : "before\n");
        await expect(panel.getByRole("button", { name: "이 요청의 변경 되돌리기" })).toBeDisabled();
        await retry.click();
        if (phase === "commit") {
            await expect(panel.getByRole("alert")).toContainText("파일 변경 결과를 확정하지 못했습니다");
            await expect(retry).toBeVisible();
            await expect(panel.getByRole("button", { name: "이 요청의 변경 되돌리기" })).toBeDisabled();
            // 사용자가 원문을 확인·복구한 후에만 새 요청으로 진행한다.
            writeFileSync(file, "after\n");
            await panel.getByRole("button", { name: "원문 확인 후 닫기" }).click();
        } else {
            await expect(retry).toBeHidden();
            await expect(row).toHaveAttribute("data-state", "undone");
            expect(readFileSync(file, "utf8")).toBe("before\n");
        }
        expect(sent).toHaveLength(2);
        expect(sent[0]!.key).toBeTruthy();
        expect(sent[0]).toEqual(sent[1]);
        const redo = row.getByRole("button", { name: phase === "commit" ? "되돌리기" : "다시 적용", exact: true });
        await redo.evaluate((button) => {
            button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
            button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        });
        await expect(row).toHaveAttribute("data-state", phase === "commit" ? "undone" : "applied");
        expect(readFileSync(file, "utf8")).toBe(phase === "commit" ? "before\n" : "after\n");
        expect(sent).toHaveLength(3);
        expect(sent[2]!.op).toBe(phase === "commit" ? "undo" : "redo");
        expect(sent[2]!.key).not.toBe(sent[0]!.key);
    });
}
