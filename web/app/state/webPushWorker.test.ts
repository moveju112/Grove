import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
const scope = "https://grove.test/grove/";
const payload = { scope, server: "a".repeat(64), tag: "turn:t", projectId: "p", sessionId: "s", vibrate: true };
function worker() {
    const handlers = new Map<string, (event: unknown) => void>();
    const showNotification = vi.fn().mockResolvedValue(undefined);
    const openWindow = vi.fn().mockResolvedValue(undefined);
    const client = { url: `${scope}app`, postMessage: vi.fn(), focus: vi.fn().mockResolvedValue(undefined) };
    const matchAll = vi.fn().mockResolvedValue([client]);
    runInNewContext(readFileSync(new URL("../../public/sw.js", import.meta.url), "utf8"), {
        URL, Map, Set, Response,
        self: { registration: { scope, showNotification }, clients: { matchAll, openWindow }, addEventListener: (kind: string, handler: (event: unknown) => void) => handlers.set(kind, handler) },
    });
    const dispatch = async (kind: string, event: Record<string, unknown>) => {
        let pending = Promise.resolve();
        handlers.get(kind)!({ ...event, waitUntil: (p: Promise<void>) => { pending = p; } });
        await pending;
    };
    return { showNotification, openWindow, client, matchAll, dispatch };
}
describe("앱 종료 후 Push worker", () => {
    it("암호 해제된 완료 알림은 상태·진동·대상만 표시하고 다른 scope와 잘못된 식별자는 거부한다", async () => {
        const w = worker();
        await w.dispatch("push", { data: { json: () => payload } });
        expect(w.showNotification).toHaveBeenCalledWith("작업 완료", expect.objectContaining({ tag: `${payload.server}:turn:t`, vibrate: [180, 80, 180], data: payload }));
        await w.dispatch("push", { data: { json: () => ({ ...payload, scope: "https://other.test/" }) } });
        await w.dispatch("push", { data: { json: () => ({ ...payload, sessionId: "../other" }) } });
        expect(w.showNotification).toHaveBeenCalledTimes(1);
    });
    it("알림을 누르면 열린 앱에 대상을 보내거나 닫힌 앱을 scope 안의 주소로 연다", async () => {
        const w = worker();
        const close = vi.fn();
        await w.dispatch("notificationclick", { notification: { data: payload, close } });
        expect(close).toHaveBeenCalledOnce();
        expect(w.client.postMessage).toHaveBeenCalledWith({ type: "open-session", projectId: "p", sessionId: "s", server: payload.server });
        expect(w.client.focus).toHaveBeenCalledOnce();
        w.matchAll.mockResolvedValue([]);
        await w.dispatch("notificationclick", { notification: { data: payload, close } });
        const url = new URL(w.openWindow.mock.calls[0]![0]);
        expect(url.origin + url.pathname).toBe(scope);
        expect(url.searchParams.get("notify_session")).toBe("s");
        expect(url.searchParams.get("notify_server")).toBe(payload.server);
    });
    it("실제 Push 시험은 가짜 대화 없이 표시하고 누르면 앱만 연다", async () => {
        const w = worker();
        const data = { scope, server: payload.server, test: true, testId: "test-id", tag: "test:test-id", vibrate: true };
        await w.dispatch("push", { data: { json: () => data } });
        expect(w.showNotification).toHaveBeenCalledWith("Grove 실제 Push 시험", expect.objectContaining({
            body: "서버에서 Push로 도착한 시험 알림이야.", tag: `${data.server}:${data.tag}`,
            icon: `${scope}icon-192.png`, vibrate: [180, 80, 180],
        }));
        await w.dispatch("push", { data: { json: () => ({ ...data, testId: "../bad" }) } });
        await w.dispatch("push", { data: { json: () => ({ ...data, tag: "test:wrong" }) } });
        expect(w.showNotification).toHaveBeenCalledOnce();
        await w.dispatch("notificationclick", { notification: { data, close: vi.fn() } });
        expect(w.client.focus).toHaveBeenCalledOnce();
        expect(w.client.postMessage).not.toHaveBeenCalled();
        w.matchAll.mockResolvedValue([]);
        await w.dispatch("notificationclick", { notification: { data, close: vi.fn() } });
        expect(w.openWindow).toHaveBeenCalledWith(scope);
    });
});
