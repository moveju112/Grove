import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { refreshFiles, watchFile, type FileContent } from "./fileWatch";
import { api } from "../api/client";

const auth = vi.hoisted(() => ({ owner: 0, loggedIn: true }));
vi.mock("../api/client", () => ({
    api: { get: vi.fn() }, authGeneration: () => auth.owner, isLoggedIn: () => auth.loggedIn,
}));
const content: FileContent = { path: "a.txt", size: 1, sha256: "hash", preview: "text", text: "a" };
const cleanups: (() => void)[] = [];
const listen = (project = "project", path = "a.txt") => {
    const listener = { value: vi.fn(), error: vi.fn() };
    const stop = watchFile(project, path, listener);
    cleanups.push(stop);
    return { ...listener, stop };
};
beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("window", new EventTarget());
    vi.mocked(api.get).mockReset().mockResolvedValue(content);
    auth.owner = 0;
    auth.loggedIn = true;
});
afterEach(() => {
    for (const stop of cleanups.splice(0)) stop();
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

describe("파일 변경 공유 구독", () => {
    it("같은 파일의 조회와 5초 주기를 공유하고 마지막 해제 때만 요청·타이머를 폐기한다", async () => {
        const a = listen(), b = listen();
        await vi.advanceTimersByTimeAsync(0);
        expect(api.get).toHaveBeenCalledTimes(1);
        expect(a.value).toHaveBeenCalledWith(content);
        expect(b.value).toHaveBeenCalledWith(content);
        const signal = vi.mocked(api.get).mock.calls[0]![1]!.signal!;
        a.stop();
        expect(signal.aborted).toBe(false);
        await vi.advanceTimersByTimeAsync(5000);
        expect(api.get).toHaveBeenCalledTimes(2);
        b.stop();
        expect(signal.aborted).toBe(true);
        expect(vi.getTimerCount()).toBe(0);
    });
    it("이벤트가 조회 중에 여러 번 와도 겹쳐 실행하지 않고 한 번만 다시 확인한다", async () => {
        let release!: (value: FileContent) => void;
        vi.mocked(api.get).mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
        listen();
        refreshFiles("other");
        refreshFiles("project");
        refreshFiles("project");
        expect(api.get).toHaveBeenCalledTimes(1);
        release(content);
        await vi.advanceTimersByTimeAsync(0);
        expect(api.get).toHaveBeenCalledTimes(2);
    });
    it("해제 후 이미 접수된 응답도 전달하지 않고 새 타이머를 만들지 않는다", async () => {
        let release!: (value: FileContent) => void;
        vi.mocked(api.get).mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
        const a = listen();
        a.stop();
        release(content);
        await vi.advanceTimersByTimeAsync(0);
        expect(a.value).not.toHaveBeenCalled();
        expect(a.error).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
    });
    it("저장 뒤 재조회가 요청되면 저장 전 진행 중이던 응답은 전달하지 않는다", async () => {
        let release!: (value: FileContent) => void;
        const saved = { ...content, sha256: "saved-hash", text: "saved" };
        vi.mocked(api.get).mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }))
            .mockResolvedValueOnce(saved);
        const listener = listen();
        refreshFiles("project");
        release(content);
        await vi.advanceTimersByTimeAsync(0);
        expect(listener.value).toHaveBeenCalledTimes(1);
        expect(listener.value).toHaveBeenCalledWith(saved);
    });
    it("이전 구독 해제를 반복해도 같은 파일의 새 구독을 지우지 않는다", async () => {
        const old = listen();
        old.stop();
        const next = listen();
        old.stop();
        await vi.advanceTimersByTimeAsync(0);
        window.dispatchEvent(new Event("focus"));
        await vi.advanceTimersByTimeAsync(0);
        expect(next.value).toHaveBeenCalledTimes(2);
    });
    it("인증 소유자가 바뀐 뒤의 응답은 새 로그인으로 넘기지 않는다", async () => {
        let release!: (value: FileContent) => void;
        vi.mocked(api.get).mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
        const a = listen();
        auth.owner++;
        release(content);
        await vi.advanceTimersByTimeAsync(0);
        expect(a.value).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
    });
    it("오류를 알리고 다음 주기에 재확인하며 창 복귀는 바로 확인한다", async () => {
        const error = new Error("fixture unavailable");
        vi.mocked(api.get).mockRejectedValueOnce(error);
        const a = listen();
        await vi.advanceTimersByTimeAsync(0);
        expect(a.error).toHaveBeenCalledWith(error);
        await vi.advanceTimersByTimeAsync(5000);
        expect(a.value).toHaveBeenCalledWith(content);
        window.dispatchEvent(new Event("focus"));
        await vi.advanceTimersByTimeAsync(0);
        expect(api.get).toHaveBeenCalledTimes(3);
    });
});
