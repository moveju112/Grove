import { describe, expect, it, vi } from "vitest";
import { confirmRun, parseRun, pendingRuns, runKey, type RunAttempt, type RunTransport } from "./projectScripts";

const original: RunAttempt = {
    format: 1, projectId: "project-a", projectName: "A", actorId: "actor-a",
    script: { id: "script-a", project_id: "project-a", name: "check", command: "printf fixture", revision: 1 },
    execution: { root: "/fixture/a", shell: "/bin/bash", fingerprint: "a".repeat(64) },
    sessionKey: "original:session", taskKey: "original:task",
};
function store() {
    const values = new Map<string, string>();
    return { get length() { return values.size; }, key: (index: number) => [...values.keys()][index] ?? null,
        getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); },
        removeItem: (key: string) => { values.delete(key); } };
}
function transport(): RunTransport {
    return { owner: vi.fn(async () => "actor-a"), session: vi.fn(async () => ({ id: "session-a" })), task: vi.fn(async () => ({ id: "task-a" })) };
}
describe("초기 설정 실행 사본(PROJECT-010)", () => {
    it("실행 위치를 보존하고 손상된 위치 값은 실행 가능한 사본으로 보지 않는다", () => {
        const setup = { ...original, setup: { worktreeId: "wt-1" } };
        expect(parseRun(JSON.stringify(setup), "project-a")?.setup).toEqual({ worktreeId: "wt-1" });
        expect(parseRun(JSON.stringify({ ...original, setup: { worktreeId: null } }), "project-a")?.setup).toEqual({ worktreeId: null });
        expect(parseRun(JSON.stringify({ ...original, setup: { worktreeId: "../x" } }), "project-a")).toBeNull();
        expect(parseRun(JSON.stringify({ ...original, setup: null }), "project-a")).toBeNull();
    });
    it("같은 키의 사본이라도 실행 위치가 다르면 덮어쓰지 않는다", async () => {
        const storage = store(), remote = transport();
        const setup: RunAttempt = { ...original, setup: { worktreeId: "wt-1" } };
        storage.setItem(runKey(setup), JSON.stringify({ ...setup, setup: { worktreeId: "wt-2" } }));
        await expect(confirmRun(storage, setup, () => true, remote)).rejects.toThrow("사본이 바뀌었습니다");
        expect(remote.session).not.toHaveBeenCalled();
    });
});

describe("프로젝트 script 실행 요청 복구", () => {
    it("실행 전 사본을 쓰고 세션 ID도 보존한 뒤 task를 접수한다", async () => {
        const storage = store(), remote = transport();
        vi.mocked(remote.session).mockImplementation(async (attempt) => {
            expect(parseRun(storage.getItem(runKey(attempt)), "project-a")).toEqual(original);
            return { id: "session-a" };
        });
        vi.mocked(remote.task).mockImplementation(async (attempt) => {
            expect(parseRun(storage.getItem(runKey(attempt)), "project-a")?.sessionId).toBe("session-a");
            return { id: "task-a" };
        });
        expect(await confirmRun(storage, original, () => true, remote)).toEqual({ sessionId: "session-a", taskId: "task-a" });
        expect(storage.length).toBe(0);
    });
    it("사본 저장 실패는 서버 변경 전에 멈춘다", async () => {
        const storage = store(), remote = transport();
        storage.setItem = () => { throw new Error("fixture quota"); };
        await expect(confirmRun(storage, original, () => true, remote)).rejects.toThrow("사본을 보관하지 못해");
        expect(remote.session).not.toHaveBeenCalled();
        expect(remote.task).not.toHaveBeenCalled();
    });
    it("세션 응답 유실은 원래 키로, task 응답 유실은 저장한 세션과 원래 키로 확인한다", async () => {
        const storage = store(), remote = transport();
        vi.mocked(remote.session).mockRejectedValueOnce(new Error("lost session response"));
        await expect(confirmRun(storage, original, () => true, remote)).rejects.toThrow("lost session response");
        vi.mocked(remote.task).mockRejectedValueOnce(new Error("lost task response"));
        await expect(confirmRun(storage, original, () => true, remote)).rejects.toThrow("lost task response");
        await confirmRun(storage, original, () => true, remote);
        expect(remote.session).toHaveBeenCalledTimes(2);
        expect(vi.mocked(remote.session).mock.calls.map(([attempt]) => attempt.sessionKey)).toEqual(["original:session", "original:session"]);
        expect(remote.task).toHaveBeenCalledTimes(2);
        for (const [attempt] of vi.mocked(remote.task).mock.calls) {
            expect(attempt.sessionId).toBe("session-a");
            expect(attempt.taskKey).toBe("original:task");
            expect(attempt.script.command).toBe("printf fixture");
        }
    });
    it("인증 종료 뒤 늦게 돌아온 세션으로 실행하거나 사본을 되살리지 않는다", async () => {
        const storage = store(), remote = transport();
        let active = true;
        vi.mocked(remote.session).mockImplementation(async () => {
            active = false;
            storage.removeItem(runKey(original));
            return { id: "session-a" };
        });
        await expect(confirmRun(storage, original, () => active, remote)).rejects.toThrow("인증 상태");
        expect(remote.task).not.toHaveBeenCalled();
        expect(storage.length).toBe(0);
    });
    it("속성 순서만 다른 동등한 사본은 복구하고 내용이 다른 사본은 덮어쓰지 않는다", async () => {
        const storage = store(), remote = transport();
        storage.setItem(runKey(original), JSON.stringify({ ...original, script: {
            command: original.script.command, revision: 1, name: "check", project_id: "project-a", id: "script-a",
        }, sessionId: "session-a" }));
        await confirmRun(storage, original, () => true, remote);
        expect(remote.session).not.toHaveBeenCalled();
        storage.setItem(runKey(original), JSON.stringify({ ...original, script: { ...original.script, command: "different" } }));
        await expect(confirmRun(storage, original, () => true, remote)).rejects.toThrow("사본이 바뀌었습니다");
        expect(parseRun(storage.getItem(runKey(original)), "project-a")?.script.command).toBe("different");
    });
    it("프로젝트가 다른 사본·손상된 revision·변조된 경로 key는 실행 가능한 사본으로 보지 않는다", () => {
        expect(parseRun(JSON.stringify(original), "project-b")).toBeNull();
        expect(parseRun(JSON.stringify({ ...original, script: { ...original.script, revision: 0 } }), "project-a")).toBeNull();
        const storage = store();
        storage.setItem("grove.script.run.project-a.wrong-key", JSON.stringify(original));
        expect(pendingRuns(storage, "project-a")[0]?.attempt).toBeNull();
        expect(pendingRuns(storage, "project-b")).toEqual([]);
    });
    it("다른 인증으로는 원래 사본을 보존하고 세션·작업을 만들지 않는다", async () => {
        const storage = store(), remote = transport();
        storage.setItem(runKey(original), JSON.stringify(original));
        vi.mocked(remote.owner).mockResolvedValue("actor-b");
        await expect(confirmRun(storage, original, () => true, remote)).rejects.toThrow("원래 인증");
        expect(remote.session).not.toHaveBeenCalled();
        expect(remote.task).not.toHaveBeenCalled();
        expect(parseRun(storage.getItem(runKey(original)), "project-a")).toEqual(original);
    });
});
