import { describe, expect, it } from "vitest";
import { DeliveryTiming } from "./deliveryTiming";

describe("SSE 수신 후 화면 반영 시간", () => {
    it("보고 있는 대화만 측정하고 같은 턴의 첫 commit을 모든 pane에서 공유한다", () => {
        let now = 100;
        const timing = new DeliveryTiming(() => now);
        const offA = timing.watch("a");
        const offB = timing.watch("a");
        timing.receive("hidden", "hidden-turn");
        expect(timing.applied("hidden-turn")).toBeNull();
        timing.receive("a", "turn");
        now = 140;
        timing.receive("a", "turn");
        expect(timing.applied("turn")).toBe(40);
        now = 500;
        offA();
        expect(timing.applied("turn")).toBe(40);
        offB();
        expect(timing.applied("turn")).toBeNull();
    });

    it("재동기화·로그아웃과 닫힌 화면은 늦은 측정을 남기지 않는다", () => {
        const timing = new DeliveryTiming(() => 1);
        const off = timing.watch("a");
        timing.receive("a", "turn");
        timing.clear();
        expect(timing.applied("turn")).toBeNull();
        timing.receive("a", "next");
        expect(timing.applied("next")).toBe(0);
        off();
        timing.receive("a", "closed");
        expect(timing.applied("closed")).toBeNull();
    });

    it("샘플은 200개로 제한한다", () => {
        const timing = new DeliveryTiming(() => 1);
        timing.watch("a");
        for (let i = 0; i < 201; i++) timing.receive("a", `t${i}`);
        expect(timing.applied("t0")).toBeNull();
        expect(timing.applied("t200")).toBe(0);
    });
});
