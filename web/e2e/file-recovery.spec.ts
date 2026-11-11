import { expect, test } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { apiCall, ensureProjects, login, state } from "./helpers";

for (const operation of ["save", "mkdir"] as const) {
    for (const phase of ["before", "after", "commit"] as const) {
        test(`파일 ${operation} ${phase} 실패는 같은 키로 확인하고 새 작업을 잠근다`, async ({ page }) => {
            const { a } = await ensureProjects();
            const project = await apiCall<{ root_path: string }>("GET", `/projects/${a.id}`);
            const name = `receipt-${operation}-${phase}-${Date.now()}`;
            const target = join(project.root_path, name);
            if (operation === "save") writeFileSync(target, "before\n");
            await login(page);
            await page.getByRole("button", { name: a.name, exact: true }).first().click();
            await page.getByRole("button", { name: "파일", exact: true }).click();
            const files = page.getByTestId("files-view");
            if (operation === "save") {
                await files.getByRole("button", { name, exact: true }).click();
                await expect(files.getByLabel("파일 내용")).toHaveValue("before\n");
                await files.getByLabel("파일 내용").fill("after\n");
            }
            const sent: { key: string; body: string | null }[] = [];
            await page.route(`**/api/v1/projects/${a.id}/files/${operation === "save" ? "content" : "op"}`, async (route) => {
                const request = route.request();
                if (request.method() !== (operation === "save" ? "PUT" : "POST")) return route.continue();
                sent.push({ key: request.headers()["idempotency-key"] ?? "", body: request.postData() });
                if (sent.length === 1 && phase === "commit") {
                    const db = join(dirname(state().projA), "data", "grove.db");
                    execFileSync("python3", ["-c", `
import sqlite3,sys
c=sqlite3.connect(sys.argv[1])
k=c.execute('SELECT quote(?)',(sys.argv[2],)).fetchone()[0]
c.executescript("CREATE TRIGGER fail_file_ui_receipt BEFORE UPDATE ON idempotency WHEN NEW.key="+k+" AND NEW.status=200 BEGIN SELECT RAISE(ABORT,'fixture file receipt'); END;")
c.close()
`, db, sent[0]!.key]);
                    try {
                        const response = await route.fetch();
                        expect(response.status()).toBe(409);
                        await route.fulfill({ response });
                    } finally {
                        execFileSync("python3", ["-c", "import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); c.execute('DROP TRIGGER fail_file_ui_receipt'); c.commit(); c.close()", db]);
                    }
                } else if (sent.length === 1) {
                    if (phase === "after") expect((await route.fetch()).status()).toBe(200);
                    await route.abort("failed");
                } else {
                    const response = await route.fetch();
                    expect(response.status()).toBe(phase === "commit" ? 409 : 200);
                    if (phase !== "before") expect(response.headers()["idempotent-replayed"]).toBe("true");
                    await route.fulfill({ response });
                }
            });
            if (operation === "save") {
                // 같은 이벤트 루프의 두 click도 요청은 하나만 만든다.
                await files.getByRole("button", { name: "저장", exact: true }).evaluate((button) => {
                    button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
                    button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
                });
            } else {
                page.once("dialog", (dialog) => dialog.accept(name));
                await files.getByRole("button", { name: "새 폴더", exact: true }).click();
            }
            const retry = files.getByRole("button", { name: "같은 요청 결과 확인" });
            await expect(retry).toBeVisible();
            await expect(files.getByRole("button", { name: "새 폴더", exact: true })).toBeDisabled();
            expect(sent).toHaveLength(1);
            expect(sent[0]!.key).toBeTruthy();
            if (operation === "save") {
                await expect(files.getByLabel("파일 내용")).toHaveJSProperty("readOnly", true);
                expect(readFileSync(target, "utf8")).toBe(phase === "before" ? "before\n" : "after\n");
            } else expect(existsSync(target)).toBe(phase !== "before");
            await Promise.all([
                page.waitForResponse((response) => response.url().endsWith(`/files/${operation === "save" ? "content" : "op"}`) && response.request().method() === (operation === "save" ? "PUT" : "POST")),
                retry.click(),
            ]);
            expect(sent).toHaveLength(2);
            expect(sent[1]).toEqual(sent[0]);
            if (phase === "commit") {
                const status = operation === "save" ? files.getByRole("status") : files.getByRole("alert");
                await expect(status).toContainText("파일 작업 결과를 확정하지 못했습니다");
                await expect(retry).toBeVisible();
                await expect(files.getByRole("button", { name: "새 폴더", exact: true })).toBeDisabled();
                await files.getByRole("button", { name: "원문 확인 후 닫기" }).click();
                await expect(retry).toBeHidden();
            } else {
                await expect(retry).toBeHidden();
                if (operation === "save") await expect(files.getByRole("status")).toHaveText("저장됨");
            }
            await expect(files.getByRole("button", { name: "새 폴더", exact: true })).toBeEnabled();
            if (operation === "save") {
                await expect(files.getByLabel("파일 내용")).toHaveValue("after\n");
                await expect(files.getByLabel("파일 내용")).toHaveJSProperty("readOnly", false);
                expect(readFileSync(target, "utf8")).toBe("after\n");
            } else expect(existsSync(target)).toBe(true);
            expect(sent).toHaveLength(2);
        });
    }
}
