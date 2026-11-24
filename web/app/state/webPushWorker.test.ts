import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
const scope = "https://grove.test/grove/";
const payload = { scope, server: "a".repeat(64), tag: "turn:t", projectId: "p", sessionId: "s", vibrate: true };
function worker(records = new Map<string, string>()) {
    const handlers = new Map<string, (event: unknown) => void>();
    const showNotification = vi.fn().mockResolvedValue(undefined);
    const openWindow = vi.fn().mockResolvedValue(undefined);
    const client = { url: `${scope}app`, postMessage: vi.fn(), focus: vi.fn().mockResolvedValue(undefined) };
    const matchAll = vi.fn().mockResolvedValue([client]);
    const cache = {
        match: vi.fn(async (key: string) => records.has(key) ? new Response(records.get(key)) : undefined),
        put: vi.fn(async (key: string, value: Response) => { records.set(key, await value.text()); }),
        keys: vi.fn(async () => [...records.keys()]),
        delete: vi.fn(async (key: string) => records.delete(key)),
    };
    runInNewContext(readFileSync(new URL("../../public/sw.js", import.meta.url), "utf8"), {
        URL, Map, Set, Response,
        caches: { open: async () => cache },
        self: { registration: { scope, showNotification }, clients: { matchAll, openWindow }, addEventListener: (kind: string, handler: (event: unknown) => void) => handlers.set(kind, handler) },
    });
    const dispatch = async (kind: string, event: Record<string, unknown>) => {
        let pending = Promise.resolve();
        handlers.get(kind)!({ ...event, waitUntil: (p: Promise<void>) => { pending = p; } });
        await pending;
    };
    const diagnostics = async (testId: string) => {
        const port = { postMessage: vi.fn(), close: vi.fn() };
        await dispatch("message", { data: { type: "push-test-status", testId }, source: client, ports: [port] });
        expect(port.close).toHaveBeenCalledOnce();
        return port.postMessage.mock.calls[0]![0];
    };
    return { showNotification, openWindow, client, matchAll, dispatch, records, cache, diagnostics };
}
describe("앱 종료 후 Push worker", () => {
    it("완료 알림은 최종 답변과 진동을 표시하고 다른 scope와 잘못된 식별자는 거부한다", async () => {
        const w = worker();
        await w.dispatch("push", { data: { json: () => ({ ...payload, body: "최종 답변" }) } });
        expect(w.showNotification).toHaveBeenCalledWith("작업 완료", expect.objectContaining({ body: "최종 답변", tag: `${payload.server}:turn:t`, vibrate: [180, 80, 180],
            data: { projectId: "p", sessionId: "s", server: payload.server } }));
        await w.dispatch("push", { data: { json: () => ({ ...payload, scope: "https://other.test/" }) } });
        await w.dispatch("push", { data: { json: () => ({ ...payload, sessionId: "../other" }) } });
        expect(w.showNotification).toHaveBeenCalledTimes(1);
        await w.dispatch("push", { data: { json: () => payload } });
        expect(w.showNotification).toHaveBeenLastCalledWith("작업 완료", expect.objectContaining({ body: "대화의 요청 처리가 끝났습니다." }));
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
    it("Push 수신·등록 기록은 워커가 재시작돼도 남고 payload나 구독 정보는 저장하지 않는다", async () => {
        const w = worker();
        const data = { scope, server: payload.server, test: true, testId: "receipt", tag: "test:receipt", extra: "private payload marker" };
        await w.dispatch("push", { data: { json: () => data } });
        const nextWorker = worker(w.records);
        expect(await nextWorker.diagnostics("receipt")).toMatchObject({ testId: "receipt", storageError: false,
            receipt: { stage: "registered", error: null, version: "__GROVE_BUILD__" } });
        expect([...w.records.values()].join("")).not.toContain("private payload marker");
        expect(await nextWorker.diagnostics("missing")).toMatchObject({ receipt: null, storageError: false });
    });
    it("수신 후 검증 거부와 표시 API 실패를 구분하고 표시 실패를 숨기지 않는다", async () => {
        const w = worker();
        const data = { scope, server: payload.server, test: true, testId: "receipt", tag: "test:receipt" };
        await w.dispatch("push", { data: { json: () => ({ ...data, scope: "https://other.test/" }) } });
        expect(await w.diagnostics("receipt")).toMatchObject({ receipt: { stage: "rejected", error: "push_envelope_invalid" } });
        await w.dispatch("push", { data: { json: () => ({ ...data, tag: "test:other" }) } });
        expect(await w.diagnostics("receipt")).toMatchObject({ receipt: { stage: "rejected", error: "push_target_invalid" } });
        w.showNotification.mockRejectedValueOnce(new DOMException("blocked", "NotAllowedError"));
        await expect(w.dispatch("push", { data: { json: () => data } })).rejects.toMatchObject({ name: "NotAllowedError" });
        expect(await w.diagnostics("receipt")).toMatchObject({ receipt: { stage: "display_failed", error: "NotAllowedError" } });
    });
    it("진단 저장 실패가 알림을 막지 않으며 저장 오류를 조회 결과에 남긴다", async () => {
        const w = worker();
        w.cache.put.mockRejectedValue(new Error("cache unavailable"));
        await w.dispatch("push", { data: { json: () => ({ scope, server: payload.server, test: true, testId: "t", tag: "test:t" }) } });
        expect(w.showNotification).toHaveBeenCalledOnce();
        expect(await w.diagnostics("t")).toMatchObject({ storageError: true, receipt: null });
    });
    it("기기 안의 진단은 최근 16개만 남기고 다른 scope의 조회는 응답하지 않는다", async () => {
        const w = worker();
        for (let i = 0; i < 18; i++) {
            await w.dispatch("push", { data: { json: () => ({ scope, server: payload.server, test: true, testId: `t${i}`, tag: `test:t${i}` }) } });
        }
        expect(w.records.size).toBe(16);
        expect(await w.diagnostics("t0")).toMatchObject({ receipt: null });
        const port = { postMessage: vi.fn() };
        await w.dispatch("message", { data: { type: "push-test-status", testId: "t17" }, source: { url: "https://other.test/" }, ports: [port] });
        expect(port.postMessage).not.toHaveBeenCalled();
    });
});
