import { expect, test } from "@playwright/test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { apiCall, ensureProjects, login, openDetails, sessionView, state } from "./helpers";

test.skip(process.env.GROVE_E2E_FAKE_CLI !== "1", "GROVE_E2E_FAKE_CLI=1로 실행");

for (const width of [390, 1400]) {
    for (const legacyMode of ["hidden", "expanded"] as const) {
        test(`${width}px 기존 ${legacyMode}: 진행 설명의 실제 경계를 순서 번호로 구분한다`, async ({ page }, info) => {
            await page.setViewportSize({ width, height: 844 });
            await page.emulateMedia({ reducedMotion: "reduce" });
            await page.addInitScript((reasoning) => localStorage.setItem("grove.device.prefs", JSON.stringify({ reasoning })), legacyMode);
            const { a } = await ensureProjects();
            const profile = await apiCall<{ id: string }>("POST", "/agent-backends/codex_cli/connect");
            const title = `진행 순서 ${width} ${legacyMode}`;
            const session = await apiCall<{ id: string }>("POST", `/projects/${a.id}/sessions`, { title });
            await apiCall("POST", "/recent/touch", { kind: "session", project_id: a.id, resource_id: session.id });
            await login(page);
            const sidebar = page.getByRole("button", { name: "사이드바", exact: true });
            if (await sidebar.getAttribute("aria-expanded") !== "true") await sidebar.click();
            await page.getByRole("region", { name: "최근", exact: true }).getByRole("button", { name: new RegExp(title) }).click();
            const view = sessionView(page, session.id);
            const accepted = await apiCall<{ turn: { id: string } }>("POST", `/sessions/${session.id}/turns`, {
                profile_id: profile.id, text: "fixture-progress-numbering", tools: false,
            });
            try {
                await expect(view.getByTestId("partial")).toBeVisible();
                const pid = Number(readFileSync(join(state().cliDir!, "last-pid"), "utf8"));
                await expect.poll(() => existsSync(join(state().cliDir!, `progress-numbering-ready-${pid}`))).toBe(true);
                const live = view.getByTestId("partial-progress").getByRole("list", { name: "진행 설명 순서" });
                await expect(live.getByTestId("progress-step")).toHaveCount(4);
                await expect(live.getByTestId("progress-step").nth(0)).toContainText("연결 설정을 확인할게.");
                await expect(live.getByTestId("progress-step").nth(0).getByRole("paragraph")).toHaveCount(2);
                await expect(live.getByTestId("progress-step").nth(2).getByTestId("md-code")).toContainText("check: ok");
                await expect(view.getByTestId("partial-answer")).toHaveCount(0);
                writeFileSync(join(state().cliDir!, `progress-numbering-release-${pid}`), "");
                const answer = view.getByTestId("msg-assistant").last();
                await expect(answer.getByTestId("msg-answer")).toContainText("설정을 마쳤어.");
                await openDetails(answer.getByTestId("msg-progress"));
                const list = page.getByRole("list", { name: "진행 설명 순서" }).filter({ visible: true });
                await expect(list.getByTestId("progress-step")).toHaveCount(4);
                await expect(list).not.toContainText("설정을 마쳤어.");
                await page.screenshot({ path: info.outputPath(`progress-${width}-${legacyMode}.png`), animations: "disabled" });
                const numbered = await list.getByTestId("progress-step").evaluateAll((items) => items.map((item) => {
                    // 공용 List는 native marker 대신 CSS counter를 그린다.
                    const marker = [...item.querySelectorAll("span")].find((node) => getComputedStyle(node, "::before").content.includes("counter("));
                    if (!marker) return false;
                    const bounds = marker.getBoundingClientRect();
                    return bounds.width > 0 && bounds.height > 0 && getComputedStyle(marker).visibility === "visible"
                        && getComputedStyle(item).counterIncrement.endsWith(" 1");
                }));
                expect(numbered).toEqual([true, true, true, true]);
                await page.keyboard.press("Escape");
                await page.reload();
                await expect(answer.getByTestId("msg-answer")).toContainText("설정을 마쳤어.");
                await openDetails(answer.getByTestId("msg-progress"));
                await expect(page.getByRole("list", { name: "진행 설명 순서" }).filter({ visible: true }).getByTestId("progress-step")).toHaveCount(4);
            } finally {
                const turn = await apiCall<{ status: string }>("GET", `/turns/${accepted.turn.id}`);
                if (["queued", "running", "awaiting_approval"].includes(turn.status)) {
                    await apiCall("POST", `/turns/${accepted.turn.id}/cancel`);
                }
            }
        });
    }
}
