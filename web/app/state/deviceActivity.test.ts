import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const post = vi.fn();
let capability: boolean | null = true;
vi.mock("../api/client", () => ({ api: { post: (...args: unknown[]) => post(...args) }, hasCapability: () => capability }));

const { REPORT_INTERVAL, watchDeviceActivity } = await import("./deviceActivity");

describe("기기 사용 중 알림", () => {
    let clock = 0;
    let stop = () => {};
    const fire = (type: string, pointerType?: string) => {
        const event = new Event(type);
        if (pointerType) Object.defineProperty(event, "pointerType", { value: pointerType });
        window.dispatchEvent(event);
    };
    const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
    beforeEach(() => {
        const target = new EventTarget();
        vi.stubGlobal("window", target);
        vi.stubGlobal("document", { visibilityState: "visible" });
        post.mockReset().mockResolvedValue(undefined);
        capability = true;
        clock = 1_000_000;
        stop = watchDeviceActivity(() => clock);
    });
    afterEach(() => { stop(); vi.unstubAllGlobals(); });

    it("입력이 이어져도 1분에 한 번만 서버에 알린다", async () => {
        fire("keydown");
        fire("pointerdown");
        await settle();
        expect(post).toHaveBeenCalledTimes(1);
        expect(post).toHaveBeenCalledWith("/presence", {}, expect.objectContaining({ requires: ["device_activity_v1"] }));
        clock += REPORT_INTERVAL - 1;
        fire("wheel");
        await settle();
        expect(post).toHaveBeenCalledTimes(1);
        clock += 1;
        fire("pointermove", "mouse");
        await settle();
        expect(post).toHaveBeenCalledTimes(2);
    });

    it("숨긴 화면·터치 스크롤·기능 없는 서버에서는 알리지 않는다", async () => {
        fire("pointermove", "touch");
        capability = null;
        fire("keydown");
        capability = true;
        (document as { visibilityState: string }).visibilityState = "hidden";
        fire("keydown");
        await settle();
        expect(post).not.toHaveBeenCalled();
    });

    it("요청이 실패해도 화면에 오류를 남기지 않고 정리 후에는 더 보내지 않는다", async () => {
        post.mockRejectedValueOnce(new Error("offline"));
        fire("keydown");
        await settle();
        expect(post).toHaveBeenCalledTimes(1);
        stop();
        clock += REPORT_INTERVAL;
        fire("keydown");
        await settle();
        expect(post).toHaveBeenCalledTimes(1);
    });
});
