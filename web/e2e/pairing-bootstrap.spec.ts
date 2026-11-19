import { expect, test, type Locator, type Page } from "@playwright/test";
import { apiCall, finishSetup, issueTestPairing } from "./helpers";

const password = "bootstrap-only password";

async function register(page: Page, form: Locator, id: string) {
    await form.getByRole("button", { name: "연결", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "연결 비밀번호" });
    await dialog.getByLabel("비밀번호", { exact: true }).fill(password);
    await dialog.getByRole("button", { name: "연결 요청", exact: true }).click();
    const verification = await form.getByTestId("pairing-code").innerText();
    const requests = async () => {
        const pairs = await apiCall<{ id: string; requests: { id: string; verification_code: string }[] }[]>("GET", "/pairings");
        return pairs.find((pair) => pair.id === id)?.requests ?? [];
    };
    await expect.poll(async () => (await requests()).some((request) => request.verification_code === verification)).toBe(true);
    const request = (await requests()).find((item) => item.verification_code === verification)!;
    await apiCall("POST", `/pairings/${id}/requests/${request.id}`, {});
    await finishSetup(page, false);
    await expect(page.getByTestId("conn")).toHaveText("연결됨", { timeout: 15_000 });
}

for (const width of [1400, 390]) {
    test.describe(`페어링 초기화 ${width}px`, () => {
        test.use({ viewport: { width, height: 900 }, isMobile: width < 760, hasTouch: width < 760 });

        test("암호화 연결 확인 뒤 발급된 링크로 비밀번호·소유자 승인까지 진행한다", async ({ page }) => {
            const identity = await apiCall<{ key: string }>("GET", "/e2ee/identity");
            const pair = await issueTestPairing(`bootstrap ${width}`, password);
            const plaintextAuth: string[] = [];
            page.on("request", (request) => {
                if (new URL(request.url()).pathname.startsWith("/api/v1/auth/")) plaintextAuth.push(request.method());
            });
            try {
                await page.goto("/#" + new URLSearchParams({
                    connect: "ws://127.0.0.1:17741/api/e2ee", key: identity.key, pairing: pair.code,
                }));
                await expect(page.getByRole("form", { name: "암호화 서버 연결" })).toBeVisible();
                await expect(page.getByTestId("pwa-lifecycle")).not.toContainText("서버에 연결할 수 없습니다");
                await page.getByRole("button", { name: "서버 확인 후 연결", exact: true }).click();
                const form = page.getByRole("form", { name: "페어링 등록" });
                await expect(form.getByRole("button", { name: "연결", exact: true })).toBeEnabled();
                await expect(page.getByTestId("auth-recovery")).toHaveCount(0);
                await register(page, form, pair.id);
                expect(plaintextAuth).toEqual([]);
            } finally {
                await apiCall("DELETE", `/pairings/${pair.id}`);
            }
        });

        test("첫 연결 실패도 페어링 입력을 가리지 않고 명시적 재확인 뒤 등록한다", async ({ page }) => {
            const pair = await issueTestPairing(`retry ${width}`, password);
            const registrations: string[] = [];
            page.on("request", (request) => {
                if (new URL(request.url()).pathname === "/api/v1/auth/pairing") registrations.push(request.method());
            });
            await page.route("**/api/v1/health", (route) => route.abort("failed"));
            try {
                await page.goto("/#pairing=" + pair.code);
                const form = page.getByRole("form", { name: "페어링 등록" });
                await expect(page.getByTestId("pwa-lifecycle")).toContainText("서버에 연결할 수 없습니다");
                await expect(form).toBeVisible();
                const initialLink = await form.getByRole("textbox", { name: "페어링 링크", exact: true }).inputValue();
                expect(new URL(initialLink).hash === "#pairing=" + pair.code).toBe(true);
                await expect(form.getByRole("button", { name: "연결", exact: true })).toBeDisabled();
                await expect(page.getByTestId("auth-recovery")).toHaveCount(0);
                expect(registrations).toEqual([]);
                await page.unroute("**/api/v1/health");
                await page.getByRole("button", { name: "연결 다시 확인", exact: true }).click();
                await expect(form.getByRole("button", { name: "연결", exact: true })).toBeEnabled();
                expect(registrations).toEqual([]);
                await register(page, form, pair.id);
                expect(registrations).toEqual(["POST"]);
            } finally {
                await page.unroute("**/api/v1/health");
                await apiCall("DELETE", `/pairings/${pair.id}`);
            }
        });
    });
}
