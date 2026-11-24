import { expect, test, type Page } from "@playwright/test";
import { apiCall, composerOption, ensureProjects, login, sessionView } from "./helpers";

async function openSession(page: Page) {
    const { a } = await ensureProjects();
    const title = `send-recovery-${Date.now()}`;
    const session = await apiCall<{ id: string }>("POST", `/projects/${a.id}/sessions`, { title });
    await apiCall("POST", "/recent/touch", { kind: "session", project_id: a.id, resource_id: session.id });
    await login(page);
    const recent = page.getByRole("region", { name: "최근", exact: true }).getByRole("button", { name: new RegExp(title) });
    await recent.click();
    const view = sessionView(page, session.id);
    const pane = page.getByTestId("pane").filter({ has: view });
    const reopen = async () => {
        await pane.getByRole("tab", { selected: true }).getByRole("button", { name: "탭 닫기", exact: true }).click();
        // 탭을 닫으면 최근 항목도 숨긴다. 같은 대화를 다시 열 수 있게 최근에 올린다.
        await expect(recent).toHaveCount(0);
        await apiCall("POST", "/recent/touch", { kind: "session", project_id: a.id, resource_id: session.id });
        await recent.click();
    };
    return { project: a, session, view, reopen };
}

test("닫은 대화를 새 탭에서 열면 보내지 않은 글·첨부를 복원하지 않는다", async ({ page }) => {
    const { view, reopen } = await openSession(page);
    const text = "보내지 않은 입력";
    const name = "unsent.txt";
    await view.getByLabel("메시지 입력").fill(text);
    await view.getByTestId("attachment-picker").locator('input[type="file"]').setInputFiles({ name, mimeType: "text/plain", buffer: Buffer.from("draft attachment fixture") });
    await expect(view.getByTestId("attachment-card")).toContainText(name);
    await reopen();
    await expect(view.getByLabel("메시지 입력")).toHaveValue("");
    await expect(view.getByTestId("attachment-selection")).toHaveCount(0);
});

test("응답 유실 후 대화를 다시 열어도 원래 본문·첨부·요청 키로 결과만 확인한다", async ({ page }) => {
    const { session, view, reopen } = await openSession(page);
    const text = "새 탭에서도 한 번만 저장하는 글";
    await view.getByLabel("메시지 입력").fill(text);
    await composerOption(view, "보내기 방식", "save");
    await view.getByTestId("attachment-picker").locator('input[type="file"]').setInputFiles({ name: "receipt.txt", mimeType: "text/plain", buffer: Buffer.from("receipt attachment fixture") });
    await expect(view.getByTestId("attachment-card")).toContainText("receipt.txt");
    const sent: { key: string; body: string | null }[] = [];
    await page.route(`**/api/v1/sessions/${session.id}/messages`, async (route) => {
        if (route.request().method() !== "POST") return route.continue();
        sent.push({ key: route.request().headers()["idempotency-key"]!, body: route.request().postData() });
        const response = await route.fetch();
        expect(response.status()).toBe(201);
        if (sent.length === 1) await route.abort("connectionreset");
        else {
            expect(response.headers()["idempotent-replayed"]).toBe("true");
            await route.fulfill({ response });
        }
    });
    await view.getByRole("button", { name: "보내기", exact: true }).click();
    await expect(view.getByTestId("send-unsure")).toBeVisible();
    await reopen();
    await expect(view.getByTestId("send-unsure")).toBeVisible();
    expect(sent).toHaveLength(1);
    await view.getByRole("button", { name: "같은 요청 확인", exact: true }).click();
    await expect(view.getByLabel("메시지 입력")).toHaveValue("");
    expect(sent).toHaveLength(2);
    expect(sent[1]).toEqual(sent[0]);
    const messages = await apiCall<{ items: { role: string; content: { attachments?: unknown[] } }[] }>("GET", `/sessions/${session.id}/messages`);
    expect(messages.items.filter((m) => m.role === "user")).toHaveLength(1);
    expect(messages.items[0]!.content.attachments).toHaveLength(1);
    await reopen();
    await expect(view.getByTestId("draft-copies")).toHaveCount(0);
});

test("로그아웃 뒤 늦게 도착한 업로드 완료가 민감 사본을 다시 만들지 않는다", async ({ page }) => {
    const { project, view } = await openSession(page);
    let deliver!: () => void;
    const gate = new Promise<void>((resolve) => { deliver = resolve; });
    let received!: () => void;
    const accepted = new Promise<void>((resolve) => { received = resolve; });
    await page.route(`**/api/v1/projects/${project.id}/attachments`, async (route) => {
        const response = await route.fetch();
        expect(response.status()).toBe(201);
        received();
        await gate;
        await route.fulfill({ response });
    });
    try {
        await test.step("지연할 업로드를 서버까지 접수한다", async () => {
            await view.getByTestId("attachment-picker").locator('input[type="file"]').setInputFiles({ name: "late.txt", mimeType: "text/plain", buffer: Buffer.from("late upload fixture") });
            await accepted;
        });
        await test.step("업로드 응답보다 먼저 로그아웃한다", async () => {
            await page.getByTestId("sidebar").getByRole("button", { name: "설정", exact: true }).click();
            await page.getByLabel("설정 검색").fill("로그아웃");
            await page.getByRole("button", { name: "이 브라우저에서 로그아웃" }).click();
            await expect(page.getByText("페어링 링크 또는 QR과 비밀번호로 기기를 등록하세요.")).toBeVisible();
        });
        const finished = page.waitForEvent("requestfinished", (r) => r.url().endsWith(`/projects/${project.id}/attachments`));
        deliver();
        await test.step("로그아웃 뒤 원래 응답 전달을 마친다", () => finished);
        expect(await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith("grove.send.")))).toEqual([]);
    } finally {
        deliver();
        await test.step("소유한 업로드 route를 정리한다", () => page.unrouteAll({ behavior: "wait" }));
    }
});

test("손상된 보류 전송은 새 키로 보내지 않고 서버 기록 확인을 요구한다", async ({ page }) => {
    const { session, view, reopen } = await openSession(page);
    const text = "손상되어도 보존할 입력";
    await view.getByLabel("메시지 입력").fill(text);
    await composerOption(view, "보내기 방식", "save");
    await page.evaluate(({ id }) => {
        localStorage.setItem(`grove.send.session:${id}#broken`, JSON.stringify({ raw: "incomplete", key: "incomplete" }));
    }, { id: session.id });
    await reopen();
    await expect(view.getByRole("alert")).toContainText("전송 사본이 손상");
    await expect(view.getByLabel("메시지 입력")).toHaveValue("");
    await expect(view.getByRole("button", { name: "보내기", exact: true })).toBeDisabled();
    await view.getByRole("button", { name: "기록 확인 후 새 전송 허용", exact: true }).click();
    await view.getByLabel("메시지 입력").fill(text);
    await expect(view.getByRole("button", { name: "보내기", exact: true })).toBeEnabled();
});

test("첫 전송의 응답이 아직 오지 않아도 새 탭은 같은 키로 확인하고 늦은 완료가 새 입력을 지우지 않는다", async ({ page }) => {
    const { session, view, reopen } = await openSession(page);
    const text = "inflight draft fixture";
    await view.getByLabel("메시지 입력").fill(text);
    await composerOption(view, "보내기 방식", "save");
    let deliver!: () => void;
    const gate = new Promise<void>((resolve) => { deliver = resolve; });
    let received!: () => void;
    const accepted = new Promise<void>((resolve) => { received = resolve; });
    const requests: { key: string; body: string | null }[] = [];
    await page.route(`**/api/v1/sessions/${session.id}/messages`, async (route) => {
        if (route.request().method() !== "POST") return route.continue();
        requests.push({ key: route.request().headers()["idempotency-key"]!, body: route.request().postData() });
        const first = requests.length === 1;
        const response = await route.fetch();
        expect(response.status()).toBe(201);
        if (first) { received(); await gate; }
        await route.fulfill({ response });
    });
    try {
        await view.getByRole("button", { name: "보내기", exact: true }).click();
        await accepted;
        await reopen();
        await expect(view.getByTestId("send-unsure")).toBeVisible();
        expect(requests).toHaveLength(1);
        await view.getByRole("button", { name: "같은 요청 확인", exact: true }).click();
        await expect(view.getByLabel("메시지 입력")).toHaveValue("");
        expect(requests).toHaveLength(2);
        expect(requests[1]).toEqual(requests[0]);
        await view.getByLabel("메시지 입력").fill("late response must preserve this draft");
        const finished = page.waitForEvent("requestfinished", (r) => r.url().endsWith(`/sessions/${session.id}/messages`) && r.method() === "POST");
        deliver();
        await finished;
        await expect(view.getByLabel("메시지 입력")).toHaveValue("late response must preserve this draft");
        await expect(view.getByTestId("msg-user")).toHaveCount(1);
    } finally {
        deliver();
        await page.unrouteAll({ behavior: "wait" });
    }
});

test("입력과 첨부를 바꿔도 원래 요청을 확인할 수 있고 현재 입력은 그대로 남는다", async ({ page }) => {
    const { session, view } = await openSession(page);
    await view.getByLabel("메시지 입력").fill("original request fixture");
    await composerOption(view, "보내기 방식", "save");
    await view.getByTestId("attachment-picker").locator('input[type="file"]').setInputFiles({ name: "original.txt", mimeType: "text/plain", buffer: Buffer.from("original attachment fixture") });
    const selected = view.getByLabel("선택한 첨부파일");
    await expect(selected).toContainText("original.txt");
    const requests: { key: string; body: string | null }[] = [];
    await page.route(`**/api/v1/sessions/${session.id}/messages`, async (route) => {
        if (route.request().method() !== "POST") return route.continue();
        requests.push({ key: route.request().headers()["idempotency-key"]!, body: route.request().postData() });
        const response = await route.fetch();
        expect(response.status()).toBe(201);
        if (requests.length === 1) await route.abort("connectionreset");
        else await route.fulfill({ response });
    });
    await view.getByRole("button", { name: "보내기", exact: true }).click();
    await expect(view.getByTestId("send-unsure")).toBeVisible();
    await view.getByLabel("메시지 입력").fill("keep this next input");
    await selected.getByRole("button", { name: "original.txt 첨부 제거", exact: true }).click();
    await view.getByTestId("attachment-picker").locator('input[type="file"]').setInputFiles({ name: "next.txt", mimeType: "text/plain", buffer: Buffer.from("next attachment fixture") });
    await expect(selected).toContainText("next.txt");
    await view.getByRole("button", { name: "원래 요청 결과 확인", exact: true }).click();
    await expect(view.getByTestId("send-unsure")).toHaveCount(0);
    expect(requests).toHaveLength(2);
    expect(requests[1]).toEqual(requests[0]);
    await expect(view.getByLabel("메시지 입력")).toHaveValue("keep this next input");
    await expect(selected).toContainText("next.txt");
    await expect(view.getByTestId("msg-user")).toHaveCount(1);
    await view.getByRole("button", { name: "보내기", exact: true }).click();
    await expect(view.getByTestId("msg-user")).toHaveCount(2);
    expect(requests[2]!.key).not.toBe(requests[0]!.key);
});
