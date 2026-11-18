import { describe, expect, it } from "vitest";
import { ComposerMemory } from "./composerMemory";

describe("열린 탭의 입력 메모리", () => {
    it("재배치 후 같은 탭의 입력과 첨부를 같은 상태로 구독한다", () => {
        const memory = new ComposerMemory();
        const text = memory.cell("session:a", "tab-a", "text", () => "");
        text.set("합친 뒤에도 남을 입력");
        const files = memory.cell("session:a", "tab-a", "files", () => [] as string[]);
        files.set(["attachment-a"]);
        memory.retain(new Set(["tab-a", "tab-b"]));
        const remounted = memory.cell("session:a", "tab-a", "text", () => "");
        expect(remounted).toBe(text);
        expect(remounted.read()).toBe("합친 뒤에도 남을 입력");
        expect(memory.cell("session:a", "tab-a", "files", () => []).read()).toEqual(["attachment-a"]);
        let notifications = 0;
        const unsubscribe = remounted.subscribe(() => { notifications++; });
        text.set((value) => value + " 계속");
        expect(remounted.read()).toBe("합친 뒤에도 남을 입력 계속");
        expect(notifications).toBe(1);
        unsubscribe();
        text.set("");
        expect(notifications).toBe(1);
    });

    it("같은 세션의 다른 탭·다른 자원·다른 배치와 입력을 섞지 않는다", () => {
        const memory = new ComposerMemory();
        memory.cell("session:a", "tab-a", "text", () => "").set("A");
        expect(memory.cell("session:a", "tab-b", "text", () => "").read()).toBe("");
        expect(memory.cell("project:a", "tab-a", "text", () => "").read()).toBe("");
        expect(new ComposerMemory().cell("session:a", "tab-a", "text", () => "").read()).toBe("");
    });

    it("닫힌 탭은 버리고 늦게 완료된 작업도 입력을 되살리지 않는다", () => {
        const memory = new ComposerMemory();
        const closed = memory.cell("session:a", "tab-a", "text", () => "");
        closed.set("닫힌 입력");
        memory.retain(new Set());
        const reopened = memory.cell("session:a", "tab-a", "text", () => "");
        closed.set("늦은 응답");
        expect(reopened.read()).toBe("");
        reopened.set("새 입력");
        expect(reopened.read()).toBe("새 입력");
    });
});
