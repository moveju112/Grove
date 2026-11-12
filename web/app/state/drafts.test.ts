import { describe, expect, it } from "vitest";
import { compare, key, load, save, settleSend, siblingCopies, type DraftAttachment, type PendingSend } from "./drafts";

class Mem {
    m = new Map<string, string>();
    get length() {
        return this.m.size;
    }
    key(i: number) {
        return [...this.m.keys()][i] ?? null;
    }
    getItem(k: string) {
        return this.m.get(k) ?? null;
    }
    setItem(k: string, v: string) {
        this.m.set(k, v);
    }
    removeItem(k: string) {
        this.m.delete(k);
    }
}

const srv = (text: string, revision: number) => ({ text, revision, device_name: "pc", updated_at: "t" });
const attachment: DraftAttachment = { id: "a", project_id: "p", name: "fixture.txt", mime: "text/plain", size: 10, stored: false };
const options = { mode: "save" as const, profileId: null, agentId: null, tools: false };
const pending: PendingSend = {
    body: "/hello", raw: "//hello", key: "request-once", options, intent: options, attachmentIds: ["a"],
    sig: '[{"mode":"save","profileId":null,"agentId":null,"tools":false,"effort":"auto"},["a"]]',
};

describe("drafts", () => {
    it("첨부만 있는 이전 형식도 사본 하나로 정규화하고 전송 본문·키를 보존한다", () => {
        const s = new Mem();
        s.setItem(`${key("session:x", "old")}:attachments`, JSON.stringify([attachment]));
        expect(siblingCopies(s, "session:x")).toHaveLength(1);
        expect(siblingCopies(s, "session:x")[0]!.draft.attachments).toEqual([attachment]);
        save(s, key("session:x", "new"), { text: pending.raw, baseRevision: 0, updatedAt: 1, attachments: [attachment], pending });
        expect(load(s, key("session:x", "new"))?.pending).toEqual(pending);
        expect(siblingCopies(s, "session:x")).toHaveLength(2);
    });
    it("확정된 요청의 모든 사본에서 보낸 입력만 지우고 후속 입력·첨부·다른 요청은 남긴다", () => {
        const s = new Mem();
        const draft = { text: pending.raw, baseRevision: 0, updatedAt: 1, attachments: [attachment], pending };
        save(s, key("session:x", "one"), draft);
        save(s, key("session:x", "two"), { ...draft, text: "다음 입력", attachments: [attachment, { ...attachment, id: "b" }] });
        save(s, key("session:x", "other"), { ...draft, pending: { ...pending, key: "another-request" } });
        save(s, key("session:y"), draft);
        settleSend(s, "session:x", pending.key, true);
        expect(load(s, key("session:x", "one"))).toBeNull();
        expect(load(s, key("session:x", "two"))).toMatchObject({ text: "다음 입력", pending: undefined, attachments: [{ ...attachment, id: "b" }] });
        expect(load(s, key("session:x", "other"))?.pending?.key).toBe("another-request");
        expect(load(s, key("session:y"))?.pending).toEqual(pending);
    });
    it("확정 거부는 입력·첨부를 남기고 보류 요청만 정리한다", () => {
        const s = new Mem();
        save(s, key("session:x"), { text: pending.raw, baseRevision: 0, updatedAt: 1, attachments: [attachment], pending });
        settleSend(s, "session:x", pending.key, false);
        expect(load(s, key("session:x"))).toMatchObject({ text: pending.raw, attachments: [attachment], pending: undefined });
    });
    it("손상된 전송 키 사본은 새 요청으로 추측하지 않고 별도 상태로 알린다", () => {
        const s = new Mem();
        s.setItem(key("session:x"), JSON.stringify({ text: "남겨야 할 입력", baseRevision: 0, updatedAt: 1, pending: { ...pending, sig: "broken" } }));
        expect(load(s, key("session:x"))).toMatchObject({ text: "남겨야 할 입력", pending: undefined, pendingInvalid: true });
    });
    it("classifies local vs server", () => {
        expect(compare(null, srv("", 0)).kind).toBe("empty");
        expect(compare(null, srv("서버", 2)).kind).toBe("server_newer");
        expect(compare({ text: "a", baseRevision: 1, updatedAt: 0 }, srv("a", 1)).kind).toBe("in_sync");
        expect(compare({ text: "로컬", baseRevision: 1, updatedAt: 0 }, srv("서버", 1)).kind).toBe("local_only");
        expect(compare({ text: "로컬", baseRevision: 1, updatedAt: 0 }, srv("폰", 2)).kind).toBe("conflict");
    });

    it("persists per copy and finds siblings", () => {
        const s = new Mem();
        save(s, key("session:x"), { text: "왼쪽", baseRevision: 0, updatedAt: 1 });
        save(s, key("session:x", "tab2"), { text: "오른쪽", baseRevision: 0, updatedAt: 2 });
        save(s, key("session:y"), { text: "다른", baseRevision: 0, updatedAt: 3 });
        expect(load(s, key("session:x"))?.text).toBe("왼쪽");
        expect(siblingCopies(s, "session:x").map((c) => c.draft.text).sort()).toEqual(["오른쪽", "왼쪽"]);
        save(s, key("session:x"), { text: "", baseRevision: 0, updatedAt: 4 });
        expect(load(s, key("session:x"))).toBeNull();
        s.setItem(key("session:z"), "{broken");
        expect(load(s, key("session:z"))).toBeNull();
    });
});
