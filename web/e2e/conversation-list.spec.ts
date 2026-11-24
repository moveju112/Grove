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
            const longTitle = "작은 화면에서 대화 기록의 긴 제목과 본문 미리보기를 함께 읽을 때 줄바꿈 확인";
            for (let i = 0; i < 31; i++) {
                const session = await apiCall<{ id: string }>("POST", `/projects/${a.id}/sessions`, { title: i === 30 ? longTitle : `목록 확인 ${i}` });
                if (i === 30) await apiCall("POST", `/sessions/${session.id}/messages`, { text: "모바일 기록에서 긴 대화의 제목과 본문을 편하게 읽을 수 있도록 화면을 정리해 줘. ".repeat(12) });
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
                const row = page.getByTestId("project-row").filter({ hasText: a.name });
                if (width === 390) await row.getByRole("button", { name: "프로젝트 메뉴", exact: true }).click();
                else await row.getByRole("button", { name: a.name, exact: true }).click({ button: "right" });
                await page.getByRole("dialog", { name: `${a.name} 메뉴`, exact: true }).getByRole("button", { name: "기록", exact: true }).click();
            };
            await openHistory();
            const list = page.getByRole("dialog", { name: `${a.name} 기록`, exact: true });
            await expect(project.getByRole("searchbox")).toHaveCount(0);
            await expect(page.getByTestId("search-panel")).toHaveCount(0);
            await expect(list.getByRole("button", { name: /목록 확인 \d+$|줄바꿈 확인$/ })).toHaveCount(30);
            await list.getByRole("button", { name: "더 보기", exact: true }).click();
            await expect(list.getByRole("button", { name: /목록 확인 \d+$|줄바꿈 확인$/ })).toHaveCount(31);
            const oldest = list.getByRole("listitem").filter({ has: page.getByRole("button", { name: "목록 확인 0", exact: true }) });
            const titles = list.getByRole("button", { name: /목록 확인 \d+$|줄바꿈 확인$/ });
            await oldest.getByRole("button", { name: "상단 고정", exact: true }).click();
            await expect(titles.first()).toHaveText("목록 확인 0");
            await expect(titles).toHaveCount(31);
            await list.getByRole(width === 390 ? "tab" : "button", { name: "보관된 대화", exact: true }).click();
            await expect(list.getByRole("button", { name: "보관된 대화 확인", exact: true })).toBeVisible();
            await expect(list.getByRole("button", { name: /목록 확인 \d+$|줄바꿈 확인$/ })).toHaveCount(0);
            await list.getByRole(width === 390 ? "tab" : "button", { name: width === 390 ? "대화" : "보관된 대화", exact: true }).click();
            await expect(list.getByRole("button", { name: /목록 확인 \d+$|줄바꿈 확인$/ })).toHaveCount(30);
            await expect(project.getByLabel("메시지 입력")).toHaveValue("기록을 열어도 보존할 초안");
            const row = list.getByRole("listitem").filter({ has: page.getByRole("button", { name: new RegExp(longTitle + "$") }) });
            const toggle = row.getByRole("button", { name: /미리보기 (펼치기|접기)$/ });
            const preview = row.getByText(/^모바일 기록에서/);
            await expect(oldest.getByRole("button", { name: /미리보기/ })).toHaveCount(0);
            await expect(toggle).toHaveAttribute("aria-expanded", "false");
            await expect(preview).toBeHidden();
            await toggle.focus();
            await toggle.press("Enter");
            await expect(toggle).toHaveAttribute("aria-expanded", "true");
            await expect(preview).toBeVisible();
            const title = await row.getByText(longTitle, { exact: false }).filter({ visible: true }).last().boundingBox();
            const body = await preview.boundingBox();
            expect(body!.y).toBeGreaterThan(title!.y + title!.height);
            expect(body!.x).toBeGreaterThan(title!.x);
            if (width === 390) {
                const shortTitle = await list.getByText("목록 확인 29", { exact: true }).boundingBox();
                expect(Math.abs(shortTitle!.x - title!.x)).toBeLessThan(2);
                expect(body!.width).toBeGreaterThan(width * 0.7);
                expect(title!.width).toBeGreaterThan(width * 0.7);
            } else {
                const timestamps = await list.getByTestId("session-updated").evaluateAll((nodes) => nodes.map((node) => node.getBoundingClientRect().right));
                expect(timestamps.every((right) => Math.abs(right - timestamps[0]!) <= 1)).toBe(true);
                const pin = await row.getByRole("button", { name: "상단 고정", exact: true }).boundingBox();
                const time = await row.getByTestId("session-updated").boundingBox();
                expect(pin!.x).toBeGreaterThanOrEqual(time!.x + time!.width);
            }
            const geometry = await list.evaluate((node) => {
                const box = node.getBoundingClientRect();
                return { left: box.left, right: box.right, width: node.clientWidth, scroll: node.scrollWidth };
            });
            await page.screenshot({ path: info.outputPath(`conversation-list-${width}.png`) });
            expect(geometry.left).toBeGreaterThanOrEqual(0);
            expect(geometry.right).toBeLessThanOrEqual(width);
            expect(geometry.scroll).toBeLessThanOrEqual(geometry.width);
            await toggle.click();
            await expect(preview).toBeHidden();
            await expect(toggle).toHaveAttribute("aria-expanded", "false");
            await page.keyboard.press("Escape");
            await expect(list).toBeHidden();
            const trigger = page.getByTestId("project-row").filter({ hasText: a.name }).getByRole("button", { name: "프로젝트 메뉴", exact: true });
            await expect(trigger).toBeFocused();
            if (width === 390) await closeMobileSidebar(page);
            await expect(project.getByLabel("메시지 입력")).toHaveValue("기록을 열어도 보존할 초안");
            await openHistory();
            await expect(titles.first()).toHaveText("목록 확인 0");
            await oldest.getByRole("button", { name: "상단 고정 해제", exact: true }).click();
            await expect(oldest).toHaveCount(0);
            await list.getByRole("button", { name: new RegExp(longTitle + "$") }).click();
            await expect(page.getByTestId("session-view").filter({ visible: true })).toBeVisible();
            await expect(list).toBeHidden();
            if (width === 390) await expect(page.getByTestId("mobile-drawer-left")).toHaveJSProperty("open", false);
        });
    });
}
