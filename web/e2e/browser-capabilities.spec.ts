import { expect, test, type Page } from "@playwright/test";
import { composerOption, ensureProjects, login } from "./helpers";

async function settings(page: Page, search = "브라우저 기능") {
    await page.getByRole("banner").getByRole("button", { name: "설정", exact: true }).click();
    await page.getByLabel("설정 검색").fill(search);
    return page.getByTestId("setting-browser-capabilities");
}

for (const allowed of [true, false]) {
    test(`실제 권한 ${allowed ? "허용" : "거부"} context의 기능 표시와 수동 탐지`, async ({ browser }) => {
        const context = await browser.newContext();
        try {
            await context.grantPermissions(allowed ? ["notifications", "clipboard-read", "clipboard-write"] : [], { origin: "http://127.0.0.1:17741" });
            const page = await context.newPage();
            await page.addInitScript(() => {
                const calls: string[] = [];
                Object.assign(window, { __capabilityCalls: calls });
                Notification.requestPermission = async () => { calls.push("notification"); throw new Error("passive permission request"); };
                navigator.clipboard.readText = async () => { calls.push("read"); throw new Error("passive clipboard read"); };
                navigator.clipboard.writeText = async () => { calls.push("write"); throw new Error("passive clipboard write"); };
                for (const key of ["showOpenFilePicker", "showSaveFilePicker", "showDirectoryPicker"]) {
                    Object.defineProperty(window, key, { configurable: true, value: () => { calls.push(key); throw new Error("passive file dialog"); } });
                }
            });
            await login(page);
            const section = await settings(page);
            await expect(section).toContainText("이 기기");
            await expect(section.getByTestId("browser-capability-notifications")).toContainText(allowed ? "허용" : "거부");
            await expect(section.getByTestId("browser-capability-clipboard-read")).toContainText(allowed ? "허용" : "거부");
            await expect(section.getByTestId("browser-capability-clipboard-write")).toContainText(allowed ? "허용" : "거부");
            await expect(section.getByTestId("browser-capability-file-select")).toContainText("지원");
            await section.getByRole("button", { name: "브라우저 기능 새로 확인" }).click();
            expect(await page.evaluate(() => (window as unknown as { __capabilityCalls: string[] }).__capabilityCalls)).toEqual([]);
            if (!allowed) {
                await expect(section).toContainText("알림 목록");
                await expect(section).toContainText("Ctrl+C");
                await page.getByLabel("설정 검색").fill("알림·소리");
                const notify = page.getByTestId("setting-notify");
                await notify.getByLabel("작업 완료·실패").check();
                await expect(notify).toContainText("브라우저 사이트 설정");
                expect(await page.evaluate(() => (window as unknown as { __capabilityCalls: string[] }).__capabilityCalls)).toEqual([]);
            }
        } finally { await context.close(); }
    });
}

test("미지원 복사·첨부 진입점에서 원문과 대안을 보존한다", async ({ page }) => {
    const { b } = await ensureProjects();
    await page.addInitScript(() => {
        Object.defineProperty(window, "Notification", { configurable: true, value: undefined });
        Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined });
        Object.defineProperty(File.prototype, "arrayBuffer", { configurable: true, value: undefined });
        for (const key of ["showOpenFilePicker", "showSaveFilePicker", "showDirectoryPicker"]) {
            Object.defineProperty(window, key, { configurable: true, value: undefined });
        }
    });
    await login(page);
    const section = await settings(page);
    for (const id of ["notifications", "clipboard-read", "clipboard-write", "file-select", "file-open", "file-save", "directory"]) {
        await expect(section.getByTestId(`browser-capability-${id}`).getByRole("cell").first()).toHaveText("미지원");
    }
    await page.getByLabel("설정 검색").fill("알림·소리");
    await expect(page.getByTestId("setting-notify")).toContainText("알림 목록");
    await page.locator(".sidebar .projects").getByRole("button", { name: new RegExp(b.name) }).first().click();
    const project = page.locator(".project-view");
    let dialogs = 0;
    page.on("filechooser", () => { dialogs++; });
    await project.getByRole("button", { name: "파일 첨부", exact: true }).click();
    await expect(project.locator(".attachment-picker")).toContainText("파일 내용을 메시지에 붙여 넣거나");
    expect(dialogs).toBe(0);
    const text = `**수동 복사 원문** <script>not executable</script> ${Date.now()}`;
    await composerOption(project, "보내기 방식", "save");
    await project.getByLabel("메시지 입력").fill(text);
    await project.getByRole("button", { name: "보내기", exact: true }).click();
    const message = page.getByTestId("msg-user").last();
    await message.getByTestId("msg-copy").click();
    const manual = message.getByLabel("메시지 원문 수동 복사");
    await expect(manual).toHaveValue(text);
    await expect(manual).toBeFocused();
    expect(await manual.evaluate((node) => (node as HTMLTextAreaElement).selectionEnd - (node as HTMLTextAreaElement).selectionStart)).toBe(text.length);
    await expect(message).toContainText("Ctrl+C");
    await expect(message.getByTestId("msg-copy")).not.toHaveText("복사됨");
    await expect(message.locator("script")).toHaveCount(0);
});

test("비보안 환경의 제한을 API 미지원과 구별하고 파일 선택은 유지한다", async ({ page }) => {
    // 실제 HTTP origin을 추가하지 않고 보안 컨텍스트 신호만 제어한다.
    await page.addInitScript(() => { Object.defineProperty(window, "isSecureContext", { configurable: true, value: false }); });
    await login(page);
    const section = await settings(page);
    await expect(section).toContainText("보안 컨텍스트: 아니요");
    await expect(section.getByTestId("browser-capability-clipboard-write")).toContainText("HTTPS 또는 localhost로 접속");
    await expect(section.getByTestId("browser-capability-file-select").getByRole("cell").first()).toHaveText("지원");
});
