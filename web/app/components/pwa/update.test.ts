import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

class Worker extends EventTarget {
    state = "installed";
    postMessage = vi.fn();
}
let pwa: typeof import("../pwa");
let service: EventTarget & { register: ReturnType<typeof vi.fn>; controller: Worker | null };
let registration: EventTarget & { waiting: Worker | null; installing: Worker | null; update: ReturnType<typeof vi.fn> };
let reload: ReturnType<typeof vi.fn>;
beforeEach(async () => {
    vi.resetModules();
    vi.stubEnv("DEV", false);
    vi.useFakeTimers();
    reload = vi.fn();
    registration = Object.assign(new EventTarget(), { waiting: new Worker(), installing: null, update: vi.fn(async () => undefined) });
    service = Object.assign(new EventTarget(), { controller: new Worker(), register: vi.fn(async () => registration) });
    vi.stubGlobal("navigator", { onLine: true, serviceWorker: service });
    vi.stubGlobal("location", { reload });
    pwa = await import("../pwa");
});
afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
});

describe("사용자 동의에 따른 worker 전환", () => {
    it("등록은 한 번만 하고 대기 worker를 자동으로 활성화하지 않는다", async () => {
        pwa.registerServiceWorker();
        pwa.registerServiceWorker();
        await Promise.resolve();
        expect(service.register).toHaveBeenCalledTimes(1);
        expect(service.register).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ updateViaCache: "none" }));
        expect(registration.waiting!.postMessage).not.toHaveBeenCalled();
        service.dispatchEvent(new Event("controllerchange"));
        expect(reload).not.toHaveBeenCalled();
    });

    it("동의 후 한 번만 전환 메시지를 보내고 한 번만 reload한다", async () => {
        pwa.registerServiceWorker();
        await Promise.resolve();
        pwa.applyUpdate();
        pwa.applyUpdate();
        expect(registration.waiting!.postMessage).toHaveBeenCalledTimes(1);
        expect(registration.waiting!.postMessage).toHaveBeenCalledWith({ type: "skip-waiting" });
        service.dispatchEvent(new Event("controllerchange"));
        service.dispatchEvent(new Event("controllerchange"));
        expect(reload).toHaveBeenCalledTimes(1);
    });

    it("첫 설치의 claim과 대기 worker 없는 업데이트 선택은 reload를 예약하지 않는다", async () => {
        registration.waiting = null;
        service.controller = null;
        pwa.registerServiceWorker();
        await Promise.resolve();
        pwa.applyUpdate();
        service.dispatchEvent(new Event("controllerchange"));
        expect(reload).not.toHaveBeenCalled();
    });

    it("다른 탭이 활성화한 worker로도 사용자가 고를 때만 reload한다", async () => {
        pwa.registerServiceWorker();
        await Promise.resolve();
        registration.waiting!.state = "activated";
        service.dispatchEvent(new Event("controllerchange"));
        expect(reload).not.toHaveBeenCalled();
        pwa.applyUpdate();
        expect(reload).toHaveBeenCalledTimes(1);
        expect(registration.waiting!.postMessage).not.toHaveBeenCalled();
    });
});
