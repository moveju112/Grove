import { expect, test } from "@playwright/test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { apiCall, ensureProjects } from "./helpers";

const endpoint = "ws://127.0.0.1:17741/api/e2ee";

test("서버 pin 불일치에서는 자격증명 전송과 평문 fallback을 하지 않는다", async ({ page }) => {
    const key = Buffer.alloc(32, 7).toString("base64");
    const sent: (string | Buffer)[] = [];
    const auth: string[] = [];
    page.on("websocket", (ws) => ws.on("framesent", ({ payload }) => sent.push(payload)));
    page.on("request", (request) => { if (request.url().includes("/api/v1/auth/")) auth.push(request.url()); });
    await page.goto("/#" + new URLSearchParams({ connect: endpoint, key }));
    await page.getByRole("button", { name: "서버 확인 후 연결" }).click();
    await expect(page.getByTestId("pwa-lifecycle")).toContainText("서버에 연결할 수 없습니다");
    await expect.poll(() => sent.length).toBeGreaterThan(0);
    expect(sent.every((frame) => typeof frame === "string" && JSON.parse(frame).version === 1)).toBe(true);
    expect(auth).toEqual([]);
});

test.describe("모바일 암호화 페어링", () => {
    test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    test("일회용 등록·재접속·파일 미리보기·다운로드에서 티켓과 본문을 평문 전송하지 않는다", async ({ page }) => {
        const identity = await apiCall<{ key: string }>("GET", "/e2ee/identity");
        const password = "encrypted test-only password";
        const pairing = await apiCall<{ code: string; id: string }>("POST", "/pairings", { name: "encrypted-mobile", password });
        const { a } = await ensureProjects();
        const project = await apiCall<{ root_path: string }>("GET", `/projects/${a.id}`);
        const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
        writeFileSync(join(project.root_path, "encrypted.png"), png);
        const plaintextRequests: string[] = [];
        const wire: Buffer[] = [];
        page.on("request", (request) => {
            if (/\/api\/v1\/(auth|file-tickets|projects|events)/.test(request.url())) plaintextRequests.push(request.url());
        });
        page.on("websocket", (socket) => {
            socket.on("framesent", ({ payload }) => wire.push(Buffer.from(payload)));
            socket.on("framereceived", ({ payload }) => wire.push(Buffer.from(payload)));
        });
        await page.goto("/#" + new URLSearchParams({ connect: endpoint, key: identity.key, pairing: pairing.code }));
        await page.getByRole("button", { name: "서버 확인 후 연결" }).click();
        await page.getByRole("button", { name: "연결", exact: true }).click();
        await page.getByLabel("비밀번호", { exact: true }).fill(password);
        await page.getByRole("button", { name: "연결 요청", exact: true }).click();
        const code = await page.locator(".pairing-code").innerText();
        await expect.poll(async () => {
            const pairs = await apiCall<{ id: string; requests: { id: string; verification_code: string }[] }[]>("GET", "/pairings");
            return pairs.find((pair) => pair.id === pairing.id)?.requests.some((request) => request.verification_code === code);
        }).toBe(true);
        const pairs = await apiCall<{ id: string; requests: { id: string; verification_code: string }[] }[]>("GET", "/pairings");
        const request = pairs.find((pair) => pair.id === pairing.id)!.requests.find((request) => request.verification_code === code)!;
        await apiCall("POST", `/pairings/${pairing.id}/requests/${request.id}`, {});
        await expect(page.getByTestId("conn")).toHaveText("연결됨");
        await page.reload();
        await expect(page.getByTestId("conn")).toHaveText("연결됨");
        const sidebar = page.getByRole("button", { name: "사이드바", exact: true });
        if (await sidebar.getAttribute("aria-expanded") === "false") await sidebar.click();
        await page.getByTestId("project-row").getByRole("button", { name: a.name, exact: true }).click();
        await page.getByRole("button", { name: "파일", exact: true }).click();
        const files = page.getByTestId("files-view");
        await files.getByRole("button", { name: "encrypted.png", exact: true }).click();
        const image = files.locator("img.preview");
        await expect(image).toHaveAttribute("src", /^blob:/);
        await expect.poll(() => image.evaluate((element: HTMLImageElement) => element.naturalWidth)).toBe(1);
        const downloading = page.waitForEvent("download");
        await files.getByRole("button", { name: "내려받기", exact: true }).click();
        const download = await downloading;
        expect(download.suggestedFilename()).toBe("encrypted.png");
        expect(plaintextRequests).toEqual([]);
        expect(wire.some((frame) => frame.includes(Buffer.from(pairing.code)) || frame.includes(Buffer.from(password)) || frame.includes(png))).toBe(false);
        const stored = await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }) + document.cookie);
        expect(stored).not.toContain(pairing.code);
    });
});
