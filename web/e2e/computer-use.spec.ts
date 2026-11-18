import { expect, test } from "@playwright/test";
import type { ToolCallRow } from "../app/api/generated";
import { apiCall, closeMobileSidebar, ensureProjects, login, sessionView } from "./helpers";

test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

for (const theme of ["light", "dark"] as const) {
    test(`390px ${theme}: PC 제어는 짧은 안내와 대화 승인을 표시하고 거부하면 실행하지 않는다`, async ({ page }, info) => {
        await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
        const effective = await apiCall<{ items: { key: string; layers: { server?: { revision: number } } }[] }>("GET", "/settings/effective");
        const revision = effective.items.find((i) => i.key === "computer.enabled")?.layers.server?.revision ?? 0;
        await apiCall("PUT", "/settings/server/-/computer.enabled", { expected_revision: revision, value: true });
        const { a } = await ensureProjects();
        const title = `PC 제어 ${theme}`;
        const session = await apiCall<{ id: string }>("POST", `/projects/${a.id}/sessions`, { title });
        const call = await apiCall<ToolCallRow>("POST", `/sessions/${session.id}/tool-requests`, {
            name: "computer", args: { target: "server", action: "act", window_id: "42", frame_id: "test-only-frame",
                actions: [{ type: "click", x: 10, y: 20 }, { type: "type", text: "input-not-shown" }] },
        });
        try {
            await apiCall("POST", "/recent/touch", { kind: "session", project_id: a.id, resource_id: session.id });
            await login(page);
            await page.getByRole("button", { name: "사이드바", exact: true }).click();
            await page.getByRole("region", { name: "최근", exact: true }).getByRole("button", { name: new RegExp(`^${title}`) }).click();
            await closeMobileSidebar(page);
            const view = sessionView(page, session.id);
            const card = view.getByTestId("approval");
            await expect(card).toContainText("서버 PC 화면 공유·조작을 이 대화에서 계속 허용합니다.");
            for (const text of ["대상 창", "관찰 화면", "10, 20", "부작용", "비밀값 보호", "· revision"]) {
                await expect(card).not.toContainText(text);
            }
            await expect(card).not.toContainText("input-not-shown");
            await expect(card.getByRole("button", { name: "이번만 승인", exact: true })).toBeVisible();
            await expect(card.getByRole("button", { name: "이 대화에서 승인", exact: true })).toBeVisible();
            expect(await card.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
            const approval = (await card.boundingBox())!;
            const composer = (await view.getByTestId("composer").boundingBox())!;
            expect(approval.height).toBeLessThan(220);
            expect(approval.x).toBeCloseTo(composer.x, 0);
            expect(approval.width).toBeCloseTo(composer.width, 0);
            await page.screenshot({ path: info.outputPath(`computer-approval-${theme}-390.png`) });
            await card.getByRole("button", { name: "거부", exact: true }).click();
            await expect.poll(async () => (await apiCall<ToolCallRow>("GET", `/tool-calls/${call.id}`)).status).toBe("denied");
        } finally {
            await apiCall("PUT", "/settings/server/-/computer.enabled", { expected_revision: revision + 1, value: false });
        }
    });
}
