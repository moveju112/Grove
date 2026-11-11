import { expect, test, type Page } from "@playwright/test";
import { frames } from "./fixture";
import { apiCall, ensureProfile, ensureProjects, login, openDetails, state } from "./helpers";

type Note = { id: string; title: string; delivered_at: string | null; read_at: string | null };
type Run = { id: string; status: string; session_id: string | null };

async function remoteCommand(name: string) {
    const { a } = await ensureProjects();
    const profile = await ensureProfile();
    const schedule = await apiCall<{ id: string }>("POST", `/projects/${a.id}/schedules`, {
        name, prompt: "한 번 결과를 저장해", profile_id: profile, kind: "interval", interval_minutes: 600,
    });
    await fetch(`http://127.0.0.1:${state().fixturePort}/script`, {
        method: "POST", body: JSON.stringify({ frames: frames.text(["원격 명령 결과"]), delayMs: 100 }),
    });
    const response = await fetch(`http://127.0.0.1:17741/api/v1/schedules/${schedule.id}/run`, {
        method: "POST", headers: { authorization: `Bearer ${state().token}`, "idempotency-key": `remote-${schedule.id}` },
    });
    expect(response.status).toBe(202);
    const receipt = await response.json() as Run;
    expect(receipt.status).not.toBe("completed");
    const runs = () => apiCall<Run[]>("GET", `/schedules/${schedule.id}/runs`);
    await expect.poll(async () => (await runs()).find((r) => r.id === receipt.id)?.status, { timeout: 15_000 }).toBe("completed");
    const notes = () => apiCall<{ items: Note[] }>("GET", `/notifications?ref_id=${receipt.id}`);
    await expect.poll(async () => (await notes()).items.length).toBe(1);
    return { schedule, runs, notes };
}

async function openNotes(page: Page) {
    const notes = page.getByTestId("notifications");
    await openDetails(notes);
    return notes;
}

async function removeSchedule(id: string) {
    const current = await apiCall<{ revision: number }>("GET", `/schedules/${id}`);
    await apiCall("POST", `/schedules/${id}/delete`, { expected_revision: current.revision });
}

test("원격 접수·저장·앱 전달·명시적 열람은 별개이고 다시 모델을 실행하지 않는다", async ({ page }) => {
    const name = `원격 전달 ${Date.now()}`;
    const command = await remoteCommand(name);
    try {
        const saved = (await command.notes()).items[0]!;
        expect(saved.delivered_at).toBeNull();
        expect(saved.read_at).toBeNull();
        await login(page);
        await expect.poll(async () => (await command.notes()).items[0]!.delivered_at !== null).toBe(true);
        expect((await command.notes()).items[0]!.read_at).toBeNull();
        const notes = await openNotes(page);
        const item = notes.getByTestId("notification").filter({ hasText: name });
        await expect(item.getByTestId("notification-delivery")).toHaveText("서버 저장됨 · 앱 전달 확인 · 미열람");
        await item.getByRole("button").click();
        await expect.poll(async () => (await command.notes()).items[0]!.read_at !== null).toBe(true);
        await expect(page.getByTestId("session-view")).toContainText("원격 명령 결과");
        const confirmed = (await command.notes()).items[0]!;
        await page.reload();
        await expect(page.getByTestId("conn")).toHaveText("연결됨");
        const after = (await command.notes()).items[0]!;
        expect(after.delivered_at).toBe(confirmed.delivered_at);
        expect(after.read_at).toBe(confirmed.read_at);
        const runs = await command.runs();
        expect(runs).toHaveLength(1);
        expect(runs[0]!.status).toBe("completed");
    } finally {
        await removeSchedule(command.schedule.id);
    }
});

test("전달·읽음 응답 실패는 성공으로 표시하지 않고 재확인으로 복구한다", async ({ page }) => {
    const name = `전달 복구 ${Date.now()}`;
    const command = await remoteCommand(name);
    try {
        await page.route("**/api/v1/notifications/delivered", (route) => route.abort("connectionreset"));
        await login(page);
        const notes = await openNotes(page);
        const item = notes.getByTestId("notification").filter({ hasText: name });
        await expect(item.getByTestId("notification-delivery")).toContainText("앱 전달 미확인");
        await expect(notes.getByRole("alert")).toContainText("앱 전달 미확인");
        expect((await command.notes()).items[0]!.delivered_at).toBeNull();
        await page.unroute("**/api/v1/notifications/delivered");
        await notes.getByRole("button", { name: "전달 다시 확인" }).click();
        await expect(item.getByTestId("notification-delivery")).toHaveText("서버 저장됨 · 앱 전달 확인 · 미열람");
        expect((await command.notes()).items[0]!.read_at).toBeNull();
        await page.route("**/api/v1/notifications/*/read", (route) => route.abort("connectionreset"));
        await item.getByRole("button").click();
        await expect(notes.getByRole("alert")).toBeVisible();
        expect((await command.notes()).items[0]!.read_at).toBeNull();
        await page.unroute("**/api/v1/notifications/*/read");
        await item.getByRole("button").click();
        await expect.poll(async () => (await command.notes()).items[0]!.read_at !== null).toBe(true);
        expect(await command.runs()).toHaveLength(1);
    } finally {
        await removeSchedule(command.schedule.id);
    }
});
