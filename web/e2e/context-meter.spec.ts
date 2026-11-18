import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { apiCall, closeMobileSidebar, ensureProjects, login, openContext, sessionView, state } from "./helpers";

test.skip(process.env.GROVE_E2E_FAKE_CLI !== "1", "전용 CLI fixture로 검사");

for (const width of [390, 1280]) {
    for (const protocol of ["codex_cli", "claude_code"]) {
        test(`${protocol} ${width}px 컨텍스트가 실제 점유량으로 채워지고 재접속·감소·미확인을 반영한다`, async ({ page }, info) => {
            await page.setViewportSize({ width, height: 844 });
            const { a } = await ensureProjects();
            const profile = await apiCall<{ id: string }>("POST", "/model-profiles", { name: `context-${protocol}-${width}`, protocol, base_url: "", model: "default" });
            const title = `context-${protocol}-${width}-${randomUUID()}`;
            const session = await apiCall<{ id: string }>("POST", `/projects/${a.id}/sessions`, { title });
            const send = (value: string, extra = "") => apiCall<{ turn: { id: string } }>("POST", `/sessions/${session.id}/turns`, {
                text: `fixture-context-${value} ${extra}`, profile_id: profile.id, tools: false,
            });
            const complete = async (id: string) => expect.poll(async () => (await apiCall<{ status: string }>("GET", `/turns/${id}`)).status).toBe("completed");
            let held: string | undefined;
            let release: string | undefined;
            try {
                await complete((await send("25")).turn.id);
                await apiCall("POST", "/recent/touch", { kind: "session", project_id: a.id, resource_id: session.id });
                await login(page);
                const sidebar = page.getByRole("button", { name: "사이드바", exact: true });
                if (await sidebar.getAttribute("aria-expanded") === "false") await sidebar.click();
                await page.getByRole("region", { name: "최근", exact: true }).getByRole("button", { name: new RegExp(title) }).click();
                if (width === 390) await closeMobileSidebar(page);
                const view = sessionView(page, session.id);
                const meter = view.getByRole("button", { name: "context 사용량", exact: true });
                const fill = meter.locator("circle[pathLength]");
                await expect(fill).toHaveAttribute("stroke-dasharray", "25 75");
                const details = await openContext(view);
                await expect(details).toContainText("25%");
                await expect(details).toContainText("CLI 보고값");
                await expect(page.getByRole("dialog", { name: "context 사용량", exact: true })).toHaveCSS("opacity", "1");
                await page.screenshot({ path: info.outputPath(`context-${protocol}-${width}.png`) });
                await page.keyboard.press("Escape");
                await page.reload();
                await expect(fill).toHaveAttribute("stroke-dasharray", "25 75");

                if (protocol === "codex_cli") {
                    const marker = randomUUID();
                    release = join(state().cliDir!, `followup-release-${marker}`);
                    held = (await send("75", `fixture-followup-${marker}`)).turn.id;
                    await expect(fill).toHaveAttribute("stroke-dasharray", "75 25");
                    await page.reload();
                    await expect(fill).toHaveAttribute("stroke-dasharray", "75 25");
                    writeFileSync(release, "");
                    await complete(held);
                    held = undefined;
                    await expect(fill).toHaveAttribute("stroke-dasharray", "75 25");
                }
                await complete((await send("5")).turn.id);
                await expect(fill).toHaveAttribute("stroke-dasharray", "5 95");
                await complete((await send("125")).turn.id);
                await expect(fill).toHaveAttribute("stroke-dasharray", "100 0");
                await complete((await send("0")).turn.id);
                await expect(fill).toHaveCount(0);
                await expect(meter).toHaveAttribute("aria-description", /0%/);
                await complete((await send("unknown")).turn.id);
                await expect(fill).toHaveCount(0);
                await expect(meter).toHaveAttribute("aria-description", /컨텍스트 한도 미확인/);
                const usage = await apiCall<{ tokens: number; context_window: number | null }>("GET", `/sessions/${session.id}/context?profile_id=${profile.id}`);
                expect(usage).toMatchObject({ tokens: 10_000, context_window: null });
            } finally {
                if (release) writeFileSync(release, "");
                if (held) await apiCall("POST", `/turns/${held}/cancel`);
                await apiCall("DELETE", `/model-profiles/${profile.id}`);
            }
        });
    }
}
