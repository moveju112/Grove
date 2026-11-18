import { expect, test } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { apiCall, login, openTool, state } from "./helpers";

for (const width of [390, 1400]) {
    test.describe(`${width}px Git 패널`, () => {
        test.use({ viewport: { width, height: 844 }, isMobile: width === 390, hasTouch: width === 390 });

        test("6,400개 변경을 페이지로 나누고 전체 검색·정확한 파일 stage·행 정렬을 유지한다", async ({ page }, info) => {
            const root = mkdtempSync(join(dirname(state().projA), "git-many-"));
            const run = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" });
            run("init", "-q", "-b", "main");
            run("config", "user.name", "Fixture");
            run("config", "user.email", "fixture@example.invalid");
            const tracked = "a-very-long-tracked-file-name-that-must-not-push-the-row-actions.txt";
            writeFileSync(join(root, tracked), "base\n");
            run("add", tracked);
            run("commit", "-qm", "base");
            writeFileSync(join(root, tracked), "changed\n");
            mkdirSync(join(root, "work"));
            for (let i = 0; i < 6400; i++) writeFileSync(join(root, "work", `entry-${String(i).padStart(4, "0")}.txt`), `${i}\n`);
            const indexBefore = readFileSync(join(root, ".git/index"));
            const project = await apiCall<{ id: string; name: string }>("POST", "/projects", { root_path: root });
            await login(page);
            if (width === 390) await page.getByRole("button", { name: "사이드바", exact: true }).click();
            await page.getByTestId("project-row").getByRole("button", { name: project.name, exact: true }).click();
            await openTool(page, "변경");
            const panel = page.getByTestId("git-panel");
            const overview = panel.getByTestId("git-context");
            await expect(overview.getByRole("group", { name: "Git 위치 정보", exact: true })).toContainText("main");
            await expect(overview.getByRole("group", { name: "GitHub PR과 CI", exact: true })).toBeVisible();
            await expect(overview.getByRole("group", { name: "Git 실행 권한", exact: true })).toBeVisible();
            expect((await overview.getByRole("rowheader", { name: "stage", exact: true }).boundingBox())!.width).toBeGreaterThan(70);
            await overview.scrollIntoViewIfNeeded();
            await page.screenshot({ path: info.outputPath(`git-overview-${width}.png`), animations: "disabled" });

            const changes = panel.getByRole("region", { name: "작업 트리 변경", exact: true });
            await expect(changes.getByRole("heading")).toHaveText("작업 트리 변경 (6401)");
            await expect(changes.getByTestId("git-change-row")).toHaveCount(50);
            await expect(changes.getByTestId("git-change-range")).toHaveText("1–50 / 6401개");
            await expect(changes.getByRole("button", { name: "작업 트리 변경 이전 페이지" })).toBeDisabled();
            const row = changes.getByTestId("git-change-row").first();
            await row.scrollIntoViewIfNeeded();
            await expect(changes.getByText("work/entry-0000.txt", { exact: true })).toHaveCSS("text-align", "start");
            const textInset = await changes.getByRole("button", { name: "work/entry-0000.txt", exact: true }).evaluate((button) => {
                const content = button.querySelector("[data-grove-button-content]")!;
                const text = document.createTreeWalker(content, NodeFilter.SHOW_TEXT).nextNode()!;
                const range = document.createRange();
                range.selectNodeContents(text);
                return range.getBoundingClientRect().x - button.getBoundingClientRect().x;
            });
            expect(textInset).toBeGreaterThanOrEqual(0);
            expect(textInset).toBeLessThanOrEqual(12);
            const buttons = row.getByRole("button");
            const path = (await buttons.nth(0).boundingBox())!;
            const stage = (await buttons.nth(1).boundingBox())!;
            const discard = (await buttons.nth(2).boundingBox())!;
            const rowBox = (await row.boundingBox())!;
            expect(path.x + path.width).toBeLessThanOrEqual(stage.x);
            expect(discard.x - stage.x - stage.width).toBeGreaterThanOrEqual(7);
            expect(Math.abs(stage.y + stage.height / 2 - discard.y - discard.height / 2)).toBeLessThan(2);
            expect(rowBox.x + rowBox.width - discard.x - discard.width).toBeLessThanOrEqual(12);
            await changes.getByRole("heading").scrollIntoViewIfNeeded();
            await page.screenshot({ path: info.outputPath(`git-changes-${width}.png`), animations: "disabled" });
            expect(readFileSync(join(root, ".git/index"))).toEqual(indexBefore);

            await changes.getByRole("button", { name: "작업 트리 변경 다음 페이지" }).click();
            await expect(changes.getByTestId("git-change-range")).toHaveText("51–100 / 6401개");
            await expect(changes.getByTestId("git-change-row")).toHaveCount(50);
            await expect(changes.getByRole("button", { name: "work/entry-0049.txt", exact: true })).toBeVisible();
            await changes.getByRole("searchbox", { name: "작업 트리 변경 검색" }).fill("entry-6399");
            await expect(changes.getByTestId("git-change-row")).toHaveCount(1);
            await expect(changes.getByTestId("git-change-range")).toHaveText("검색 결과 1개 · 전체 6401개");
            await changes.getByRole("button", { name: "올리기", exact: true }).click();
            await expect(panel.getByRole("region", { name: "커밋할 변경", exact: true })).toContainText("work/entry-6399.txt");
            expect(run("show", ":work/entry-6399.txt")).toBe("6399\n");
            await expect(changes).toContainText("일치하는 파일이 없어요.");
            await changes.getByRole("searchbox", { name: "작업 트리 변경 검색" }).fill("");
            await expect(changes.getByTestId("git-change-row")).toHaveCount(50);
            await expect(changes.getByTestId("git-change-range")).toHaveText("1–50 / 6400개");
            const overflow = await panel.evaluate((element) => element.scrollWidth - element.clientWidth);
            expect(overflow).toBeLessThanOrEqual(1);
        });
    });
}
