import { describe, expect, it } from "vitest";
import { hasProjectInput, key, save, type Store } from "./drafts";

function storage(): Store {
    const values = new Map<string, string>();
    return { getItem: (k) => values.get(k) ?? null, setItem: (k, v) => { values.set(k, v); }, removeItem: (k) => { values.delete(k); } };
}

describe("프로젝트 입력창 복원", () => {
    it("빈 프로젝트나 다른 탭·프로젝트 초안으로는 입력창을 열지 않는다", () => {
        const store = storage();
        expect(hasProjectInput(null, "p", "a")).toBe(false);
        expect(hasProjectInput(store, "p", "a")).toBe(false);
        save(store, key("project:p", "b"), { text: "다른 탭", baseRevision: 0, updatedAt: 1 });
        save(store, key("project:q", "a"), { text: "다른 프로젝트", baseRevision: 0, updatedAt: 1 });
        expect(hasProjectInput(store, "p", "a")).toBe(false);
    });
    it("현재 탭의 글·첨부·결과 미확정 입력은 복원한다", () => {
        const store = storage();
        const localKey = key("project:p", "a");
        save(store, localKey, { text: "작성 중", baseRevision: 0, updatedAt: 1 });
        expect(hasProjectInput(store, "p", "a")).toBe(true);
        save(store, localKey, { text: "", baseRevision: 0, updatedAt: 1, attachments: [
            { id: "file", project_id: "p", name: "file.txt", mime: "text/plain", size: 1, stored: true },
        ] });
        expect(hasProjectInput(store, "p", "a")).toBe(true);
        save(store, localKey, { text: "", baseRevision: 0, updatedAt: 1, attachments: [], pendingInvalid: true });
        expect(hasProjectInput(store, "p", "a")).toBe(true);
        save(store, localKey, { text: "", baseRevision: 0, updatedAt: 1, attachments: [] });
        expect(hasProjectInput(store, "p", "a")).toBe(false);
    });
});
