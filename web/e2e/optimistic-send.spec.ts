import { expect, test, type Page, type Route } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { apiCall, composerOption, ensureProfile, ensureProjects, login, runningSendMode, script, sessionView, startProjectConversation } from "./helpers";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

/// 서버가 요청을 받은 뒤 응답만 붙잡아 둔다. release 전까지 화면은 응답을 모른다.
async function holdResponse(page: Page, url: string, method = "POST") {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const held: Route[] = [];
    await page.route(url, async (route) => {
        if (route.request().method() !== method) return route.continue();
        held.push(route);
        await gate;
        await route.continue();
    });
    return { release, held };
}

for (const width of [390, 1400]) {
    test.describe(`${width}px 바로 보이는 전송`, () => {
        test.use({ viewport: { width, height: 844 }, isMobile: width < 760, hasTouch: width < 760, reducedMotion: "reduce" });

        async function openSession(page: Page) {
            const { a } = await ensureProjects();
            const title = `optimistic-${randomUUID()}`;
            const session = await apiCall<{ id: string }>("POST", `/projects/${a.id}/sessions`, { title });
            await apiCall("POST", "/recent/touch", { kind: "session", project_id: a.id, resource_id: session.id });
            await login(page);
            if (width < 760) await page.getByRole("button", { name: "사이드바", exact: true }).click();
            await page.getByRole("region", { name: "최근", exact: true }).getByRole("button", { name: new RegExp(title) }).click();
            const view = sessionView(page, session.id);
            await expect(view).toBeVisible();
            await composerOption(view, "보내기 방식", "save");
            return { project: a, session, view };
        }

        test("보내면 응답 전에 입력창이 비고 보낸 글이 보이며, 접수되면 실제 메시지 하나로 바뀐다", async ({ page }, info) => {
            const { session, view } = await openSession(page);
            const hold = await holdResponse(page, `**/api/v1/sessions/${session.id}/messages`);
            try {
                const text = `응답 전에 보이는 글 ${width}`;
                await view.getByLabel("메시지 입력").fill(text);
                await view.getByRole("button", { name: "보내기", exact: true }).click();
                await expect(view.getByLabel("메시지 입력")).toHaveValue("");
                await expect(view.getByTestId("msg-outgoing")).toHaveText(text);
                await expect(view.getByTestId("msg-user")).toHaveCount(0);
                expect(hold.held).toHaveLength(1);
                // 기다리는 동안 다음 글을 쓸 수 있고, 늦은 응답이 그 글을 지우지 않는다.
                await view.getByLabel("메시지 입력").fill("다음 글");
                await page.screenshot({ path: info.outputPath(`optimistic-send-${width}.png`) });
                hold.release();
                await expect(view.getByTestId("msg-user")).toHaveText(text);
                await expect(view.getByTestId("msg-outgoing")).toHaveCount(0);
                await expect(view.getByLabel("메시지 입력")).toHaveValue("다음 글");
                await expect(view.getByRole("button", { name: "보내기", exact: true })).toBeEnabled();
            } finally { hold.release(); await page.unrouteAll({ behavior: "wait" }); }
        });

        test("서버가 거절하면 보낸 글을 입력창으로 되돌리고 이유를 알린다", async ({ page }) => {
            const { session, view } = await openSession(page);
            let release!: () => void;
            const gate = new Promise<void>((resolve) => { release = resolve; });
            await page.route(`**/api/v1/sessions/${session.id}/messages`, async (route) => {
                if (route.request().method() !== "POST") return route.continue();
                await gate;
                await route.fulfill({ status: 409, json: { error: { code: "fixture_rejected", message: "fixture: 지금은 저장할 수 없어요", retryable: false } } });
            });
            try {
                await view.getByLabel("메시지 입력").fill("거절될 글");
                await view.getByRole("button", { name: "보내기", exact: true }).click();
                await expect(view.getByTestId("msg-outgoing")).toHaveText("거절될 글");
                await view.getByLabel("메시지 입력").fill("그사이 쓴 글");
                release();
                await expect(view.getByTestId("msg-outgoing")).toHaveCount(0);
                await expect(view.getByLabel("메시지 입력")).toHaveValue("거절될 글\n그사이 쓴 글");
                await expect(view.getByRole("status").filter({ hasText: "fixture: 지금은 저장할 수 없어요" })).toBeVisible();
                await expect(view.getByTestId("send-unsure")).toHaveCount(0);
                const stored = await apiCall<{ items: unknown[] }>("GET", `/sessions/${session.id}/messages`);
                expect(stored.items).toHaveLength(0);
            } finally { release(); await page.unrouteAll({ behavior: "wait" }); }
        });

        test("사진을 올리는 중에도 다음 사진을 고르고 빼고 보낼 수 있다", async ({ page }, info) => {
            const { project, session, view } = await openSession(page);
            const hold = await holdResponse(page, `**/api/v1/projects/${project.id}/attachments`);
            const input = view.getByTestId("attachment-picker").locator('input[type="file"]');
            const selection = view.getByTestId("attachment-selection");
            try {
                await input.setInputFiles({ name: "first.png", mimeType: "image/png", buffer: png });
                await expect(selection.getByRole("img", { name: "first.png", exact: true })).toBeVisible();
                await expect.poll(() => hold.held.length).toBe(1);
                // 첫 사진이 아직 올라가는 중이다.
                await input.setInputFiles({ name: "second.png", mimeType: "image/png", buffer: png });
                await input.setInputFiles({ name: "third.png", mimeType: "image/png", buffer: png });
                await expect(selection.getByRole("img")).toHaveCount(3);
                await selection.getByRole("button", { name: "third.png 첨부 제거", exact: true }).click();
                await expect(selection.getByRole("img")).toHaveCount(2);
                await view.getByLabel("메시지 입력").fill("사진 두 장");
                await view.getByRole("button", { name: "보내기", exact: true }).click();
                await expect(view.getByLabel("메시지 입력")).toHaveValue("");
                await expect(selection).toHaveCount(0);
                const sending = view.getByTestId("msg-outgoing");
                await expect(sending).toContainText("사진 두 장");
                await expect(sending.getByRole("img")).toHaveCount(2);
                // 화면에 다 보이는 짧은 대화에는 아래에 새 글이 있다는 안내를 띄우지 않는다.
                await expect(view.getByTestId("new-below")).toHaveCount(0);
                await page.screenshot({ path: info.outputPath(`optimistic-photos-${width}.png`) });
                hold.release();
                const sent = view.getByTestId("msg-user");
                await expect(sent).toContainText("사진 두 장");
                await expect(sent.getByRole("img", { name: "first.png", exact: true })).toBeVisible();
                await expect(sent.getByRole("img", { name: "second.png", exact: true })).toBeVisible();
                await expect(view.getByTestId("msg-outgoing")).toHaveCount(0);
                const stored = await apiCall<{ items: { content: { attachments?: { name: string }[] } }[] }>("GET", `/sessions/${session.id}/messages`);
                expect(stored.items).toHaveLength(1);
                expect(stored.items[0]!.content.attachments?.map((item) => item.name)).toEqual(["first.png", "second.png"]);
            } finally { hold.release(); await page.unrouteAll({ behavior: "wait" }); }
        });

        test("올리지 못한 사진이 있으면 보내지 않고 글과 사진을 입력창으로 되돌린다", async ({ page }) => {
            const { project, session, view } = await openSession(page);
            let release!: () => void;
            const gate = new Promise<void>((resolve) => { release = resolve; });
            await page.route(`**/api/v1/projects/${project.id}/attachments`, async (route) => {
                await gate;
                await route.fulfill({ status: 413, json: { error: { code: "fixture_too_large", message: "fixture: 사진을 저장할 수 없어요", retryable: false } } });
            });
            try {
                await view.getByTestId("attachment-picker").locator('input[type="file"]').setInputFiles({ name: "broken.png", mimeType: "image/png", buffer: png });
                await view.getByLabel("메시지 입력").fill("사진과 함께 보낼 글");
                await view.getByRole("button", { name: "보내기", exact: true }).click();
                await expect(view.getByTestId("msg-outgoing")).toContainText("사진과 함께 보낼 글");
                release();
                await expect(view.getByTestId("msg-outgoing")).toHaveCount(0);
                await expect(view.getByLabel("메시지 입력")).toHaveValue("사진과 함께 보낼 글");
                const selection = view.getByTestId("attachment-selection");
                await expect(selection.getByRole("img", { name: "broken.png", exact: true })).toBeVisible();
                await expect(selection.getByRole("alert")).toContainText("fixture: 사진을 저장할 수 없어요");
                await expect(view.getByRole("button", { name: "보내기", exact: true })).toBeDisabled();
                const stored = await apiCall<{ items: unknown[] }>("GET", `/sessions/${session.id}/messages`);
                expect(stored.items).toHaveLength(0);
            } finally { release(); await page.unrouteAll({ behavior: "wait" }); }
        });

        test("실행 중에 보낸 추가 메시지는 응답 전에 대기 목록에 보이고, 삭제는 누른 즉시 반영된다", async ({ page }) => {
            const { session, view } = await openSession(page);
            const profile = await ensureProfile();
            const marker = `optimistic-running-${randomUUID()}`;
            await script({ frames: [], hang: true, marker });
            const active = await apiCall<{ turn: { id: string } }>("POST", `/sessions/${session.id}/turns`, { text: marker, profile_id: profile, tools: false });
            await runningSendMode(page, "queue");
            await composerOption(view, "보내기 방식", "model");
            await page.keyboard.press("Escape");
            await composerOption(view, "모델 프로필", profile);
            const add = await holdResponse(page, `**/api/v1/sessions/${session.id}/followups`);
            try {
                await view.getByLabel("메시지 입력").fill("다음에 할 일");
                await view.getByRole("button", { name: "대기열", exact: true }).click();
                await expect(view.getByLabel("메시지 입력")).toHaveValue("");
                await expect(view.getByTestId("followup-outgoing")).toContainText("다음에 할 일");
                await expect(view.getByTestId("followup")).toHaveCount(0);
                add.release();
                await expect(view.getByTestId("followup")).toContainText("다음에 할 일");
                await expect(view.getByTestId("followup-outgoing")).toHaveCount(0);
                await page.unrouteAll({ behavior: "wait" });
                const remove = await holdResponse(page, `**/api/v1/sessions/${session.id}/followups/*`, "DELETE");
                await view.getByTestId("followup").getByRole("button", { name: /^대기 메시지 삭제/ }).click();
                await expect(view.getByTestId("followup")).toHaveCount(0);
                expect(remove.held).toHaveLength(1);
                remove.release();
                await expect.poll(async () => (await apiCall<{ items: unknown[] }>("GET", `/sessions/${session.id}/followups`)).items.length).toBe(0);
                await expect(view.getByTestId("followup")).toHaveCount(0);
            } finally {
                add.release();
                await page.unrouteAll({ behavior: "wait" });
                await apiCall("POST", `/turns/${active.turn.id}/cancel`).catch(() => undefined);
            }
        });

        test("새 대화의 첫 글도 누른 즉시 보이고 만들어진 대화로 그대로 이어진다", async ({ page }, info) => {
            const { a } = await ensureProjects();
            await login(page);
            if (width < 760) await page.getByRole("button", { name: "사이드바", exact: true }).click();
            await page.locator(`[data-testid="sidebar-project"][data-project-id="${a.id}"]`).getByTestId("project-row").getByRole("button").first().click();
            const project = page.getByTestId("project-view").filter({ visible: true });
            await startProjectConversation(project);
            await composerOption(project, "보내기 방식", "save");
            const hold = await holdResponse(page, `**/api/v1/projects/${a.id}/sessions`);
            try {
                const text = `새 대화 첫 글 ${width} ${randomUUID()}`;
                await project.getByLabel("메시지 입력").fill(text);
                await project.getByRole("button", { name: "보내기", exact: true }).click();
                await expect(project.getByLabel("메시지 입력")).toHaveValue("");
                await expect(project.getByTestId("msg-outgoing")).toHaveText(text);
                await page.screenshot({ path: info.outputPath(`optimistic-new-${width}.png`) });
                hold.release();
                const view = page.getByTestId("session-view").filter({ hasText: text });
                await expect(view.getByTestId("msg-user").filter({ hasText: text })).toHaveCount(1);
                await expect(page.getByTestId("msg-outgoing")).toHaveCount(0);
            } finally { hold.release(); await page.unrouteAll({ behavior: "wait" }); }
        });
    });
}
