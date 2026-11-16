import { describe, expect, it, vi } from "vitest";
import { ApiError } from "../api/client";
import { Autosave, type SavedValue } from "./autosave";

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}

describe("설정 자동 저장", () => {
    it("입력 중에는 보내지 않고 확정·blur 때만 저장하며 동일 값은 다시 보내지 않는다", async () => {
        const save = vi.fn(async (value: string, revision: number) => ({ value, revision: revision + 1 }));
        const state = new Autosave({ value: "14", revision: 4 }, save);
        state.change("1"); state.change("15");
        expect(save).not.toHaveBeenCalled();
        state.commit();
        await vi.waitFor(() => expect(state.getSnapshot().phase).toBe("saved"));
        expect(save).toHaveBeenCalledOnce();
        expect(save).toHaveBeenCalledWith("15", 4, expect.any(String));
        state.change("15"); state.commit(); state.flush();
        expect(save).toHaveBeenCalledOnce();
    });

    it("저장 응답이 늦어도 새 입력을 지우지 않고 blur로 확정한 최신 값만 다음 revision으로 저장한다", async () => {
        const first = deferred<SavedValue<string>>();
        const second = deferred<SavedValue<string>>();
        const save = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
        const state = new Autosave({ value: "old", revision: 2 }, save);
        state.change("first"); state.commit();
        state.change("intermediate"); state.commit();
        state.change("latest"); state.commit();
        expect(save).toHaveBeenCalledOnce();
        first.resolve({ value: "first", revision: 3 });
        await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(2));
        expect(state.getSnapshot().value).toBe("latest");
        expect(save.mock.calls[1]).toEqual(["latest", 3, expect.any(String)]);
        second.resolve({ value: "latest", revision: 4 });
        await vi.waitFor(() => expect(state.getSnapshot()).toMatchObject({ value: "latest", revision: 4, dirty: false, phase: "saved" }));
    });

    it("저장 중 새로 입력했지만 아직 focus를 유지하면 후속 요청을 보내지 않는다", async () => {
        const pending = deferred<SavedValue<string>>();
        const save = vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValue({ value: "typing", revision: 2 });
        const state = new Autosave({ value: "", revision: 0 }, save);
        state.change("first"); state.commit();
        state.change("typing");
        pending.resolve({ value: "first", revision: 1 });
        await vi.waitFor(() => expect(state.getSnapshot().phase).toBe("idle"));
        expect(save).toHaveBeenCalledOnce();
        expect(state.getSnapshot()).toMatchObject({ value: "typing", dirty: true });
        state.commit();
        await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(2));
    });

    it("SSE 재조회는 편집 시작 revision을 바꾸지 않고 충돌 후에도 입력을 보존한다", async () => {
        const save = vi.fn().mockRejectedValueOnce(new ApiError(409, "revision_conflict", "changed"))
            .mockResolvedValueOnce({ value: "mine", revision: 9 });
        const state = new Autosave({ value: "before", revision: 5 }, save);
        state.change("mine");
        state.receive({ value: "remote", revision: 8 });
        state.commit();
        await vi.waitFor(() => expect(state.getSnapshot().phase).toBe("conflict"));
        expect(save.mock.calls[0]).toEqual(["mine", 5, expect.any(String)]);
        state.commit(); state.flush();
        expect(save).toHaveBeenCalledOnce();
        state.applyMine();
        await vi.waitFor(() => expect(state.getSnapshot().phase).toBe("saved"));
        expect(save.mock.calls[1]).toEqual(["mine", 8, expect.any(String)]);
    });

    it("충돌 때 최신 값 선택은 새 mutation 없이 입력을 교체한다", async () => {
        const save = vi.fn().mockRejectedValue(new ApiError(409, "revision_conflict", "changed"));
        const state = new Autosave({ value: "old", revision: 0 }, save);
        state.change("mine"); state.commit();
        await vi.waitFor(() => expect(state.getSnapshot().phase).toBe("conflict"));
        state.receive({ value: "remote", revision: 1 });
        state.useRemote();
        expect(state.getSnapshot()).toMatchObject({ value: "remote", revision: 1, dirty: false, phase: "idle" });
        expect(save).toHaveBeenCalledOnce();
    });

    it("응답 유실은 자동 재전송하지 않고 확인 동작에만 원래 본문·revision·키를 재사용한다", async () => {
        const save = vi.fn().mockRejectedValueOnce(new ApiError(0, "network_error", "lost"))
            .mockResolvedValueOnce({ value: "first", revision: 1 })
            .mockResolvedValueOnce({ value: "next", revision: 2 });
        const state = new Autosave({ value: "old", revision: 0 }, save);
        state.change("first"); state.commit();
        await vi.waitFor(() => expect(state.getSnapshot().phase).toBe("uncertain"));
        state.change("next"); state.commit(); state.flush();
        expect(save).toHaveBeenCalledOnce();
        state.retry();
        await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(3));
        expect(save.mock.calls[1]).toEqual(save.mock.calls[0]);
        expect(save.mock.calls[2]).toEqual(["next", 1, expect.any(String)]);
        expect(save.mock.calls[2]![2]).not.toBe(save.mock.calls[0]![2]);
        await vi.waitFor(() => expect(state.getSnapshot()).toMatchObject({ value: "next", dirty: false }));
    });

    it("native 검증 실패·서버 거절·오프라인에서는 초안을 보존하고 화면 종료로 재시도하지 않는다", async () => {
        const save = vi.fn().mockRejectedValue(new ApiError(0, "offline", "offline", false, { result_unknown: false }));
        const state = new Autosave({ value: "14", revision: 0 }, save);
        state.change(""); state.reject("정수가 필요해요."); state.commit(); state.flush();
        expect(save).not.toHaveBeenCalled();
        state.change("15"); state.commitValid();
        await vi.waitFor(() => expect(state.getSnapshot().phase).toBe("error"));
        expect(state.getSnapshot()).toMatchObject({ value: "15", dirty: true });
        state.flush(); state.commit();
        expect(save).toHaveBeenCalledOnce();
    });

    it("화면 종료도 남은 입력을 확정하며 늦은 이전 조회로 성공한 값을 되돌리지 않는다", async () => {
        const save = vi.fn(async (value: string, revision: number) => ({ value: value.trim(), revision: revision + 1 }));
        const state = new Autosave({ value: "old", revision: 2 }, save);
        state.change(" new "); state.flush();
        await vi.waitFor(() => expect(state.getSnapshot().phase).toBe("saved"));
        state.receive({ value: "old", revision: 2 });
        expect(state.getSnapshot()).toMatchObject({ value: "new", revision: 3, dirty: false });
    });

    it("복구한 정의 초안의 이전 revision을 유지하고 승인 없이 덮어쓰지 않는다", () => {
        const save = vi.fn();
        const state = new Autosave({ value: "remote", revision: 4 }, save, { value: "draft", revision: 2 });
        state.flush(); state.commit();
        expect(state.getSnapshot()).toMatchObject({ value: "draft", revision: 2, phase: "conflict", canRebase: true });
        expect(save).not.toHaveBeenCalled();
    });

    it("객체 key 순서가 다른 같은 설정은 새 변경으로 취급하지 않는다", () => {
        const save = vi.fn();
        const state = new Autosave({ value: { a: 1, b: [2, 3] }, revision: 0 }, save);
        state.change({ b: [2, 3], a: 1 }); state.commit();
        expect(save).not.toHaveBeenCalled();
        expect(state.getSnapshot().dirty).toBe(false);
    });

    it("미완성 숫자를 정상 빈 값으로 고치면 다시 검증하고, 확실한 실패는 명시적 재시도만 허용한다", async () => {
        const save = vi.fn().mockRejectedValueOnce(new ApiError(0, "offline", "offline", false, { result_unknown: false }))
            .mockResolvedValueOnce({ value: "", revision: 1 });
        const state = new Autosave({ value: "30", revision: 0 }, save);
        state.change(""); state.reject("bad input"); state.flush();
        expect(save).not.toHaveBeenCalled();
        state.commitValid();
        await vi.waitFor(() => expect(state.getSnapshot().phase).toBe("error"));
        state.flush(); expect(save).toHaveBeenCalledOnce();
        state.retry();
        await vi.waitFor(() => expect(state.getSnapshot()).toMatchObject({ value: "", dirty: false, phase: "saved" }));
        expect(save).toHaveBeenCalledTimes(2);
    });

    it("잘못된 숫자가 남아 있으면 다른 드롭다운 선택으로 검증을 우회하지 않는다", async () => {
        const save = vi.fn(async (value: { number: string; choice: boolean }, revision: number) => ({ value, revision: revision + 1 }));
        const state = new Autosave({ value: { number: "30", choice: false }, revision: 0 }, save);
        state.reject("bad input"); state.change({ number: "", choice: false });
        state.change({ number: "", choice: true }); state.commit(); state.flush();
        expect(save).not.toHaveBeenCalled();
        state.change({ number: "15", choice: true }); state.commitValid();
        await vi.waitFor(() => expect(state.getSnapshot().phase).toBe("saved"));
        expect(save).toHaveBeenCalledWith({ number: "15", choice: true }, 0, expect.any(String));
    });
});
