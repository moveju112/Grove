import { expect, test } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { frames } from "./fixture";
import { apiCall, ensureProfile, ensureProjects, login, script, sessionView, state } from "./helpers";

for (const mobile of [false, true]) {
    test.describe(mobile ? "390px 파일 링크" : "파일 링크", () => {
        if (mobile) test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

        test("파일 링크와 줄 앵커에서 변경점을 확인하고 원문으로 이동한다", async ({ page }, info) => {
            await ensureProjects();
            const profile = await ensureProfile();
            const root = mkdtempSync(join(dirname(state().projA), "file-links-"));
            const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" });
            git("init", "-q", "-b", "main");
            git("config", "user.email", "e2e@example.invalid");
            git("config", "user.name", "E2E");
            writeFileSync(join(root, "app.rs"), "base\n");
            git("add", "app.rs");
            git("commit", "-qm", "base");
            writeFileSync(join(root, "app.rs"), "staged\n");
            git("add", "app.rs");
            writeFileSync(join(root, "app.rs"), "working\n찾는 줄\n");
            writeFileSync(join(root, "new notes.md"), "새 문서 내용\n");
            const before = readFileSync(join(root, ".git/index"));
            const project = await apiCall<{ id: string }>("POST", "/projects", { root_path: root });
            const session = await apiCall<{ id: string }>("POST", `/projects/${project.id}/sessions`, { title: `파일 링크 ${mobile}` });
            await apiCall("POST", "/recent/touch", { kind: "session", project_id: project.id, resource_id: session.id });
            await login(page);
            // 탐색 서랍은 기존 모바일 동선을 사용한다.
            if (mobile) await page.getByRole("button", { name: "사이드바", exact: true }).click();
            await page.getByRole("region", { name: "최근", exact: true }).getByRole("button", { name: new RegExp(`파일 링크 ${mobile}`) }).first().click();
            const view = sessionView(page, session.id);
            await expect(view).toBeVisible();
            await script({ frames: frames.text([
                `[구현 코드](app.rs#L2) · [새 문서](<${root}/new notes.md>) · [외부 파일](/etc/passwd#L1) · \`app.rs:2\``,
            ]) });
            await apiCall("POST", `/sessions/${session.id}/turns`, { profile_id: profile, text: "변경 파일 보여줘" });
            const answer = view.getByTestId("msg-assistant").last();
            await expect(answer.getByTestId("file-link")).toHaveCount(2, { timeout: 15_000 });
            await expect(answer).not.toContainText("#L2");
            if (mobile) await page.screenshot({ path: info.outputPath("file-citation-390.png"), animations: "disabled" });
            await answer.getByRole("button", { name: "구현 코드", exact: true }).click();
            const dialog = page.getByRole("dialog", { name: "app.rs 변경점", exact: true });
            await expect(dialog).toContainText("-base");
            await expect(dialog).toContainText("+staged");
            await expect(dialog).toContainText("+working");
            await expect(dialog).toContainText("작업 트리 변경");
            await expect(dialog).toContainText("커밋할 변경");
            await expect(dialog.getByTestId("file-diff")).toHaveCount(2);
            await expect(dialog.locator("textarea")).toHaveCount(0);
            if (mobile) await page.screenshot({ path: info.outputPath("file-link-390.png"), animations: "disabled" });
            await page.keyboard.press("Escape");
            await expect(dialog).toHaveCount(0);
            await expect(answer.getByRole("button", { name: "구현 코드", exact: true })).toBeFocused();
            await answer.getByTestId("file-ref").click();
            await expect(dialog.getByTestId("file-diff")).toHaveCount(2);
            await expect(page.getByTestId("files-view")).toHaveCount(0);
            await dialog.getByRole("button", { name: "닫기", exact: true }).click();
            await answer.getByRole("button", { name: "새 문서", exact: true }).click();
            const newFile = page.getByRole("dialog", { name: "new notes.md 변경점", exact: true });
            await expect(newFile).toContainText("새 문서 내용");
            await expect(newFile).toContainText("새 파일");
            await expect(newFile.getByTestId("file-diff")).toContainText("@@ -0,0 +1,1 @@");
            await newFile.getByRole("button", { name: "닫기", exact: true }).click();
            writeFileSync(join(root, "app.rs"), "updated\n찾는 줄\n");
            await answer.getByRole("button", { name: "구현 코드", exact: true }).click();
            await expect(dialog).toContainText("+updated");
            await dialog.getByRole("button", { name: "파일 열기", exact: true }).click();
            const area = page.getByTestId("files-view").getByLabel("파일 내용");
            await expect(area).toHaveValue("updated\n찾는 줄\n");
            expect(await area.evaluate((el: HTMLTextAreaElement) => el.value.slice(el.selectionStart, el.selectionEnd))).toBe("찾는 줄");
            expect(readFileSync(join(root, ".git/index"))).toEqual(before);
        });
    });
}
