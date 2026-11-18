import { describe, expect, it } from "vitest";
import { clearInvalidRecovery, loadRecovery, saveRecovery, settleRecovery, type PendingSend } from "./sendRecovery";
import { sendOptionsSignature } from "./sendOptions";

class MemoryStorage implements Storage {
    values = new Map<string, string>();
    get length() { return this.values.size; }
    key(i: number) { return [...this.values.keys()][i] ?? null; }
    getItem(k: string) { return this.values.get(k) ?? null; }
    setItem(k: string, value: string) { this.values.set(k, value); }
    removeItem(k: string) { this.values.delete(k); }
    clear() { this.values.clear(); }
}
const intent = { mode: "model" as const, profileId: "model", agentId: null, tools: false, effort: "max" as const, serviceTier: "priority" };
const request: PendingSend = {
    body: "/hello", raw: "//hello", key: "once", intent, options: intent,
    attachmentIds: ["a"], attachments: [{ id: "a", project_id: "p", name: "a.txt", mime: "text/plain", size: 1, stored: false }],
    sig: sendOptionsSignature(intent, ["a"]), follow: "queue",
};

describe("전송 결과 확인", () => {
    it("보내기 전에는 기록이 없고 이미 보낸 요청만 원래 옵션·첨부·키로 복원한다", () => {
        const store = new MemoryStorage();
        expect(loadRecovery(store, "session:s", "tab")).toEqual({ pending: null, invalid: false });
        expect(store.length).toBe(0);
        saveRecovery(store, "session:s", "tab", request);
        expect(loadRecovery(store, "session:s", "tab")).toEqual({ pending: request, invalid: false });
        expect(loadRecovery(store, "session:s", "new-tab").pending).toEqual(request);
        expect(loadRecovery(store, "session:other", "tab").pending).toBeNull();
        expect(loadRecovery(store, "project:s", "tab").pending).toBeNull();
    });
    it("같은 요청의 확인 기록만 지우며 다른 요청과 자원은 보존한다", () => {
        const store = new MemoryStorage();
        saveRecovery(store, "session:s", "one", request);
        saveRecovery(store, "session:s", "two", request);
        saveRecovery(store, "session:s", "other", { ...request, key: "different" });
        saveRecovery(store, "session:other", "one", request);
        settleRecovery(store, "session:s", request.key);
        expect(store.length).toBe(2);
        expect(loadRecovery(store, "session:s", "other").pending?.key).toBe("different");
        expect(loadRecovery(store, "session:other", "one").pending).toEqual(request);
    });
    it.each([
        "{broken", JSON.stringify({ ...request, sig: "wrong" }),
        JSON.stringify({ ...request, options: { ...intent, mode: "unknown" } }),
        JSON.stringify({ ...request, follow: "unknown" }),
    ])("손상된 확인 기록은 새 키로 추측하지 않고 명시적인 기록 확인을 요구한다", (raw) => {
        const store = new MemoryStorage();
        store.setItem("grove.send.session:s#tab", raw);
        expect(loadRecovery(store, "session:s", "tab")).toEqual({ pending: null, invalid: true });
        saveRecovery(store, "session:s", "valid", request);
        clearInvalidRecovery(store, "session:s");
        expect(store.length).toBe(1);
        expect(loadRecovery(store, "session:s", "valid").pending).toEqual(request);
    });
    it("사용하지 않는 이전 초안은 읽거나 복원하지 않는다", () => {
        const store = new MemoryStorage();
        store.setItem("grove.draft.session:s#tab", JSON.stringify({ text: "old input", pending: request }));
        expect(loadRecovery(store, "session:s", "tab")).toEqual({ pending: null, invalid: false });
    });
    it("저장 실패는 전송 호출부에 전달하고 기존 확인 기록은 보존한다", () => {
        const store = new MemoryStorage();
        saveRecovery(store, "session:s", "tab", request);
        store.setItem = () => { throw new DOMException("quota", "QuotaExceededError"); };
        expect(() => saveRecovery(store, "session:s", "tab", { ...request, key: "new" })).toThrow("quota");
        expect(loadRecovery(store, "session:s", "tab").pending).toEqual(request);
    });
});
