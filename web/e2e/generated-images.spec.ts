import { expect, test } from "@playwright/test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { apiCall, login, sessionView, state } from "./helpers";

test.skip(process.env.GROVE_E2E_FAKE_CLI !== "1", "GROVE_E2E_FAKE_CLI=1로 실행");

for (const mode of ["desktop", "mobile-light", "mobile-dark"] as const) {
    test.describe(mode, () => {
        test.use({ viewport: { width: mode === "desktop" ? 1400 : 390, height: 844 }, isMobile: mode !== "desktop", hasTouch: mode !== "desktop" });
        for (const source of ["native", "tools", "cache", "animated", "manifest"] as const) {
            test(`${source}: 이미지는 답변 첨부로 보존하고 미리보기와 새로고침을 지원한다`, async ({ page }, info) => {
                const count = source === "native" || source === "animated" ? 2 : 3;
                const theme = mode === "mobile-dark" ? "dark" : "light";
                await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
                await page.addInitScript((theme) => localStorage.setItem("grove.device.prefs", JSON.stringify({ theme })), theme);
                const root = mkdtempSync(join(state().projA, "generated-images-"));
                const project = await apiCall<{ id: string }>("POST", "/projects", { root_path: root });
                const profile = await apiCall<{ id: string }>("POST", "/agent-backends/codex_cli/connect");
                const title = `생성 이미지 ${mode} ${source}`;
                const session = await apiCall<{ id: string }>("POST", `/projects/${project.id}/sessions`, { title });
                await apiCall("POST", "/recent/touch", { kind: "session", project_id: project.id, resource_id: session.id });
                await login(page);
                const sidebar = page.getByRole("button", { name: "사이드바", exact: true });
                if (await sidebar.getAttribute("aria-expanded") !== "true") await sidebar.click();
                await page.getByRole("region", { name: "최근", exact: true }).getByRole("button", { name: new RegExp(title) }).click();
                const images = await page.evaluate(({ count, manifest }) => ["#69a17e", "#4181a8", "#a88b61"].slice(0, count).map((color, index) => {
                    const canvas = document.createElement("canvas");
                    canvas.width = 600; canvas.height = 900;
                    const context = canvas.getContext("2d")!;
                    context.fillStyle = "#191b20"; context.fillRect(0, 0, 600, 900);
                    context.strokeStyle = color; context.lineWidth = 8; context.strokeRect(8, 8, 584, 884);
                    context.fillStyle = color; context.font = "80px sans-serif"; context.fillText(String(index + 1), 270, 460);
                    const result = canvas.toDataURL("image/png").split(",")[1]!;
                    const preview = manifest ? canvas.toDataURL("image/jpeg").split(",")[1] : undefined;
                    return { id: `image-${index}`, type: "imageGeneration", status: "completed", result, preview };
                }), { count, manifest: source === "manifest" });
                const animated = ["gif", "webp"].map((ext) => readFileSync(new URL(`../../tests/fixtures/images/animated.${ext}`, import.meta.url)));
                if (source === "animated") images.forEach((image, index) => { image.result = animated[index]!.toString("base64"); });
                const names = ["01.png", "02.png", "03.png"];
                if (source === "manifest") {
                    images.forEach((image, i) => {
                        writeFileSync(join(root, names[i]!), Buffer.from(image.result, "base64"));
                        writeFileSync(join(root, `preview-${i}.jpg`), Buffer.from(image.preview!, "base64"));
                    });
                    const previews = [1, 0, 2].map((i) => ({ id: `preview-${i}`, type: "imageView", path: join(root, `preview-${i}.jpg`) }));
                    writeFileSync(join(root, "native-generated-images.json"), JSON.stringify(previews));
                } else {
                    writeFileSync(join(root, "native-generated-images.json"), JSON.stringify(images));
                }
                const turn = await apiCall<{ turn: { id: string } }>("POST", `/sessions/${session.id}/turns`, {
                    profile_id: profile.id, text: `fixture-generated-images-${source}`, tools: false,
                });
                await expect.poll(async () => (await apiCall<{ status: string }>("GET", `/turns/${turn.turn.id}`)).status,
                    { timeout: 15_000 }).toBe("completed");
                const view = sessionView(page, session.id);
                const answer = view.getByTestId("msg-assistant").last();
                await expect(answer).toContainText(source === "manifest" ? "시안 세 개를 첨부했어." : source === "tools" || source === "cache" ? "시안을 다시 보여줄게." : "시안 두 개를 만들었어.");
                await expect(answer.getByTestId("attachment-card")).toHaveCount(count);
                await expect.poll(() => answer.getByRole("img").evaluateAll((images, { count, width }) => images.length === count && images.every((node) => {
                    const image = node as HTMLImageElement;
                    const box = image.getBoundingClientRect();
                    return image.complete && image.naturalWidth === width && box.width === 80 && box.height === 80;
                }), { count, width: source === "animated" ? 8 : 600 })).toBe(true);
                await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
                await answer.scrollIntoViewIfNeeded();
                await page.screenshot({ path: info.outputPath(`generated-images-${mode}-${source}.png`) });
                const firstName = source === "manifest" ? names[0] : source === "animated" ? "generated-1.gif" : "generated-1.png";
                await answer.getByRole("button", { name: `${firstName} 미리보기`, exact: true }).click();
                const preview = page.getByRole("dialog", { name: `${firstName} 미리보기`, exact: true });
                await expect(preview.getByRole("img")).toBeVisible();
                if (source === "animated") {
                    const firstFrame = await preview.getByRole("img").screenshot({ animations: "allow" });
                    await expect.poll(async () => !(await preview.getByRole("img").screenshot({ animations: "allow" })).equals(firstFrame)).toBe(true);
                }
                await page.keyboard.press("Escape");
                await page.reload();
                await expect(answer.getByRole("img")).toHaveCount(count);
                if (source === "manifest") {
                    for (const [i, name] of names.entries()) await expect(answer.getByRole("img").nth(i)).toHaveAttribute("alt", name);
                }
                await expect.poll(() => answer.getByRole("img").evaluateAll((images) => images.every((node) => {
                    const image = node as HTMLImageElement;
                    return image.complete && image.naturalWidth > 0;
                }))).toBe(true);
                const messages = await apiCall<{ items: { role: string; content: { attachments?: { id: string; sha256: string; mime: string }[] } }[] }>("GET", `/sessions/${session.id}/messages`);
                const saved = messages.items.find((message) => message.role === "assistant")!.content;
                expect(saved.attachments).toHaveLength(count);
                expect(JSON.stringify(saved)).not.toContain("data:image");
                expect(JSON.stringify(saved)).not.toContain(root);
                if (source === "animated") {
                    expect(saved.attachments!.map((a) => a.mime)).toEqual(["image/gif", "image/webp"]);
                    for (let index = 0; index < count; index++) {
                        const img = answer.getByRole("img").nth(index);
                        const content = await fetch(`http://127.0.0.1:17741/api/v1/attachments/${saved.attachments![index]!.id}/content`, {
                            headers: { authorization: `Bearer ${state().token}` },
                        });
                        expect(content.status).toBe(200);
                        expect(content.headers.get("content-type")).toContain(saved.attachments![index]!.mime);
                        expect(Buffer.from(await content.arrayBuffer())).toEqual(animated[index]);
                        const firstFrame = await img.screenshot({ animations: "allow" });
                        await expect.poll(async () => !(await img.screenshot({ animations: "allow" })).equals(firstFrame)).toBe(true);
                    }
                }
                const id = saved.attachments![0]!.id;
                const response = await fetch(`http://127.0.0.1:17741/api/v1/attachments/${id}/content`);
                expect(response.status).toBe(401);
                const attachment = await apiCall<{ ref_count: number }>("GET", `/attachments/${id}`);
                expect(attachment.ref_count).toBe(1);
            });
        }
    });
}
