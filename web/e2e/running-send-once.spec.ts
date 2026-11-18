import { expect, test, type Locator, type Page } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { apiCall, ensureProfile, login, runningSendMode, script, sessionView, state } from "./helpers";

async function hold(page: Page, button: Locator, cancel = false) {
    const client = await page.context().newCDPSession(page);
    const bounds = (await button.boundingBox())!;
    await client.send("Input.dispatchTouchEvent", {
        type: "touchStart", touchPoints: [{ x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 }],
    });
    if (cancel) {
        await client.send("Input.dispatchTouchEvent", { type: "touchCancel", touchPoints: [] });
    } else {
        await expect(page.getByRole("menu")).toBeVisible();
        await client.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    }
    await client.detach();
}

async function expectContextMenuDefault(page: Page, target: Locator, prevented: boolean, offsetX = 0) {
    await target.evaluate((element) => {
        element.removeAttribute("data-context-prevented");
        element.removeAttribute("data-context-on-disabled");
        document.addEventListener("contextmenu", (event) => {
            element.setAttribute("data-context-prevented", String(event.defaultPrevented));
            const disabled = event.target instanceof Element && !!event.target.closest("button:disabled");
            element.setAttribute("data-context-on-disabled", String(disabled));
        }, { once: true });
    });
    const bounds = (await target.boundingBox())!;
    await page.mouse.click(bounds.x + bounds.width / 2 + offsetX, bounds.y + bounds.height / 2, { button: "right" });
    await expect(target).toHaveAttribute("data-context-prevented", String(prevented));
    // Chrome이 비활성 버튼으로 우클릭 이벤트를 보내는 데 의존하지 않는다.
    await expect(target).toHaveAttribute("data-context-on-disabled", "false");
}

for (const width of [390, 1280]) {
    test.describe(`${width}px 이번만 보내기`, () => {
        test.use({ viewport: { width, height: 900 }, isMobile: width === 390, hasTouch: width === 390 });
        test("길게 누르기·우클릭은 기본 설정을 바꾸지 않고 한 번만 다른 방식으로 보낸다", async ({ page }, info) => {
            const profile = await ensureProfile();
            const title = `send-once-${width}-${Date.now()}`;
            const project = await apiCall<{ id: string; name: string }>("POST", "/projects", {
                root_path: mkdtempSync(join(state().projA, "send-once-")),
            });
            const session = await apiCall<{ id: string }>("POST", `/projects/${project.id}/sessions`, { title });
            await apiCall("POST", "/recent/touch", { kind: "session", project_id: project.id, resource_id: session.id });
            await login(page);
            if (width === 390) await page.getByRole("button", { name: "사이드바", exact: true }).click();
            await page.getByRole("region", { name: "최근", exact: true }).getByRole("button", { name: new RegExp(title) }).click();
            if (width === 390) await expect(page.getByTestId("mobile-drawer-left")).toHaveJSProperty("open", false);
            const view = sessionView(page, session.id);
            const input = view.getByLabel("메시지 입력");
            const menu = page.getByRole("menu");
            const sent: { kind: string; text: string }[] = [];
            page.on("request", (request) => {
                if (request.method() === "POST" && request.url().endsWith(`/sessions/${session.id}/followups`)) sent.push(request.postDataJSON());
            });
            const idleButton = view.getByRole("button", { name: "보내기", exact: true });
            await expect(idleButton).toBeDisabled();
            await expectContextMenuDefault(page, idleButton, true);
            await expectContextMenuDefault(page, idleButton, true, 10);
            await expect(menu).toBeHidden();
            await expectContextMenuDefault(page, input, false);
            await script({ frames: [], hang: true, marker: `start-${title}` });
            const active = await apiCall<{ turn: { id: string } }>("POST", `/sessions/${session.id}/turns`, {
                text: `start-${title}`, profile_id: profile, tools: false,
            });
            try {
                const emptyButton = view.getByRole("button", { name: "합치기", exact: true });
                await expect(emptyButton).toBeDisabled();
                await expectContextMenuDefault(page, emptyButton, true);
                await expect(menu).toBeHidden();
                expect(sent).toHaveLength(0);
                const openMenu = async (label: string) => {
                    const button = view.getByRole("button", { name: label, exact: true });
                    await expect(button).toBeEnabled();
                    if (width === 390) await hold(page, button);
                    else await expectContextMenuDefault(page, button, true);
                    await expect(menu).toBeVisible();
                };
                await input.fill("취소해도 남는 입력");
                if (width === 390) {
                    await hold(page, emptyButton, true);
                    await expect(menu).toBeHidden();
                    expect(sent).toHaveLength(0);
                }
                await openMenu("합치기");
                await expect(menu.getByRole("menuitem", { name: "합치기", exact: true })).toBeDisabled();
                await page.screenshot({ path: info.outputPath(`send-once-menu-${width}.png`) });
                await page.keyboard.press("Escape");
                await expect(menu).toBeHidden();
                await expect(input).toHaveValue("취소해도 남는 입력");
                expect(sent).toHaveLength(0);

                const cases = [
                    { setting: "queue", label: "대기열", once: "steer", choice: "합치기" },
                    { setting: "interrupt", label: "중단 후 전송", once: "queue", choice: "대기열" },
                    { setting: "steer", label: "합치기", once: "interrupt", choice: "중단 후 전송" },
                ] as const;
                for (const [index, item] of cases.entries()) {
                    await runningSendMode(page, item.setting);
                    const text = `${item.once}-${title}`;
                    await input.fill(text);
                    await openMenu(item.label);
                    await expect(menu.getByRole("menuitem", { name: item.label, exact: true })).toBeDisabled();
                    for (const other of ["대기열", "합치기", "중단 후 전송"].filter((choice) => choice !== item.label)) {
                        await expect(menu.getByRole("menuitem", { name: other, exact: true })).toBeEnabled();
                    }
                    const count = sent.length;
                    // 누르기를 놓거나 메뉴를 열기만 해서는 보내지 않는다.
                    expect(count).toBe([0, 2, 3][index]);
                    if (item.once === "interrupt") await script({ frames: [], hang: true, marker: text });
                    const response = page.waitForResponse((response) => response.request().method() === "POST"
                        && response.url().endsWith(`/sessions/${session.id}/followups`));
                    await menu.getByRole("menuitem", { name: item.choice, exact: true }).click();
                    expect((await response).status()).toBe(201);
                    await expect(input).toHaveValue("");
                    expect(sent).toHaveLength(count + 1);
                    expect(sent[count]).toMatchObject({ kind: item.once, text });
                    await expect(menu).toBeHidden();
                    expect(await page.evaluate(() => JSON.parse(localStorage.getItem("grove.device.prefs")!).runningSendMode)).toBe(item.setting);
                    await expect(view.getByRole("button", { name: item.label, exact: true })).toBeVisible();
                    if (item.once === "steer") {
                        await input.fill(`default-${title}`);
                        const response = page.waitForResponse((response) => response.request().method() === "POST"
                            && response.url().endsWith(`/sessions/${session.id}/followups`));
                        const button = view.getByRole("button", { name: item.label, exact: true });
                        if (width === 390) await button.tap();
                        else await button.click();
                        expect((await response).status()).toBe(201);
                        await expect(input).toHaveValue("");
                        expect(sent.at(-1)?.kind).toBe("queue");
                    }
                }
                await expect.poll(async () => (await apiCall<{ status: string }>("GET", `/turns/${active.turn.id}`)).status).toBe("cancelled");
                await expect(view.getByTestId("msg-user").filter({ hasText: `interrupt-${title}` })).toHaveCount(1);
                page.once("dialog", (dialog) => dialog.accept());
                await view.getByTestId("turn-status").getByRole("button", { name: "취소", exact: true }).click();
            } finally {
                const turn = await apiCall<{ status: string }>("GET", `/turns/${active.turn.id}`);
                if (!["completed", "failed", "cancelled", "interrupted"].includes(turn.status)) {
                    await apiCall("POST", `/turns/${active.turn.id}/cancel`);
                }
            }
        });
    });
}
