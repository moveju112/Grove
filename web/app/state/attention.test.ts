import { describe, expect, it } from "vitest";
import type { EventRecord } from "../api/generated";
import { attentionFor, claimAttention } from "./attention";
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
