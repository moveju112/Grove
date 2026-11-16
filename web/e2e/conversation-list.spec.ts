import { expect, test } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { dirname, join } from "node:path";
import { apiCall, closeMobileSidebar, ensureProfile, login, startProjectConversation, state } from "./helpers";

for (const width of [390, 1280]) {
    test.describe(`${width}px 대화 목록`, () => {
        test.use({ viewport: { width, height: 844 }, isMobile: width === 390, hasTouch: width === 390 });

        test("검색 없이 대화를 열고 목록 페이지·보관 필터·작성 중 초안을 유지한다", async ({ page }, info) => {
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
            const list = project.getByRole("region", { name: "프로젝트 대화", exact: true });
            await expect(project.getByRole("searchbox")).toHaveCount(0);
            await expect(page.getByTestId("search-panel")).toHaveCount(0);
            await expect(list.getByRole("button", { name: /목록 확인 \d+$/ })).toHaveCount(30);
            await list.getByRole("button", { name: "더 보기", exact: true }).click();
            await expect(list.getByRole("button", { name: /목록 확인 \d+$/ })).toHaveCount(31);
            await startProjectConversation(project);
            await project.getByLabel("메시지 입력").fill("목록을 바꿔도 보존할 초안");
            await project.getByRole("button", { name: "프로젝트 작업", exact: true }).click();
            await page.getByRole("button", { name: "보관된 대화 보기", exact: true }).click();
            await expect(list.getByRole("button", { name: "보관된 대화 확인", exact: true })).toBeVisible();
            await expect(list.getByRole("button", { name: /목록 확인 \d+$/ })).toHaveCount(0);
            await list.getByRole("button", { name: "보관됨 필터 해제", exact: true }).click();
            await expect(list.getByRole("button", { name: /목록 확인 \d+$/ })).toHaveCount(30);
            await expect(project.getByLabel("메시지 입력")).toHaveValue("목록을 바꿔도 보존할 초안");
            const timestamps = await list.getByTestId("session-updated").evaluateAll((nodes) => nodes.map((node) => {
                const box = node.getBoundingClientRect();
                const row = node.closest("li")!.getBoundingClientRect();
                return { right: box.right, rowRight: row.right, textAlign: getComputedStyle(node).textAlign };
            }));
            expect(timestamps.every((time) => Math.abs(time.right - timestamps[0]!.right) <= 1)).toBe(true);
            expect(timestamps.every((time) => time.textAlign === "end" && time.rowRight - time.right <= 16)).toBe(true);
            const geometry = await project.evaluate((node) => {
                const pane = node.closest<HTMLElement>('[data-testid="pane-body"]')!;
                const box = pane.getBoundingClientRect();
                return {
                    width: pane.clientWidth, scroll: pane.scrollWidth,
                    overflow: [...node.querySelectorAll<HTMLElement>("*")].filter((child) => {
                        const bounds = child.getBoundingClientRect();
                        return bounds.width > 0 && bounds.right > box.right + 1;
                    }).slice(0, 8).map((child) => {
                        const style = getComputedStyle(child);
                        return { tag: child.tagName, className: child.className, width: child.getBoundingClientRect().width,
                            minWidth: style.minWidth, flex: style.flex, overflowX: style.overflowX };
                    }),
                };
            });
            await page.screenshot({ path: info.outputPath(`conversation-list-${width}.png`) });
            expect(geometry.scroll, JSON.stringify(geometry)).toBeLessThanOrEqual(geometry.width);
            await list.getByRole("button", { name: /목록 확인 30$/ }).click();
            await expect(page.getByTestId("session-view").filter({ visible: true })).toBeVisible();
        });
    });
}
