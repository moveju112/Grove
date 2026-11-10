import { describe, expect, it } from "vitest";
import { compare, key, load, save, siblingCopies } from "./drafts";

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

describe("drafts", () => {
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
