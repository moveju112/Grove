import { expect, test } from "@playwright/test";
import { audit } from "./a11y-audit";
import { frames } from "./fixture";
import { apiCall, ensureProfile, ensureProjects, login, script, sessionView } from "./helpers";

for (const width of [390, 1280]) {
    for (const theme of ["light", "dark"] as const) {
        test.describe(`${width}px ${theme} 입력창 상태줄`, () => {
            test.use({ viewport: { width, height: 844 }, isMobile: width === 390, hasTouch: width === 390 });

            test("상태·시간·취소가 카드 안에 모이고 상세·새로고침·취소 후 입력을 유지한다", async ({ page }, info) => {
                await page.emulateMedia({ colorScheme: theme, reducedMotion: width === 390 ? "reduce" : "no-preference" });
                await page.addInitScript((theme) => localStorage.setItem("grove.device.prefs", JSON.stringify({ theme })), theme);
                const profile = await ensureProfile();
                const { a } = await ensureProjects();
                const title = `상태줄 ${width} ${theme}`;
                const session = await apiCall<{ id: string }>("POST", `/projects/${a.id}/sessions`, { title });
                await apiCall("POST", "/recent/touch", { kind: "session", project_id: a.id, resource_id: session.id });
                await login(page);
                if (width === 390) await page.getByRole("button", { name: "사이드바", exact: true }).click();
                await page.getByRole("region", { name: "최근", exact: true }).getByRole("button", { name: title, exact: true }).click();
                const view = sessionView(page, session.id);
                const composer = view.getByTestId("composer");
                const status = composer.getByTestId("turn-status");
                const input = composer.getByLabel("메시지 입력", { exact: true });
                await expect(view.getByTestId("turn-status")).toHaveCount(0);
                await script({ frames: frames.text(["상태줄을 확인하는 동안 실행 중인 응답이에요."]).slice(0, 1), hang: true, marker: title });
                const active = await apiCall<{ turn: { id: string } }>("POST", `/sessions/${session.id}/turns`, { text: title, profile_id: profile, tools: false });
                try {
                    await expect(status.getByRole("status").filter({ hasText: "실행 중" })).toBeVisible();
                    await expect(status.getByTestId("turn-timing")).toHaveAttribute("data-running", "true");
                    await expect(status.getByTestId("turn-timing")).not.toContainText("경과");
                    await expect(view.getByTestId("turn-status")).toHaveCount(1);
                    await input.fill("취소해도 보존할 다음 메시지");
                    for (const height of [844, 460, 844]) {
                        await page.setViewportSize({ width, height });
                        await expect.poll(() => status.evaluate((node) => {
                            const card = node.closest<HTMLElement>('[data-testid="composer"]')!;
                            const row = node.getBoundingClientRect();
                            const box = card.getBoundingClientRect();
                            const cancel = node.querySelector<HTMLButtonElement>('button[aria-label="취소"]')!;
                            const action = cancel.getBoundingClientRect();
                            const label = node.querySelector<HTMLElement>('[role="status"]')!.getBoundingClientRect();
                            const timing = node.querySelector<HTMLElement>('[data-testid="turn-timing"]')!.getBoundingClientRect();
                            const input = card.querySelector("textarea")!.getBoundingClientRect();
                            const style = getComputedStyle(node);
                            return {
                                separator: style.borderBottomStyle === "solid" && parseFloat(style.borderBottomWidth) === 1,
                                inside: row.top >= box.top && row.bottom <= input.top && row.left >= box.left && row.right <= box.right,
                                oneLine: Math.abs(label.y + label.height / 2 - timing.y - timing.height / 2) <= 2,
                                target: action.height >= 32 && action.width >= 32,
                                visible: action.left >= 0 && action.right <= innerWidth && action.top >= 0 && action.bottom <= innerHeight,
                                clickable: document.elementFromPoint(action.x + action.width / 2, action.y + action.height / 2)?.closest("button") === cancel,
                                noOverflow: card.scrollWidth <= card.clientWidth + 1 && document.documentElement.scrollWidth <= innerWidth,
                            };
                        })).toEqual({ separator: true, inside: true, oneLine: true, target: true, visible: true, clickable: true, noOverflow: true });
                    }
                    const accessibility = await audit(page, { touch: width === 390 });
                    expect(accessibility.contrast).toEqual([]);
                    expect(accessibility.unnamed).toEqual([]);
                    expect(accessibility.small).toEqual([]);
                    await page.screenshot({ path: info.outputPath(`composer-running-${width}-${theme}.png`) });
                    await status.getByRole("button", { name: "요청 시간 상세", exact: true }).click();
                    await expect(page.getByRole("dialog", { name: "요청 시간 상세", exact: true })).toContainText("총 경과");
                    await page.keyboard.press("Escape");
                    await expect(status.getByRole("button", { name: "요청 시간 상세", exact: true })).toBeFocused();
                    await expect(input).toHaveValue("취소해도 보존할 다음 메시지");
                    await page.reload();
                    await expect(status.getByRole("status").filter({ hasText: "실행 중" })).toBeVisible();
                    await input.fill("취소해도 보존할 다음 메시지");
                    await status.getByRole("button", { name: "취소", exact: true }).click();
                    await expect.poll(async () => (await apiCall<{ status: string }>("GET", `/turns/${active.turn.id}`)).status).toBe("cancelled");
                    await expect(view.getByTestId("turn-status")).toHaveCount(0);
                    await expect(input).toHaveValue("취소해도 보존할 다음 메시지");
                    await expect(composer.getByRole("button", { name: "보내기", exact: true })).toBeEnabled();
                    const done = `${title} 완료`;
                    await script({ marker: done, frames: frames.text(["완료됐어요."]) });
                    await input.fill(done);
                    await composer.getByRole("button", { name: "보내기", exact: true }).click();
                    await expect(view.getByTestId("msg-assistant").filter({ hasText: "완료됐어요." })).toBeVisible();
                    await expect(view.getByTestId("turn-status")).toHaveCount(0);
                    await expect(view.getByTestId("turn-timing")).toContainText("소요 시간");
                } finally {
                    const turn = await apiCall<{ status: string }>("GET", `/turns/${active.turn.id}`);
                    if (["queued", "running", "awaiting_approval"].includes(turn.status)) await apiCall("POST", `/turns/${active.turn.id}/cancel`);
                }
            });
        });
    }
}
