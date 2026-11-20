import { expect, test } from "@playwright/test";
import { frames } from "./fixture";
import { apiCall, closeMobileSidebar, ensureProfile, ensureProjects, login, openContext, openTool, script, sessionView, toolTrigger } from "./helpers";

for (const width of [390, 1400]) {
    test.describe(`${width}px 대화 헤더`, () => {
        test.use({ viewport: { width, height: 844 }, isMobile: width === 390, hasTouch: width === 390 });

        test("상단 메뉴·에이전트 표시 없이 보내기 옆 context를 호버·터치·키보드로 연다", async ({ page }, info) => {
            const { a } = await ensureProjects();
            const profile = await ensureProfile();
            const title = `session-header-${width}-${Date.now()}`;
            const session = await apiCall<{ id: string }>("POST", `/projects/${a.id}/sessions`, { title });
            await script({ frames: frames.text(["헤더 확인 응답"]), marker: title });
            const started = await apiCall<{ turn: { id: string } }>("POST", `/sessions/${session.id}/turns`, {
                text: title, profile_id: profile, agent_id: "worker", tools: false,
            });
            await expect.poll(async () => {
                const turn = await apiCall<{ status: string; agent_id: string }>("GET", `/turns/${started.turn.id}`);
                return { status: turn.status, agent: turn.agent_id };
            }).toEqual({ status: "completed", agent: "worker" });
            await apiCall("POST", "/recent/touch", { kind: "session", project_id: a.id, resource_id: session.id });
            await login(page);
            if (width === 390) await page.getByRole("button", { name: "사이드바", exact: true }).click();
            await page.getByRole("region", { name: "최근", exact: true }).getByRole("button", { name: new RegExp(title) }).click();
            if (width === 390) await closeMobileSidebar(page);
            const view = sessionView(page, session.id);
            await expect(view.getByRole("heading", { name: title, exact: true })).toHaveCount(0);
            await expect(view.getByRole("button", { name: title, exact: true })).toHaveCount(0);
            await expect(view.getByTestId("msg-assistant")).toContainText("헤더 확인 응답");
            await expect(view.locator("header").getByText("에이전트: worker", { exact: true })).toHaveCount(0);
            await expect(view.getByRole("button", { name: "대화 작업", exact: true })).toHaveCount(0);
            await expect(toolTrigger(view)).toBeVisible();
            const trigger = view.getByRole("button", { name: "context 사용량", exact: true });
            const context = page.getByRole("dialog", { name: "context 사용량", exact: true });
            await expect(trigger).toBeVisible();
            await expect(context).toBeHidden();
            const ring = (await trigger.boundingBox())!;
            const send = (await view.getByRole("button", { name: "보내기", exact: true }).boundingBox())!;
            expect(ring.x + ring.width).toBeLessThanOrEqual(send.x);
            expect(Math.abs(ring.y + ring.height / 2 - send.y - send.height / 2)).toBeLessThanOrEqual(1);
            if (width === 390) await trigger.tap();
            else await trigger.hover();
            await expect(context.getByRole("button", { name: "압축", exact: true })).toBeEnabled();
            await expect(context).toHaveCSS("opacity", "1");
            await page.screenshot({ path: info.outputPath(`session-header-${width}.png`) });
            await page.keyboard.press("Escape");
            await expect(context).toBeHidden();
            await view.getByLabel("메시지 입력").focus();
            await trigger.focus();
            await expect(context).toBeVisible();
            await trigger.press("Tab");
            await expect(context.getByRole("button", { name: "압축", exact: true })).toBeFocused();
            await page.keyboard.press("Escape");
            await openTool(view, "대화");
            await expect(view.getByRole("combobox", { name: "워크플로우", exact: true })).toBeVisible();
            await expect(view.getByRole("button", { name: "분기", exact: true })).toBeVisible();
            const renamed = `${title} 이름 변경`;
            page.once("dialog", (dialog) => dialog.accept(renamed));
            await view.getByRole("button", { name: "이름 바꾸기", exact: true }).click();
            await expect.poll(async () => (await apiCall<{ title: string }>("GET", `/sessions/${session.id}`)).title).toBe(renamed);
            if (width > 760) await expect(page.getByTestId("tab-title").filter({ visible: true })).toContainText([renamed]);
            await view.getByRole("button", { name: "도구 패널 닫기", exact: true }).click();
            expect(await apiCall<unknown[]>("GET", `/sessions/${session.id}/turns`)).toHaveLength(1);

            const marker = `running-${title}`;
            await script({ frames: [], hang: true, marker });
            const active = await apiCall<{ turn: { id: string } }>("POST", `/sessions/${session.id}/turns`, {
                text: marker, profile_id: profile, tools: false,
            });
            try {
                await expect(view.getByTestId("turn-status")).toBeVisible();
                const busyContext = await openContext(view);
                await expect(busyContext.getByRole("button", { name: "압축", exact: true })).toBeDisabled();
            } finally {
                await apiCall("POST", `/turns/${active.turn.id}/cancel`);
            }
        });
    });
}
