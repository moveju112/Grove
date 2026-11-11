import { describe, expect, it } from "vitest";
import { hasCapability, onCapabilities, setCapabilities } from "../api/client";

describe("서버 기능 목록(NET-001)", () => {
    it("받기 전에는 모름(null)이고, 받은 뒤에는 있는 기능만 true", () => {
        expect(hasCapability("worktrees_v1")).toBeNull();
        setCapabilities(["worktrees_v1", 3, "trash_v1"]);
        expect(hasCapability("worktrees_v1")).toBe(true);
        expect(hasCapability("teleport_v9")).toBe(false);
    });

    it("목록이 실제로 바뀔 때만 알리고, 형식이 틀린 값은 무시한다", () => {
        let n = 0;
        const off = onCapabilities(() => n++);
        setCapabilities(["trash_v1", "worktrees_v1"]);
        expect(n).toBe(0);
        setCapabilities("broken");
        expect(n).toBe(0);
        expect(hasCapability("worktrees_v1")).toBe(true);
        setCapabilities(["trash_v1"]);
        expect(n).toBe(1);
        expect(hasCapability("worktrees_v1")).toBe(false);
        off();
    });
});
