import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

class Worker extends EventTarget {
    state = "installed";
    postMessage = vi.fn();
}
let pwa: typeof import("../pwa");
let service: EventTarget & { register: ReturnType<typeof vi.fn>; controller: Worker | null };
let registration: EventTarget & { waiting: Worker | null; installing: Worker | null; update: ReturnType<typeof vi.fn> };
let reload: ReturnType<typeof vi.fn>;
const input = vi.hoisted(() => ({ pending: true }));
vi.mock("./pendingInput", () => ({ trackPendingInput: () => undefined, hasPendingInput: () => input.pending }));
beforeEach(async () => {
    vi.resetModules();
    input.pending = true;
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

describe("입력 유무에 따른 worker 전환", () => {
    it("등록이 끝날 때 이미 설치 중인 worker도 상태를 관찰한다", async () => {
        const worker = new Worker();
        worker.state = "installing";
        registration.waiting = null;
        registration.installing = worker;
        pwa.registerServiceWorker();
        await Promise.resolve();
        worker.state = "installed";
        registration.waiting = worker;
        registration.installing = null;
        worker.dispatchEvent(new Event("statechange"));
        expect(worker.postMessage).not.toHaveBeenCalled();
        pwa.applyUpdate();
        expect(worker.postMessage).toHaveBeenCalledWith({ type: "skip-waiting" });
    });

    it("updatefound 처리 전에 설치가 끝나도 대기 worker를 놓치지 않는다", async () => {
        registration.waiting = null;
        pwa.registerServiceWorker();
        await Promise.resolve();
        const worker = new Worker();
        registration.waiting = worker;
        registration.dispatchEvent(new Event("updatefound"));
        pwa.applyUpdate();
        expect(worker.postMessage).toHaveBeenCalledWith({ type: "skip-waiting" });
    });

    it("입력이 없으면 대기 worker를 바로 한 번만 활성화하고 한 번만 reload한다", async () => {
        input.pending = false;
        pwa.registerServiceWorker();
        await Promise.resolve();
        expect(registration.waiting!.postMessage).toHaveBeenCalledTimes(1);
        expect(registration.waiting!.postMessage).toHaveBeenCalledWith({ type: "skip-waiting" });
        await pwa.checkForUpdate();
        expect(registration.waiting!.postMessage).toHaveBeenCalledTimes(1);
        service.dispatchEvent(new Event("controllerchange"));
        service.dispatchEvent(new Event("controllerchange"));
        expect(reload).toHaveBeenCalledTimes(1);
    });

    it("오프라인이면 입력이 없어도 자동으로 활성화하지 않는다", async () => {
        input.pending = false;
        vi.stubGlobal("navigator", { onLine: false, serviceWorker: service });
        pwa.registerServiceWorker();
        await Promise.resolve();
        expect(registration.waiting!.postMessage).not.toHaveBeenCalled();
    });

    it("다른 탭이 활성화한 worker도 입력이 없으면 바로 reload한다", async () => {
        registration.waiting = null;
        pwa.registerServiceWorker();
        await Promise.resolve();
        input.pending = false;
        const next = new Worker();
        next.state = "activated";
        service.controller = next;
        service.dispatchEvent(new Event("controllerchange"));
        expect(reload).toHaveBeenCalledTimes(1);
    });

    it("입력이 있으면 등록은 한 번만 하고 대기 worker를 자동으로 활성화하지 않는다", async () => {
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

    it("대기 worker를 관측하지 못한 탭에도 다른 탭의 전환 후 업데이트 선택을 제공한다", async () => {
        registration.waiting = null;
        pwa.registerServiceWorker();
        await Promise.resolve();
        const next = new Worker();
        next.state = "activated";
        service.controller = next;
        service.dispatchEvent(new Event("controllerchange"));
        expect(reload).not.toHaveBeenCalled();
        pwa.applyUpdate();
        expect(reload).toHaveBeenCalledTimes(1);
        expect(next.postMessage).not.toHaveBeenCalled();
    });
});

describe("상태 점의 수동 웹 확인", () => {
    it("새 worker의 설치 결과를 기다리고 빈 탭도 자동 전환하지 않는다", async () => {
        input.pending = false;
        registration.waiting = null;
        const worker = new Worker();
        worker.state = "installing";
        registration.update.mockImplementation(async () => {
            registration.installing = worker;
            registration.dispatchEvent(new Event("updatefound"));
        });
        pwa.registerServiceWorker();
        await Promise.resolve();
        const check = pwa.checkWebUpdate();
        expect(pwa.checkWebUpdate()).toBe(check);
        await Promise.resolve();
        await Promise.resolve();
        worker.state = "installed";
        registration.installing = null;
        registration.waiting = worker;
        worker.dispatchEvent(new Event("statechange"));
        await expect(check).resolves.toBe("available");
        expect(registration.update).toHaveBeenCalledTimes(1);
        expect(worker.postMessage).not.toHaveBeenCalled();
        expect(reload).not.toHaveBeenCalled();
        pwa.applyUpdate();
        expect(worker.postMessage).toHaveBeenCalledWith({ type: "skip-waiting" });
    });

    it("확인 불가·최신·확인 실패를 구분한다", async () => {
        await expect(pwa.checkWebUpdate()).resolves.toBe("unavailable");
        registration.waiting = null;
        pwa.registerServiceWorker();
        await Promise.resolve();
        await expect(pwa.checkWebUpdate()).resolves.toBe("up_to_date");
        registration.update.mockRejectedValueOnce(new Error());
        await expect(pwa.checkWebUpdate()).resolves.toBe("failed");
    });
});
