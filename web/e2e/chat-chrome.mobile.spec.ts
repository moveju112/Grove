import { expect, test } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { dirname, join } from "node:path";
import { frames } from "./fixture";
import { apiCall, ensureProfile, login, script, sessionView, state, useWorkspaces } from "./helpers";

test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

for (const theme of ["light", "dark"] as const) {
    test(`${theme}: 긴 대화의 입력 영역은 하단·옆 여백까지 가리고 탐색 목록은 한 줄로 촘촘하게 표시한다`, async ({ page }, info) => {
        await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
        const root = mkdtempSync(join(dirname(state().projA), "000-chat-chrome-"));
        const project = await apiCall<{ id: string; name: string }>("POST", "/projects", { root_path: root });
        await useWorkspaces(project.id);
        const profile = await ensureProfile();
        const sessions: { id: string; title: string }[] = [];
        for (let i = 0; i < 12; i++) {
            const title = i % 2 ? `아주 긴 대화 제목도 한 줄을 유지하는 탐색 항목 ${i}` : `대화 ${i}`;
            const session = await apiCall<{ id: string; title: string }>("POST", `/projects/${project.id}/sessions`, { title });
            sessions.push(session);
            await apiCall("POST", "/recent/touch", { kind: "session", project_id: project.id, resource_id: session.id });
        }
        const session = sessions[0]!;
        for (let i = 0; i < 36; i++) {
            await apiCall("POST", `/sessions/${session.id}/messages`, { text: `가려져야 하는 본문 ${i}\n${"스크롤 중 입력 영역 뒤로 본문이 비치면 안 됩니다. ".repeat(4)}` });
        }
        const prompt = `footer-${theme}-${session.id}`;
        await script({ marker: prompt, frames: frames.text(["스크롤 아래에서도 보존되는 모델 응답\n".repeat(12)]) });
        const started = await apiCall<{ turn: { id: string } }>("POST", `/sessions/${session.id}/turns`, { text: prompt, profile_id: profile, tools: false });
        await expect.poll(async () => (await apiCall<{ status: string }>("GET", `/turns/${started.turn.id}`)).status).toBe("completed");

        const inboxRequests: string[] = [];
        page.on("request", (request) => {
            if (/\/api\/v1\/(?:notifications|recovery)(?:[/?]|$)/.test(request.url())) inboxRequests.push(request.url());
        });
        await login(page);
        await page.getByRole("button", { name: "사이드바", exact: true }).click();
        const sidebar = page.getByRole("complementary", { name: "탐색" });
        const tree = sidebar.locator(`[data-testid="sidebar-project"][data-project-id="${project.id}"]`);
        await expect(tree.getByTestId("sidebar-session")).toHaveCount(12);
        await tree.scrollIntoViewIfNeeded();
        await expect(tree).toBeInViewport();
        const rows = await tree.getByTestId("sidebar-session").evaluateAll((nodes) => nodes.map((node) => {
            const button = node.querySelector<HTMLElement>('[data-testid="sidebar-session-open"]')!;
            const title = node.querySelector<HTMLElement>('[data-testid="sidebar-session-title"]')!;
            const bounds = node.getBoundingClientRect();
            const style = getComputedStyle(button);
            return {
                height: bounds.height,
                font: parseFloat(style.fontSize),
                padding: parseFloat(style.paddingLeft),
                border: parseFloat(style.borderLeftWidth),
                inset: title.getBoundingClientRect().left - button.getBoundingClientRect().left,
                visible: bounds.top >= 0 && bounds.bottom <= innerHeight,
            };
        }));
        expect(rows.every((row) => row.height >= 32 && row.height <= 32.5), JSON.stringify(rows)).toBe(true);
        // spacing 토큰의 실제 값은 글자 크기를 따른다. 고정 px 대신 CSS 콘텐츠 시작점으로 왼쪽 정렬을 확인한다.
        expect(rows.every((row) => row.font <= 13 && Math.abs(row.inset - row.padding - row.border) <= 1), JSON.stringify(rows)).toBe(true);
        expect(rows.filter((row) => row.visible).length).toBeGreaterThanOrEqual(10);
        expect(await sidebar.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
        await expect(sidebar.getByTestId("notifications")).toHaveCount(0);
        await expect(sidebar.getByTestId("recovery")).toHaveCount(0);
        await page.screenshot({ path: info.outputPath(`sidebar-${theme}-390.png`) });
        await tree.locator(`[data-session="${session.id}"]`).getByTestId("sidebar-session-open").click();
        const view = sessionView(page, session.id);
        const pane = page.getByTestId("pane-body").filter({ has: view });
        const input = view.getByLabel("메시지 입력", { exact: true });
        await input.fill("화면 크기가 바뀌어도 보존할 초안");

        for (const height of [844, 620, 844]) {
            await page.setViewportSize({ width: 390, height });
            for (const fraction of [0.35, 0.7, 1]) {
                await pane.evaluate((node, fraction) => { node.scrollTop = (node.scrollHeight - node.clientHeight) * fraction; }, fraction);
                await expect.poll(() => view.evaluate((node) => {
                    const pane = node.closest('[data-testid="pane-body"]')!;
                    const footer = node.querySelector<HTMLElement>('[data-testid="compose-surface"]')!;
                    const edge = pane.getBoundingClientRect();
                    const box = footer.getBoundingClientRect();
                    const bottom = Math.min(edge.bottom, innerHeight);
                    const points = [edge.left + 2, (edge.left + edge.right) / 2, edge.right - 2];
                    const style = getComputedStyle(footer);
                    const pixel = document.createElement("canvas").getContext("2d")!;
                    pixel.fillStyle = style.backgroundColor;
                    pixel.fillRect(0, 0, 1, 1);
                    return {
                        bottomCovered: box.bottom >= bottom - 1,
                        sidesCovered: box.left <= edge.left + 1 && box.right >= edge.right - 1,
                        hitFooter: points.every((x) => document.elementFromPoint(x, bottom - 2)?.closest('[data-testid="compose-surface"]') === footer),
                        opaque: pixel.getImageData(0, 0, 1, 1).data[3] === 255 && style.opacity === "1",
                    };
                })).toEqual({ bottomCovered: true, sidesCovered: true, hitFooter: true, opaque: true });
            }
            await expect(input).toHaveValue("화면 크기가 바뀌어도 보존할 초안");
        }
        expect(inboxRequests).toEqual([]);
        await page.screenshot({ path: info.outputPath(`footer-${theme}-390.png`) });
    });
}
