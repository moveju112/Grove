import { expect, test, type Locator, type Page } from "@playwright/test";
import { apiCall, login, openSettings, state } from "./helpers";
import type { PairingInfo } from "../app/api/generated";

const password = "test-only!";

async function manage(page: Page): Promise<Locator> {
    await login(page);
    await openSettings(page);
    await page.getByRole("button", { name: "기기·연결", exact: true }).click();
    return page.getByRole("region", { name: "기기 페어링" });
}

async function issue(panel: Locator, name: string): Promise<string> {
    await panel.getByLabel("등록할 기기 이름", { exact: true }).fill(name);
    await panel.getByLabel("링크 비밀번호", { exact: true }).fill(password);
    await panel.getByRole("button", { name: "페어링 링크 발급", exact: true }).click();
    await expect(panel.getByRole("textbox", { name: "페어링 링크", exact: true })).toHaveValue(/#pairing=/);
    await expect(panel.getByTestId("pairing-qr")).toHaveAttribute("data-ready", "true");
    expect(await panel.getByLabel("링크 비밀번호", { exact: true }).inputValue()).toBe("");
    return panel.getByRole("textbox", { name: "페어링 링크", exact: true }).inputValue();
}

async function connect(page: Page, _name: string) {
    const form = page.getByRole("form", { name: "페어링 등록" });
    await expect(form.getByLabel("이 기기 이름")).toHaveCount(0);
    await form.getByRole("button", { name: "연결", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "연결 비밀번호" });
    await dialog.getByLabel("비밀번호", { exact: true }).fill(password);
    await dialog.getByRole("button", { name: "연결 요청", exact: true }).click();
    await expect(form.getByText("소유자 승인 대기 중", { exact: true })).toBeVisible();
    return form.locator(".pairing-code").innerText();
}

test("QR 등록은 비밀번호와 코드 대조 승인 뒤 한 기기에만 자격을 부여한다", async ({ page, browser }, info) => {
    const panel = await manage(page);
    const name = `QR 기기 ${Date.now()}`;
    await panel.getByLabel("등록할 기기 이름", { exact: true }).fill(name);
    const passwordInput = panel.getByLabel("링크 비밀번호", { exact: true });
    await expect(passwordInput).toHaveAttribute("minlength", "10");
    await expect(passwordInput).toHaveAttribute("placeholder", "10자 이상");
    await passwordInput.fill("123456789");
    await expect(panel.getByRole("button", { name: "페어링 링크 발급", exact: true })).toBeDisabled();
    const link = await issue(panel, name);
    expect(new URL(link).search).toBe("");
    expect(link).not.toContain(password);
    expect(link).not.toContain(state().token);
    const image = await panel.getByTestId("pairing-qr").screenshot();
    const device = await browser.newContext();
    const attacker = await browser.newContext();
    try {
        const other = await device.newPage();
        const requests: string[] = [];
        other.on("request", (request) => requests.push(request.url()));
        await other.goto(new URL(link).origin);
        await other.locator("html[data-hydrated=true]").waitFor();
        await other.getByRole("button", { name: "페어링 링크·QR로 등록" }).click();
        const form = other.getByRole("form", { name: "페어링 등록" });
        await form.getByRole("button", { name: "QR", exact: true }).click();
        await form.getByLabel("QR 사진 선택").setInputFiles({ name: "qr.png", mimeType: "image/png", buffer: image });
        await expect(form.getByRole("textbox", { name: "페어링 링크", exact: true })).toHaveCount(0);
        await expect(form.getByText("등록 대상:")).toContainText(new URL(link).origin);
        const code = await connect(other, name);
        const intruder = await attacker.newPage();
        await intruder.goto(link);
        const attackerCode = await connect(intruder, "다른 브라우저");
        expect(attackerCode).not.toBe(code);
        await expect(other.getByTestId("conn")).toHaveCount(0);
        const row = panel.getByTestId("pairing-row").filter({ hasText: name }).first();
        await expect(row.getByRole("button", { name: `${code} 기기 승인`, exact: true })).toBeVisible();
        await page.screenshot({ path: info.outputPath("owner-approval-desktop.png"), fullPage: true });
        await row.getByRole("button", { name: `${code} 기기 승인`, exact: true }).click();
        await expect(other.getByTestId("conn")).toHaveText("연결됨", { timeout: 15_000 });
        await expect(intruder.getByRole("alert")).toContainText("만료되었거나 폐기·사용");
        await expect(row).toContainText("사용됨");
        await expect(panel.getByRole("textbox", { name: "페어링 링크", exact: true })).toHaveCount(0);
        const linkCode = new URL(link).hash.slice("#pairing=".length);
        expect(requests.every((url) => !url.includes(linkCode) && !url.includes(password))).toBe(true);
        const stored = await other.evaluate(() => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }) + document.cookie);
        expect(stored).not.toContain(linkCode);
        expect(stored).not.toContain(password);
        expect(stored).not.toContain(state().token);
        await other.reload();
        await expect(other.getByTestId("conn")).toHaveText("연결됨", { timeout: 15_000 });
        await openSettings(other);
        await other.getByRole("button", { name: "기기·연결", exact: true }).click();
        const deviceName = other.getByLabel("이 기기 이름", { exact: true });
        await expect(deviceName).toHaveValue("Chrome · Linux");
        await deviceName.fill("설정에서 변경한 기기");
        await other.getByRole("button", { name: "이름 저장", exact: true }).click();
        await expect(other.getByTestId("setting-devices").getByRole("status").filter({ hasText: "저장됨" })).toBeVisible();
        await other.reload();
        await other.getByRole("button", { name: "기기·연결", exact: true }).click();
        await expect(deviceName).toHaveValue("설정에서 변경한 기기");
        expect((await apiCall<{ name: string }[]>("GET", "/devices")).some((entry) => entry.name === "설정에서 변경한 기기")).toBe(true);
        await page.evaluate((hash) => { location.hash = hash; }, new URL(link).hash);
        await expect(page.getByText("이미 로그인된 브라우저이니", { exact: false })).toBeVisible();
        await expect(page.getByRole("button", { name: "연결", exact: true })).toBeDisabled();
        await page.getByRole("button", { name: "토큰 로그인으로 돌아가기" }).click();
        await expect(page.getByTestId("conn")).toHaveText("연결됨", { timeout: 15_000 });
    } finally {
        await device.close();
        await attacker.close();
        const devices = await apiCall<{ id: string; name: string; kind: string }[]>("GET", "/devices");
        for (const entry of devices.filter((d) => d.kind === "device" && d.name === name)) await apiCall("DELETE", `/devices/${entry.id}`);
    }
});

test("5회 실패로 링크를 잠그고 새 비밀번호로 재발급해 다음 기기를 승인한다", async ({ page, browser }) => {
    const panel = await manage(page);
    const name = `잠금 기기 ${Date.now()}`;
    const old = await issue(panel, name);
    const context = await browser.newContext();
    try {
        const other = await context.newPage();
        await other.goto(old);
        const form = other.getByRole("form", { name: "페어링 등록" });
        await form.getByRole("button", { name: "연결", exact: true }).click();
        const dialog = other.getByRole("dialog", { name: "연결 비밀번호" });
        await dialog.getByLabel("비밀번호", { exact: true }).fill("incorrect");
        for (let attempt = 1; attempt <= 5; attempt++) {
            await dialog.getByRole("button", { name: "연결 요청", exact: true }).click();
            await expect(dialog.getByRole("alert")).toContainText(attempt === 5 ? "링크가 잠겼습니다" : `${5 - attempt}회 더`);
        }
        const row = panel.getByTestId("pairing-row").filter({ hasText: name }).first();
        await expect(row).toContainText("잠김");
        await expect(row).toContainText("5/5");
        await row.getByRole("button", { name: "링크 재발급" }).click();
        const fresh = await issue(panel, name);
        expect(fresh).not.toBe(old);
        await other.goto(fresh);
        const code = await connect(other, name);
        await panel.getByRole("button", { name: `${code} 기기 승인`, exact: true }).click();
        await expect(other.getByTestId("conn")).toHaveText("연결됨", { timeout: 15_000 });
        const pairs = await apiCall<PairingInfo[]>("GET", "/pairings");
        expect(pairs.filter((p) => p.name === name && p.consumed_at)).toHaveLength(1);
    } finally {
        await context.close();
        const devices = await apiCall<{ id: string; name: string; kind: string }[]>("GET", "/devices");
        for (const entry of devices.filter((d) => d.kind === "device" && d.name === name)) await apiCall("DELETE", `/devices/${entry.id}`);
    }
});
