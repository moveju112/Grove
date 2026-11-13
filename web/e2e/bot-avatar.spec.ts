import { expect, test } from "@playwright/test";
import { apiCall, ensureProjects, login, openBots } from "./helpers";

// 1×1 PNG
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", "base64");

// BOT-003: 봇 아바타 이미지를 고르면 목록에 보이고, 능동 콘텐츠는 거절하며, 기본형으로 돌아갈 수 있다.
test("봇 아바타 이미지를 올리고 SVG는 거절하며 기본형으로 되돌린다", async ({ page }) => {
    const { a } = await ensureProjects();
    const name = `아바타 봇 ${Date.now().toString(36)}`;
    await apiCall("POST", "/bots", { name, project_id: a.id });
    await login(page);
    await openBots(page);
    const panel = page.getByTestId("bots-panel");
    const item = panel.getByTestId("bot").filter({ hasText: name });
    await expect(item.getByTestId("bot-avatar-image")).toHaveCount(0);
    await item.getByLabel(`${name} 관리`).click();
    await item.getByRole("button", { name: "편집" }).click();
    const avatar = panel.getByTestId("bot-editor").getByRole("group", { name: "봇 아바타" });
    await avatar.getByLabel("아바타 이미지 선택").setInputFiles({ name: "a.png", mimeType: "image/png", buffer: PNG });
    await expect(item.getByTestId("bot-avatar-image")).toBeVisible();
    await expect(avatar.getByTestId("bot-avatar-image")).toBeVisible();
    // 확장자·MIME을 PNG로 속인 SVG는 거절하고 기존 아바타를 유지한다
    await avatar.getByLabel("아바타 이미지 선택").setInputFiles({ name: "x.png", mimeType: "image/png", buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>') });
    await expect(avatar.getByRole("alert")).toContainText("PNG·JPEG·GIF·WebP");
    await expect(item.getByTestId("bot-avatar-image")).toBeVisible();
    await avatar.getByRole("button", { name: "기본형으로" }).click();
    await expect(item.getByTestId("bot-avatar-image")).toHaveCount(0);
    await expect(item.locator("span.avatar")).toBeVisible();
});
