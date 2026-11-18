import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../api/client";
import { emptyLayout, openTab, setDirection, setRatio, splitLeaf, type Layout } from "./layout";
import { LayoutPersistence } from "./layoutPersistence";
import { mergeWorkspaceTabs, workspaceTabs } from "./workspaceTabs";

function layout(): Layout {
    const base = emptyLayout();
    const first = openTab(base, base.focused_leaf, { kind: "settings", title: "설정" });
    return splitLeaf(first, first.focused_leaf, "row", { kind: "project", project_id: "A", title: "A" });
}
function deferred<T>() {
    let resolve!: (v: T) => void;
    let reject!: (e: unknown) => void;
    const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}
function fixture(initial: Layout = layout()) {
    const values = new Map<string, string>();
    const store = {
        getItem: vi.fn((key: string) => values.get(key) ?? null),
        setItem: vi.fn((key: string, value: string) => { values.set(key, value); }),
    };
    let n = 0;
    const get = vi.fn(async () => ({ layout: initial as unknown, revision: 3 }));
    const put = vi.fn(async (_attempt: unknown, _signal: AbortSignal) => ({ revision: ++n + 3 }));
    const notice = vi.fn();
    const active = vi.fn(() => true);
    const options = { store, get, put, notice, active, newKey: () => `key-${++n}` };
    const current = new LayoutPersistence("pc", options);
    return { current, values, options, initial, get, put, store, notice, active,
        copy: () => JSON.parse(values.get("grove.layout.pc")!) };
}

describe("기기별 배치 저장", () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it("새 프로젝트 배치만 원본에서 이관하고 저장된 빈 배치는 다시 채우지 않는다", async () => {
        const f = fixture();
        f.get.mockResolvedValue({ layout: null, revision: 0 });
        const migrated = new LayoutPersistence("project", { ...f.options, initial: () => f.initial });
        expect(await migrated.restore()).toEqual(f.initial);
        await migrated.flush();
        expect(f.put).toHaveBeenCalledWith(expect.objectContaining({ layout: f.initial, expected_revision: 0 }), expect.any(AbortSignal));
        const empty = emptyLayout();
        migrated.change(empty);
        await migrated.flush();
        migrated.dispose();
        f.get.mockResolvedValue({ layout: empty, revision: 7 });
        const restored = new LayoutPersistence("project", { ...f.options, initial: () => f.initial });
        expect(await restored.restore()).toEqual(empty);
        restored.dispose();
    });

    it("서버 조회 실패 중 표시한 이관 배치를 자동 저장해 기존 프로젝트 배치를 덮지 않는다", async () => {
        const f = fixture();
        f.get.mockRejectedValueOnce(new Error("offline"));
        const migrated = new LayoutPersistence("project", { ...f.options, initial: () => f.initial });
        expect(await migrated.restore()).toEqual(f.initial);
        await vi.advanceTimersByTimeAsync(600);
        expect(f.put).not.toHaveBeenCalled();
        migrated.dispose();
        const empty = emptyLayout();
        f.get.mockResolvedValueOnce({ layout: empty, revision: 7 });
        const online = new LayoutPersistence("project", { ...f.options, initial: () => f.initial });
        expect(await online.restore()).toEqual(empty);
        online.dispose();
    });

    it("인증 후 로컬 배치는 즉시 복원하고 늦은 서버 조회가 그동안의 편집을 덮지 않는다", async () => {
        const f = fixture();
        await f.current.restore();
        f.current.dispose();
        const remote = deferred<{ layout: unknown; revision: number }>();
        f.get.mockImplementationOnce(() => remote.promise);
        const next = new LayoutPersistence("pc", f.options);
        expect(next.restoreLocal()).toEqual(f.initial);
        const restoring = next.restore();
        const edited = setRatio(f.initial, [], 0.6);
        next.change(edited);
        remote.resolve({ layout: setRatio(f.initial, [], 0.2), revision: 9 });
        expect(await restoring).toEqual(edited);
        expect(f.copy().dirty).toBe(true);
        next.dispose();
        f.active.mockReturnValue(false);
        expect(new LayoutPersistence("pc", f.options).restoreLocal()).toBeNull();
    });

    it("서버에 미반영된 로컬 탭·분할·비율·활성 pane을 먼저 복원한다", async () => {
        const f = fixture();
        await f.current.restore();
        const edited = setRatio(setDirection(f.initial, [], "column"), [], 0.35);
        f.current.change(edited);
        f.current.dispose();
        const next = new LayoutPersistence("pc", f.options);
        expect(await next.restore()).toEqual(edited);
        expect(f.copy().dirty).toBe(true);
        next.dispose();
    });
    it("복원 조회 중 편집이 이미 저장됐어도 이전 GET으로 되돌리지 않는다", async () => {
        const f = fixture();
        await f.current.restore();
        f.current.dispose();
        const remote = deferred<{ layout: unknown; revision: number }>();
        f.get.mockImplementationOnce(() => remote.promise);
        const next = new LayoutPersistence("pc", f.options);
        next.restoreLocal();
        const restoring = next.restore();
        const edited = setRatio(f.initial, [], 0.4);
        next.change(edited);
        await next.flush();
        expect(f.copy().dirty).toBe(false);
        remote.resolve({ layout: f.initial, revision: 3 });
        expect(await restoring).toEqual(edited);
        next.dispose();
    });

    it("동기화된 사본보다 서버를 우선하고 기존 plain JSON은 오프라인에서도 읽는다", async () => {
        const f = fixture();
        const newer = setRatio(f.initial, [], 0.7);
        f.values.set("grove.layout.pc", JSON.stringify(newer));
        expect(await f.current.restore()).toEqual(f.initial);
        f.current.dispose();
        f.values.set("grove.layout.pc", JSON.stringify(newer));
        f.get.mockRejectedValue(new Error("offline"));
        const offline = new LayoutPersistence("pc", f.options);
        expect(await offline.restore()).toEqual(newer);
        offline.dispose();
    });

    it("손상된 JSON·잘못된 트리·미지원 format을 복원하지 않는다", async () => {
        for (const raw of ["{", '{"schema":1,"root":{"type":"split","children":[null,null]}}', '{"format":99}']) {
            const f = fixture();
            f.values.set("grove.layout.pc", raw);
            expect(await f.current.restore()).toEqual(f.initial);
            f.current.dispose();
        }
    });

    it("손상된 보류 요청은 새 키로 재구성해 자동 전송하지 않는다", async () => {
        for (const attempt of [null, false, 0, {}, { key: "", expected_revision: 0, layout: layout() }]) {
            const f = fixture();
            f.values.set("grove.layout.pc", JSON.stringify({
                format: 1, layout: setRatio(f.initial, [], 0.8), revision: 1, dirty: true, edit: "corrupt", attempt,
            }));
            expect(await f.current.restore()).toEqual(f.initial);
            await vi.advanceTimersByTimeAsync(600);
            expect(f.put).not.toHaveBeenCalled();
            f.current.dispose();
        }
    });

    it("화면을 떠난 뒤 늦게 끝난 복원 GET은 배치나 사본을 갱신하지 않는다", async () => {
        const f = fixture();
        const pending = deferred<{ layout: unknown; revision: number }>();
        f.get.mockImplementationOnce(() => pending.promise);
        const restoring = f.current.restore();
        f.current.dispose();
        pending.resolve({ layout: f.initial, revision: 99 });
        expect(await restoring).toBeNull();
        expect(f.values.size).toBe(0);
    });

    it("저장 응답을 기다리는 중의 새 편집을 이전 응답으로 지우지 않고 순서대로 저장한다", async () => {
        const f = fixture();
        await f.current.restore();
        const pending = deferred<{ revision: number }>();
        f.put.mockImplementationOnce(() => pending.promise);
        const first = setRatio(f.initial, [], 0.3);
        const latest = setRatio(f.initial, [], 0.6);
        f.current.change(first);
        const running = f.current.flush();
        f.current.change(latest);
        await f.current.flush();
        expect(f.put).toHaveBeenCalledTimes(1);
        pending.resolve({ revision: 4 });
        await running;
        expect(f.put).toHaveBeenCalledTimes(2);
        expect(f.put.mock.calls[1]![0]).toMatchObject({ layout: latest, expected_revision: 4 });
        expect(f.copy()).toMatchObject({ layout: latest, dirty: false });
        f.current.dispose();
    });

    it("응답 유실 후 재실행해도 원래 본문·revision·요청 키부터 확인한다", async () => {
        const f = fixture();
        await f.current.restore();
        f.current.change(setRatio(f.initial, [], 0.3));
        f.put.mockRejectedValueOnce(new Error("response lost"));
        await f.current.flush();
        const attempt = f.put.mock.calls[0]![0];
        const latest = setRatio(f.initial, [], 0.8);
        f.current.change(latest);
        f.current.dispose();
        const restored = new LayoutPersistence("pc", f.options);
        expect(await restored.restore()).toEqual(latest);
        await restored.flush();
        expect(f.put.mock.calls[1]![0]).toEqual(attempt);
        expect(f.put.mock.calls[2]![0]).toMatchObject({ layout: latest });
        expect(f.copy()).toMatchObject({ layout: latest, dirty: false });
        restored.dispose();
    });

    it("CAS 충돌은 최신 revision 위에서 한 번만 새 요청으로 저장한다", async () => {
        const f = fixture();
        await f.current.restore();
        const conflict = new ApiError(409, "revision_conflict", "conflict", false, { current: { revision: 9 } });
        f.put.mockRejectedValueOnce(conflict).mockRejectedValueOnce(conflict);
        f.current.change(setRatio(f.initial, [], 0.3));
        await f.current.flush();
        expect(f.put).toHaveBeenCalledTimes(2);
        const first = f.put.mock.calls[0]![0] as { key: string };
        const second = f.put.mock.calls[1]![0] as { key: string };
        expect(second).toMatchObject({ expected_revision: 9 });
        expect(second.key).not.toBe(first.key);
        expect(f.copy().dirty).toBe(true);
        expect(f.notice).toHaveBeenLastCalledWith(expect.stringContaining("서버에 저장하지 못했습니다"));
        f.current.dispose();
    });

    it("공유 대화는 CAS 충돌 시 다른 기기에서 연 탭을 보존한다", async () => {
        const f = fixture(workspaceTabs(emptyLayout()));
        const added = (name: string) => workspaceTabs(openTab(f.initial, f.initial.focused_leaf,
            { kind: "session", project_id: "A", resource_id: name, title: name }));
        const remote = added("desktop");
        const onRemote = vi.fn();
        const shared = new LayoutPersistence("shared", { ...f.options, merge: mergeWorkspaceTabs, onRemote });
        await shared.restore();
        f.put.mockRejectedValueOnce(new ApiError(409, "revision_conflict", "conflict", false, { current: { revision: 4, layout: remote } }));
        shared.change(added("phone"));
        shared.acceptRemote({ revision: 4, layout: remote });
        await shared.flush();
        expect(f.put.mock.calls[1]![0]).toMatchObject({ expected_revision: 4, layout: {
            root: { tabs: [{ resource_id: "desktop" }, { resource_id: "phone" }] },
        } });
        expect(onRemote).toHaveBeenCalledTimes(1);
        shared.dispose();
    });

    it("로그아웃 뒤 늦은 저장 완료는 삭제한 사본이나 안내를 다시 만들지 않는다", async () => {
        const f = fixture();
        await f.current.restore();
        const pending = deferred<{ revision: number }>();
        f.put.mockImplementationOnce(() => pending.promise);
        f.current.change(setRatio(f.initial, [], 0.3));
        const running = f.current.flush();
        f.active.mockReturnValue(false);
        f.values.clear();
        pending.resolve({ revision: 4 });
        await running;
        expect(f.values.size).toBe(0);
        expect(f.notice).not.toHaveBeenCalled();
        f.current.dispose();
    });

    it("폭 전환·unmount는 타이머와 요청을 폐기하고 다른 배치 revision에 간섭하지 않는다", async () => {
        const f = fixture();
        await f.current.restore();
        const pending = deferred<{ revision: number }>();
        f.put.mockImplementationOnce(() => pending.promise);
        f.current.change(setRatio(f.initial, [], 0.3));
        const running = f.current.flush();
        const signal = f.put.mock.calls[0]![1];
        f.current.dispose();
        const saved = f.values.get("grove.layout.pc");
        pending.resolve({ revision: 99 });
        await running;
        await vi.advanceTimersByTimeAsync(600);
        expect(signal.aborted).toBe(true);
        expect(f.values.get("grove.layout.pc")).toBe(saved);
        expect(f.put).toHaveBeenCalledTimes(1);
    });

    it("다른 창의 새 로컬 사본을 늦은 저장 응답으로 덮어쓰지 않는다", async () => {
        const f = fixture();
        await f.current.restore();
        const pending = deferred<{ revision: number }>();
        f.put.mockImplementationOnce(() => pending.promise);
        f.current.change(setRatio(f.initial, [], 0.3));
        const running = f.current.flush();
        const other = { ...f.copy(), edit: "other-window", layout: setRatio(f.initial, [], 0.8) };
        f.values.set("grove.layout.pc", JSON.stringify(other));
        pending.resolve({ revision: 4 });
        await running;
        expect(f.copy()).toEqual(other);
        f.current.dispose();
    });

    it("기기 저장 공간 부족은 알리고 복구 키를 보존하지 못한 변경은 전송하지 않는다", async () => {
        const f = fixture();
        await f.current.restore();
        f.store.setItem.mockImplementation(() => { throw new Error("quota"); });
        f.current.change(setRatio(f.initial, [], 0.3));
        await f.current.flush();
        expect(f.put).not.toHaveBeenCalled();
        expect(f.notice).toHaveBeenCalledWith(expect.stringContaining("이 기기에 배치를 보존하지 못했습니다"));
        f.store.setItem.mockImplementation((key, value) => { f.values.set(key, value); });
        await f.current.flush();
        expect(f.put).toHaveBeenCalledTimes(1);
        expect(f.copy().dirty).toBe(false);
        f.current.dispose();
    });

    it("연결 문제로 저장하지 못하면 알리지 않고 같은 요청 키로 간격을 늘려 다시 저장한다", async () => {
        const f = fixture();
        await f.current.restore();
        const lost = new ApiError(0, "network_error", "서버 응답을 받지 못했습니다", true, { result_unknown: true });
        f.put.mockRejectedValueOnce(lost).mockRejectedValueOnce(new TypeError("암호화 연결이 끊겼습니다."));
        f.current.change(setRatio(f.initial, [], 0.3));
        await f.current.flush();
        expect(f.put).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(2_000);
        expect(f.put).toHaveBeenCalledTimes(2);
        await vi.advanceTimersByTimeAsync(3_999);
        expect(f.put).toHaveBeenCalledTimes(2);
        await vi.advanceTimersByTimeAsync(1);
        expect(f.put).toHaveBeenCalledTimes(3);
        // 재시도는 원래 요청을 그대로 다시 보낸다(서버가 같은 키를 중복 실행하지 않음).
        expect(f.put.mock.calls[2]![0]).toEqual(f.put.mock.calls[0]![0]);
        expect(f.copy().dirty).toBe(false);
        expect(f.notice).not.toHaveBeenCalled();
        f.current.dispose();
    });
});
