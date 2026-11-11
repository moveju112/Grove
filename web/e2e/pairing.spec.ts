import { expect, test, type Locator, type Page } from "@playwright/test";
import { apiCall, login, state } from "./helpers";

async function manage(page: Page): Promise<Locator> {
    await login(page);
    await page.getByRole("banner").getByRole("button", { name: "설정", exact: true }).click();
    await page.getByLabel("설정 검색").fill("페어링");
    return page.getByRole("region", { name: "기기 페어링" });
}

async function issue(panel: Locator, name: string): Promise<string> {
    await panel.getByLabel("등록할 기기 이름", { exact: true }).fill(name);
    await panel.getByRole("button", { name: "페어링 링크 발급", exact: true }).click();
    await expect(panel.getByLabel("일회용 페어링 링크", { exact: true })).toHaveValue(/#pairing=/);
    await expect(panel.getByTestId("pairing-qr")).toHaveAttribute("data-ready", "true");
    return panel.getByLabel("일회용 페어링 링크", { exact: true }).inputValue();
}

test("QR 이미지를 기기에서 스캔해 한 번 등록하고 장기 자격을 URL·저장소에 남기지 않는다", async ({ page, browser }) => {
    const panel = await manage(page);
    const name = `QR 기기 ${Date.now()}`;
    const link = await issue(panel, name);
    expect(new URL(link).search).toBe("");
    expect(link.includes(state().token)).toBe(false);
    const image = await panel.getByTestId("pairing-qr").screenshot();
    const device = await browser.newContext();
    try {
        const other = await device.newPage();
        const requests: string[] = [];
        other.on("request", (request) => requests.push(request.url()));
        await other.goto(new URL(link).origin);
        await other.locator("html[data-hydrated=true]").waitFor();
        await other.getByRole("button", { name: "페어링 링크·QR로 등록" }).click();
        const form = other.getByRole("form", { name: "페어링 등록" });
        await form.getByLabel("페어링 QR 사진").setInputFiles({ name: "qr.png", mimeType: "image/png", buffer: image });
        await expect(form.getByLabel("페어링 링크", { exact: true })).toHaveValue(link);
        await expect(form.getByText("등록 대상:")).toContainText(new URL(link).origin);
        await form.getByRole("button", { name: "이 기기 등록", exact: true }).click();
        await expect(other.getByTestId("conn")).toHaveText("연결됨", { timeout: 15_000 });
        await expect(panel.getByTestId("pairing-row").filter({ hasText: name })).toContainText("사용됨");
        const code = new URL(link).hash.slice("#pairing=".length);
        expect(requests.every((url) => !url.includes(code))).toBe(true);
        const stored = await other.evaluate(() => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }) + document.cookie);
        expect(stored.includes(code)).toBe(false);
        expect(stored.includes(state().token)).toBe(false);
        await other.reload();
        await expect(other.getByTestId("conn")).toHaveText("연결됨", { timeout: 15_000 });
        // 이미 사용한 링크는 새 브라우저에서도 재사용할 수 없고 주소의 fragment는 바로 지운다.
        const replayContext = await browser.newContext();
        try {
            const replay = await replayContext.newPage();
            await replay.goto(link);
            await expect(replay.getByRole("form", { name: "페어링 등록" })).toBeVisible();
            await expect.poll(() => new URL(replay.url()).hash === "").toBe(true);
            await replay.getByRole("button", { name: "이 기기 등록", exact: true }).click();
            await expect(replay.getByRole("alert")).toContainText("만료되었거나 폐기·사용");
            await expect(replay.getByTestId("conn")).toHaveCount(0);
        } finally {
            await replayContext.close();
        }
        // 이미 로그인된 탭에서 링크를 받아도 인증·기기 내 사본을 다른 사용자로 바꾸지 않는다.
        await page.evaluate((hash) => { location.hash = hash; }, new URL(link).hash);
        await expect(page.getByText("이미 로그인된 브라우저입니다.", { exact: false })).toBeVisible();
        await expect(page.getByRole("button", { name: "이 기기 등록", exact: true })).toBeDisabled();
        await page.getByRole("button", { name: "토큰 로그인으로 돌아가기" }).click();
        await expect(page.getByTestId("conn")).toHaveText("연결됨", { timeout: 15_000 });
    } finally {
        await device.close();
        const devices = await apiCall<{ id: string; name: string; kind: string }[]>("GET", "/devices");
        for (const entry of devices.filter((d) => d.kind === "device" && d.name === name)) await apiCall("DELETE", `/devices/${entry.id}`);
    }
});

test("링크 폐기·재발급과 URL 직접 진입이 사용자 확인 전에는 등록하지 않는다", async ({ page, browser }) => {
    const panel = await manage(page);
    const name = `링크 기기 ${Date.now()}`;
    const old = await issue(panel, name);
    const row = panel.getByTestId("pairing-row").filter({ hasText: name }).first();
    await row.getByRole("button", { name: "링크 폐기" }).click();
    await expect(row).toContainText("폐기됨");
    await row.getByRole("button", { name: "링크 재발급" }).click();
    const input = panel.getByLabel("일회용 페어링 링크", { exact: true });
    await expect(input).toHaveValue(/#pairing=/);
    const fresh = await input.inputValue();
    expect(fresh !== old).toBe(true);
    const context = await browser.newContext();
    try {
        const other = await context.newPage();
        await other.goto(old);
        await other.getByRole("button", { name: "이 기기 등록", exact: true }).click();
        await expect(other.getByRole("alert")).toContainText("만료되었거나 폐기·사용");
        await other.goto(fresh);
        const form = other.getByRole("form", { name: "페어링 등록" });
        await expect(form).toBeVisible();
        await expect(other.getByTestId("conn")).toHaveCount(0);
        await expect.poll(() => new URL(other.url()).hash === "").toBe(true);
        const pending = await apiCall<{ name: string; consumed_at: string | null; revoked_at: string | null }[]>("GET", "/pairings");
        expect(pending.some((p) => p.name === name && !p.consumed_at && !p.revoked_at)).toBe(true);
        await form.getByRole("button", { name: "이 기기 등록", exact: true }).click();
        await expect(other.getByTestId("conn")).toHaveText("연결됨", { timeout: 15_000 });
    } finally {
        await context.close();
        const devices = await apiCall<{ id: string; name: string; kind: string }[]>("GET", "/devices");
        for (const entry of devices.filter((d) => d.kind === "device" && d.name === name)) await apiCall("DELETE", `/devices/${entry.id}`);
    }
});
