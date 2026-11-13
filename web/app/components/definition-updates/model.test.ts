import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DefinitionDetail } from "../../api/generated";
import { clearDeviceCopies } from "../../state/cleanup";
import { key, load, save } from "../../state/drafts";
import { DefinitionUpdates } from "./DefinitionUpdates";
import { loadAttempt, recoveryKey, restoreBody, type Attempt } from "./model";

const definition: DefinitionDetail = {
    kind: "agent", id: "reviewer", name: "<script>user</script>", description: "사용자 설명", body: "사용자 본문",
    baseline_name: "<img src=x onerror=alert(1)>", baseline_description: "새 번들 설명", baseline_body: "새 번들 본문",
    builtin: true, enabled: false, revision: 7, modified_fields: ["name", "description", "body"],
    baseline_sha256: "sha256", body_sha256: "user-sha256",
};
function storage() {
    const values = new Map<string, string>();
    return {
        get length() { return values.size; },
        key: (i: number) => [...values.keys()][i] ?? null,
        getItem: (k: string) => values.get(k) ?? null,
        setItem: (k: string, v: string) => { values.set(k, v); },
        removeItem: (k: string) => { values.delete(k); },
        clear: () => values.clear(),
    };
}
afterEach(() => vi.unstubAllGlobals());
describe("기본 정의 선택 적용·복구 계약", () => {
    it("선택 필드와 revision 및 모든 비교 baseline을 고정하고 enabled·초안을 보내지 않는다", () => {
        const attempt: Attempt = { key: "request-1", definition, fields: ["name", "description"] };
        expect(restoreBody(attempt)).toEqual({
            expected_revision: 7, fields: ["name", "description"],
            expected_baseline: { name: definition.baseline_name, description: definition.baseline_description, body: definition.baseline_body, sha256: "sha256" },
        });
        const store = storage();
        store.setItem(recoveryKey("agent", "reviewer"), JSON.stringify(attempt));
        expect(loadAttempt(store, "agent", "reviewer")).toEqual(attempt);
        expect(loadAttempt(store, "agent", "other")).toBeNull();
        const draftKey = key("definition.agent.reviewer");
        save(store, draftKey, { text: "미저장 초안", baseRevision: 7, updatedAt: 1 });
        expect(load(store, draftKey)?.text).toBe("미저장 초안");
        clearDeviceCopies(store);
        expect(store.length).toBe(0);
    });
    it("재시작 시 저장된 요청만 복구하고 원문 HTML은 실행하지 않는다", () => {
        const store = storage();
        store.setItem(recoveryKey("agent", "reviewer"), JSON.stringify({ key: "request-1", definition, fields: ["body"] }));
        vi.stubGlobal("localStorage", store);
        const html = renderToStaticMarkup(createElement(DefinitionUpdates, {
            definition, draft: "<script>draft</script>", onLocked: () => {}, onApplied: () => {}, onDraftReviewed: () => {},
        }));
        expect(html).toContain("원래 복원 요청 결과 확인");
        expect(html).toContain("비활성");
        expect(html).toContain("&lt;script&gt;user&lt;/script&gt;");
        expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
        expect(html).toContain("&lt;script&gt;draft&lt;/script&gt;");
        expect(html).not.toContain("<script>");
        expect(html).not.toContain("<img");
        expect(html).not.toContain("선택한 필드만 기본값 적용");
    });
    it("손상되거나 다른 대상의 요청은 새 mutation 대신 복구 오류로 남긴다", () => {
        const store = storage();
        for (const raw of ["invalid", JSON.stringify({ key: "k", definition: { ...definition, id: "other" }, fields: ["body"] }),
            JSON.stringify({ key: "k", definition, fields: ["enabled"] })]) {
            store.setItem(recoveryKey("agent", "reviewer"), raw);
            expect(() => loadAttempt(store, "agent", "reviewer")).toThrow();
        }
    });
});
