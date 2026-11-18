import { expect, test } from "@playwright/test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { apiCall, login, sessionView, state } from "./helpers";

// 32×32 VP8 WebM. 브라우저 인코더의 프레임 타이밍과 무관하게 실제 디코딩을 검증한다.
const video = Buffer.from("GkXfo59ChoEBQveBAULygQRC84EIQoKEd2VibUKHgQJChYECGFOAZwH/////////EU2bdKtNu4tTq4QVSalmU6yBoU27i1OrhBZUrmtTrIHYTbuMU6uEElTDZ1OsggEe7AEAAAAAAABoAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAVSalmsirXsYMPQkBNgI1MYXZmNjAuMTYuMTAwV0GNTGF2ZjYwLjE2LjEwMESJiEBywAAAAAAAFlSua8GuAQAAAAAAADjXgQFzxYjztSOKQ4c1SZyBACK1nIN1bmSIgQCGhVZfVlA4g4EBI+ODhAX14QDgibCBILqBIJqBAhJUw2fYc3OgY8CAZ8iaRaOHRU5DT0RFUkSHjUxhdmY2MC4xNi4xMDBzc7JjwItjxYjztSOKQ4c1SWfIoUWjh0VOQ09ERVJEh5RMYXZjNjAuMzEuMTAyIGxpYnZweB9DtnXw54EAo72BAACA0AIAnQEqIAAgAABHCIWFiIWEiAICAnWqA/gCCCEIPQD+/00S//xYV/FhX8WFf/FhX/z8zu3F/OYAo5WBAGQAsQEABRCsABgAGFgv9AAIcACjlYEAyACxAQAFEKwAGAAYWC/0AAhwAA==", "base64");

test("Claude가 만든 GIF와 WebM을 답변에서 보고 원본을 받을 수 있다", async ({ page }) => {
    test.skip(process.env.GROVE_E2E_FAKE_CLI !== "1", "가짜 Claude CLI가 필요한 시험");
    const root = mkdtempSync(join(state().projA, "project-media-"));
    const project = await apiCall<{ id: string }>("POST", "/projects", { root_path: root });
    const profile = await apiCall<{ id: string }>("POST", "/agent-backends/claude_code/connect");
    const title = "Claude 답변의 미디어";
    const session = await apiCall<{ id: string }>("POST", `/projects/${project.id}/sessions`, { title });
    await apiCall("POST", "/recent/touch", { kind: "session", project_id: project.id, resource_id: session.id });
    await login(page);
    await page.getByRole("region", { name: "최근", exact: true }).getByRole("button", { name: new RegExp(title) }).click();

    writeFileSync(join(root, "preview.gif"), readFileSync(new URL("../../tests/fixtures/images/animated.gif", import.meta.url)));
    writeFileSync(join(root, "preview.webm"), video);
    const turn = await apiCall<{ turn: { id: string } }>("POST", `/sessions/${session.id}/turns`, {
        profile_id: profile.id, text: "fixture-project-media", tools: false,
    });
    await expect.poll(async () => (await apiCall<{ status: string }>("GET", `/turns/${turn.turn.id}`)).status).toBe("completed");
    const answer = sessionView(page, session.id).getByTestId("msg-assistant").last();
    await expect(answer).not.toContainText("grove-media");
    await answer.getByRole("button", { name: "preview.gif 미리보기", exact: true }).click();
    const gif = page.getByRole("dialog", { name: "preview.gif 미리보기", exact: true });
    await expect(gif.getByRole("img")).toBeVisible();
    const downloaded = page.waitForEvent("download");
    await gif.getByRole("button", { name: "원문 다운로드", exact: true }).click();
    expect((await downloaded).suggestedFilename()).toBe("preview.gif");
    await gif.getByRole("button", { name: "미리보기 닫기", exact: true }).click();
    await answer.getByRole("button", { name: "preview.webm 첨부 작업", exact: true }).click();
    await page.getByRole("button", { name: "재생", exact: true }).click();
    const player = answer.locator("video[controls]");
    await expect(player).toBeVisible();
    await expect.poll(() => player.evaluate((el) => (el as HTMLVideoElement).videoWidth)).toBe(32);
});
