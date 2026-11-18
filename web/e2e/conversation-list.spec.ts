import { expect, test } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { dirname, join } from "node:path";
import { apiCall, closeMobileSidebar, ensureProfile, login, startProjectConversation, state } from "./helpers";

for (const width of [390, 1280]) {
    test.describe(`${width}px 대화 목록`, () => {
        test.use({ viewport: { width, height: 844 }, isMobile: width === 390, hasTouch: width === 390 });

        test("기록 모달에서 대화를 열고 페이지·보관 필터·작성 중 입력을 유지한다", async ({ page }, info) => {
            const a = await apiCall<{ id: string; name: string }>("POST", "/projects", {
                root_path: mkdtempSync(join(dirname(state().projA), "conversation-list-")),
            });
            await ensureProfile();
            const archived = await apiCall<{ id: string; revision: number }>("POST", `/projects/${a.id}/sessions`, { title: "보관된 대화 확인" });
            await apiCall("PATCH", `/sessions/${archived.id}`, { expected_revision: archived.revision, archived: true });
            for (let i = 0; i < 31; i++) {
                const session = await apiCall<{ id: string }>("POST", `/projects/${a.id}/sessions`, { title: `목록 확인 ${i}` });
                if (i === 30) await apiCall("POST", `/sessions/${session.id}/messages`, { text: "아주 긴 대화 미리보기에서도 시간은 오른쪽 끝에 유지한다. ".repeat(12) });
            }
            await login(page);
            if (width === 390) await page.getByRole("button", { name: "사이드바", exact: true }).click();
            await expect(page.getByTestId("sidebar").getByRole("button", { name: "대화 검색", exact: true })).toHaveCount(0);
            await page.getByTestId("project-row").getByRole("button", { name: a.name, exact: true }).click();
            if (width === 390) await closeMobileSidebar(page);
            const project = page.getByTestId("project-view").filter({ visible: true });
            await startProjectConversation(project);
            await project.getByLabel("메시지 입력").fill("기록을 열어도 보존할 초안");
            await expect(project.getByRole("button", { name: /목록 확인/ })).toHaveCount(0);
            const openHistory = async () => {
                if (width === 390) await page.getByRole("button", { name: "사이드바", exact: true }).click();
                await page.getByTestId("project-row").filter({ hasText: a.name }).getByRole("button", { name: "프로젝트 메뉴", exact: true }).click();
                await page.getByRole("dialog", { name: `${a.name} 메뉴`, exact: true }).getByRole("button", { name: "기록", exact: true }).click();
            };
            await openHistory();
            const list = page.getByRole("dialog", { name: `${a.name} 기록`, exact: true });
            await expect(project.getByRole("searchbox")).toHaveCount(0);
            await expect(page.getByTestId("search-panel")).toHaveCount(0);
            await expect(list.getByRole("button", { name: /목록 확인 \d+$/ })).toHaveCount(30);
            await list.getByRole("button", { name: "더 보기", exact: true }).click();
            await expect(list.getByRole("button", { name: /목록 확인 \d+$/ })).toHaveCount(31);
            await list.getByRole("button", { name: "보관된 대화", exact: true }).click();
            await expect(list.getByRole("button", { name: "보관된 대화 확인", exact: true })).toBeVisible();
            await expect(list.getByRole("button", { name: /목록 확인 \d+$/ })).toHaveCount(0);
            await list.getByRole("button", { name: "보관된 대화", exact: true }).click();
            await expect(list.getByRole("button", { name: /목록 확인 \d+$/ })).toHaveCount(30);
            await expect(project.getByLabel("메시지 입력")).toHaveValue("기록을 열어도 보존할 초안");
            const timestamps = await list.getByTestId("session-updated").evaluateAll((nodes) => nodes.map((node) => {
                const box = node.getBoundingClientRect();
                const row = node.closest("li")!.getBoundingClientRect();
                return { right: box.right, rowRight: row.right, textAlign: getComputedStyle(node).textAlign };
            }));
            expect(timestamps.every((time) => Math.abs(time.right - timestamps[0]!.right) <= 1)).toBe(true);
            expect(timestamps.every((time) => time.textAlign === "end" && time.rowRight - time.right <= 16)).toBe(true);
            const geometry = await list.evaluate((node) => {
                const box = node.getBoundingClientRect();
                return { left: box.left, right: box.right, width: node.clientWidth, scroll: node.scrollWidth };
            });
            await page.screenshot({ path: info.outputPath(`conversation-list-${width}.png`) });
            expect(geometry.left).toBeGreaterThanOrEqual(0);
            expect(geometry.right).toBeLessThanOrEqual(width);
            expect(geometry.scroll).toBeLessThanOrEqual(geometry.width);
            await page.keyboard.press("Escape");
            await expect(list).toBeHidden();
            const trigger = page.getByTestId("project-row").filter({ hasText: a.name }).getByRole("button", { name: "프로젝트 메뉴", exact: true });
            await expect(trigger).toBeFocused();
            if (width === 390) await closeMobileSidebar(page);
            await expect(project.getByLabel("메시지 입력")).toHaveValue("기록을 열어도 보존할 초안");
            await openHistory();
            await list.getByRole("button", { name: /목록 확인 30$/ }).click();
            await expect(page.getByTestId("session-view").filter({ visible: true })).toBeVisible();
            await expect(list).toBeHidden();
            if (width === 390) await expect(page.getByTestId("mobile-drawer-left")).toHaveJSProperty("open", false);
        });
    });
}
