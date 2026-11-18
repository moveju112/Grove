import { expect, test } from "@playwright/test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { frames } from "./fixture";
import { apiCall, composerOption, ensureProfile, ensureProjects, login, script, state } from "./helpers";

for (const mode of ["desktop", "mobile-light", "mobile-dark"] as const) {
    test.describe(mode, () => {
        if (mode !== "desktop") test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

        test("답변 이미지와 이미지 파일 링크는 썸네일에서 확대하고 누락된 원문은 다시 불러온다", async ({ page }, info) => {
            await page.emulateMedia({ colorScheme: mode === "mobile-dark" ? "dark" : "light", reducedMotion: "reduce" });
            const { a } = await ensureProjects();
            await ensureProfile();
            const title = `답변 이미지 ${mode}`;
            const session = await apiCall<{ id: string }>("POST", `/projects/${a.id}/sessions`, { title });
            await apiCall("POST", "/recent/touch", { kind: "session", project_id: a.id, resource_id: session.id });
            await login(page);
            if (mode !== "desktop") await page.getByRole("button", { name: "사이드바", exact: true }).click();
            await page.getByRole("region", { name: "최근", exact: true }).getByRole("button", { name: new RegExp(title) }).first().click();
            const image = Buffer.from(await page.evaluate(() => {
                const canvas = document.createElement("canvas");
                canvas.width = 600; canvas.height = 1000;
                const ctx = canvas.getContext("2d")!;
                ctx.fillStyle = "#171a20"; ctx.fillRect(0, 0, 600, 1000);
                ctx.fillStyle = "#5fbf8a"; ctx.fillRect(40, 440, 520, 100);
                ctx.fillStyle = "white"; ctx.font = "32px sans-serif"; ctx.fillText("Grove preview", 60, 510);
                return canvas.toDataURL("image/png").split(",")[1]!;
            }), "base64");
            const name = `preview-${mode}.png`, linked = `linked ${mode}.png`, missing = `missing-${mode}.png`;
            writeFileSync(join(state().projA, name), image);
            writeFileSync(join(state().projA, linked), image);
            const requests: string[] = [];
            page.on("request", (request) => {
                const url = new URL(request.url());
                if (url.pathname.endsWith("/files/raw")) requests.push(url.searchParams.get("path")!);
            });
            await script({ frames: frames.text([
                `이미지를 누르면 크게 볼 수 있어.\n\n![다크 시안](${state().projA}/${name}) [라이트 시안 보기](<${linked}>) ![시안 3](${name}) ![시안 4](${name}) ![시안 5](${name})\n\n![누락 시안](${missing})\n\n![외부 경로](/outside/secret.png) ![상위 경로](../secret.png)`,
            ]) });
            const view = page.getByTestId("session-view");
            await composerOption(view, "보내기 방식", "model");
            await view.getByLabel("메시지 입력").fill("시안을 보여줘");
            await view.getByRole("button", { name: "보내기", exact: true }).click();
            const answer = view.getByTestId("msg-assistant").last();
            await expect(answer.getByTestId("markdown-image")).toHaveCount(6, { timeout: 15_000 });
            const trigger = answer.getByRole("button", { name: "다크 시안 미리보기", exact: true });
            await expect(answer.getByRole("img", { name: "다크 시안", exact: true })).toBeVisible();
            await expect.poll(() => answer.getByRole("img").evaluateAll((images) => images.length === 5 && images.every((node) => {
                const image = node as HTMLImageElement;
                const box = image.getBoundingClientRect();
                return image.complete && image.naturalWidth === 600 && box.width === 80 && box.height === 80;
            }))).toBe(true);
            const strip = answer.getByRole("list", { name: "답변 이미지", exact: true }).first();
            await expect(strip.getByRole("listitem")).toHaveCount(5);
            await expect.poll(() => strip.getByRole("img").evaluateAll((images) => {
                const boxes = images.map((node) => node.getBoundingClientRect());
                return boxes.every((box) => box.top === boxes[0]!.top);
            })).toBe(true);
            await expect(answer.getByRole("alert")).toBeVisible();
            await expect(answer.getByTestId("file-link")).toHaveCount(0);
            await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
            await answer.scrollIntoViewIfNeeded();
            await page.screenshot({ path: info.outputPath(`markdown-images-${mode}.png`) });
            await trigger.click();
            const preview = page.getByRole("dialog", { name: "다크 시안 미리보기", exact: true });
            await expect(preview.getByRole("img")).toBeVisible();
            const box = (await preview.getByRole("img").boundingBox())!;
            expect(box.height).toBeGreaterThan(80);
            expect(box.x).toBeGreaterThanOrEqual(0);
            expect(box.x + box.width).toBeLessThanOrEqual(page.viewportSize()!.width);
            await page.screenshot({ path: info.outputPath(`markdown-preview-${mode}.png`) });
            await page.keyboard.press("Escape");
            await expect(preview).toHaveCount(0);
            await expect(trigger).toBeFocused();
            await answer.getByRole("button", { name: "라이트 시안 보기 미리보기", exact: true }).click();
            await expect(page.getByRole("dialog").getByRole("img")).toBeVisible();
            await page.getByRole("button", { name: "미리보기 닫기", exact: true }).click();
            await answer.getByRole("button", { name: "누락 시안 미리보기", exact: true }).click();
            const failed = page.getByRole("dialog", { name: "누락 시안 미리보기", exact: true });
            await expect(failed.getByRole("alert")).toBeVisible();
            writeFileSync(join(state().projA, missing), image);
            await failed.getByRole("button", { name: "다시 불러오기", exact: true }).click();
            await expect(failed.getByRole("img")).toBeVisible();
            await page.keyboard.press("Escape");
            expect(requests.every((path) => [name, linked, missing].includes(path))).toBe(true);
            await page.reload();
            await expect(view.getByTestId("msg-assistant").last().getByRole("img")).toHaveCount(6);
        });
    });
}
