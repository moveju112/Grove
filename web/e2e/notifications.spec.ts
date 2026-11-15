import { expect, test } from "@playwright/test";
import { frames } from "./fixture";
import { apiCall, ensureProfile, ensureProjects, login, state } from "./helpers";

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

async function removeSchedule(id: string) {
    const current = await apiCall<{ revision: number }>("GET", `/schedules/${id}`);
    await apiCall("POST", `/schedules/${id}/delete`, { expected_revision: current.revision });
}

test("알림 메뉴를 제거해도 서버 기록은 보존하고 자동 전달·읽음 처리나 모델 재실행은 하지 않는다", async ({ page }) => {
    const name = `원격 전달 ${Date.now()}`;
    const command = await remoteCommand(name);
    try {
        const saved = (await command.notes()).items[0]!;
        expect(saved.delivered_at).toBeNull();
        expect(saved.read_at).toBeNull();
        const inboxRequests: string[] = [];
        page.on("request", (request) => {
            if (/\/api\/v1\/notifications(?:[/?]|$)/.test(request.url())) inboxRequests.push(request.url());
        });
        await login(page);
        await expect(page.getByTestId("notifications")).toHaveCount(0);
        await expect(page.getByRole("button", { name: "알림", exact: true, includeHidden: true })).toHaveCount(0);
        expect((await command.notes()).items[0]!.delivered_at).toBeNull();
        expect((await command.notes()).items[0]!.read_at).toBeNull();
        await page.reload();
        await expect(page.getByTestId("conn")).toHaveText("연결됨");
        expect(inboxRequests).toEqual([]);
        const preserved = (await command.notes()).items[0]!;
        expect(preserved).toEqual(saved);
        // 메뉴 제거는 기존 API·영속 기록을 삭제하거나 서버 확인 절차를 바꾸지 않는다.
        await apiCall("POST", "/notifications/delivered", { ids: [saved.id] });
        await apiCall("POST", `/notifications/${saved.id}/read`);
        const confirmed = (await command.notes()).items[0]!;
        expect(confirmed.delivered_at).not.toBeNull();
        expect(confirmed.read_at).not.toBeNull();
        const runs = await command.runs();
        expect(runs).toHaveLength(1);
        expect(runs[0]!.status).toBe("completed");
    } finally {
        await removeSchedule(command.schedule.id);
    }
});
