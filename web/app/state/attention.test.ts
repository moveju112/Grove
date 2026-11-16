import { afterEach, describe, expect, it, vi } from "vitest";
import type { EventRecord } from "../api/generated";
import { attentionFor, claimAttention, showAttention } from "./attention";
import { defaultPrefs } from "./device";

const all = { ...defaultPrefs, notifyDone: true, notifyApproval: true, notifyServer: true };
const event = (kind: string, payload: unknown): EventRecord => ({ seq: 1, created_at: "2026-01-01T00:00:00Z", kind, project_id: "p", session_id: "s", payload });
const memory = () => {
    const data = new Map<string, string>();
    return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v) };
};

describe("이 기기 알림 판단", () => {
    it("켠 종류만 알리고 대화 내용 없이 대상 대화를 가리킨다", () => {
        expect(attentionFor(event("turn.updated", { id: "t", status: "completed", error: "secret" }), all)).toMatchObject({ kind: "done", tag: "turn:t", projectId: "p", sessionId: "s" });
        expect(attentionFor(event("turn.updated", { id: "t", status: "interrupted" }), all)?.kind).toBe("failed");
        expect(attentionFor(event("turn.updated", { id: "t", status: "awaiting_approval" }), all)?.tag).toBe("approval:t");
        expect(attentionFor(event("notification.created", { id: "n", title: "예약 완료" }), all)).toMatchObject({ kind: "server", title: "예약 완료" });
        expect(JSON.stringify(attentionFor(event("turn.updated", { id: "t", status: "completed", error: "secret" }), all))).not.toContain("secret");
    });
    it("기본값·꺼진 종류·진행 중·사용자 취소는 알리지 않는다", () => {
        expect(attentionFor(event("turn.updated", { id: "t", status: "completed" }), defaultPrefs)).toBeNull();
        expect(attentionFor(event("turn.updated", { id: "t", status: "awaiting_approval" }), { ...all, notifyApproval: false })).toBeNull();
        expect(attentionFor(event("turn.updated", { id: "t", status: "running" }), all)).toBeNull();
        expect(attentionFor(event("turn.updated", { id: "t", status: "cancelled" }), all)).toBeNull();
        expect(attentionFor(event("message.created", { id: "m" }), all)).toBeNull();
    });
    it("같은 사건은 여러 탭에서 한 번만 알리고 오래된 기록은 정리한다", () => {
        const storage = memory();
        expect(claimAttention("turn:t", 1000, storage)).toBe(true);
        expect(claimAttention("turn:t", 2000, storage)).toBe(false);
        expect(claimAttention("approval:t", 2000, storage)).toBe(true);
        expect(claimAttention("turn:t", 1000 + 10 * 60_000, storage)).toBe(true);
        storage.setItem("grove.attention.claims", "{broken");
        expect(claimAttention("turn:x", 1, storage)).toBe(true);
    });
});


describe("모바일 시스템 알림", () => {
    afterEach(() => vi.unstubAllGlobals());
    it("모바일에서 지원하지 않는 Notification 생성자 대신 worker를 사용하고 진동과 대상만 넘긴다", async () => {
        const showNotification = vi.fn().mockResolvedValue(undefined);
        const Constructor = vi.fn(() => { throw new Error("mobile constructor unsupported"); });
        Object.assign(Constructor, { permission: "granted" });
        vi.stubGlobal("Notification", Constructor);
        vi.stubGlobal("navigator", { serviceWorker: { getRegistration: async () => ({ active: {}, showNotification }) } });
        vi.stubGlobal("location", { origin: "https://grove.test" });
        vi.stubGlobal("localStorage", { getItem: () => null });
        expect(await showAttention({ kind: "done", title: "작업 완료", body: "끝났습니다", tag: "turn:t", projectId: "p", sessionId: "s" }, false, true)).toBe(true);
        expect(Constructor).not.toHaveBeenCalled();
        expect(showNotification).toHaveBeenCalledWith("작업 완료", expect.objectContaining({ vibrate: [180, 80, 180], data: expect.objectContaining({ projectId: "p", sessionId: "s" }), tag: expect.stringMatching(/^[0-9a-f]{64}:turn:t$/) }));
    });
    it("알림 전달 실패를 성공으로 표시하거나 예외로 전파하지 않는다", async () => {
        vi.stubGlobal("Notification", { permission: "granted" });
        vi.stubGlobal("navigator", { serviceWorker: { getRegistration: async () => { throw new Error("worker unavailable"); } } });
        expect(await showAttention({ kind: "server", title: "시험", body: "시험", tag: "test", projectId: null, sessionId: null }, false, false)).toBe(false);
    });
});
