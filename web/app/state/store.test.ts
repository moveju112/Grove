import { describe, expect, it, vi } from "vitest";
import { applyEvent, batchEventQueries, cacheStats, clearServerCache, IDLE_ENTRY_LIMIT, invalidate, PARTIAL_FLUSH_MS, queuePartial, querySnapshot, resyncAll, revalidateQuery, retryWaiting, setLive, setTransportFailureHandler, subscribeQuery } from "./store";
import { ApiError, isTransportError } from "../api/client";
import { deliveryTiming } from "./deliveryTiming";
import { RANGE_WINDOW } from "./conversationPages";

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

it("최근 조회는 선조회를 공유하고 오래된 요청은 결과를 유지한 채 한 번만 재확인한다", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(0);
    let finish!: (data: string) => void;
    const get = vi.fn(() => new Promise<string>((resolve) => { finish = resolve; }));
    const key = "recent:range:4h:30";
    subscribeQuery(key, get, () => undefined)();
    const off = subscribeQuery(key, get, () => undefined);
    try {
        revalidateQuery(key, 750);
        expect(get).toHaveBeenCalledTimes(1);
        clock.mockReturnValue(3_000);
        revalidateQuery(key, 750);
        revalidateQuery(key, 750);
        finish("보관된 목록");
        await settle();
        expect(get).toHaveBeenCalledTimes(2);
        expect(querySnapshot(key)).toMatchObject({ data: "보관된 목록", loading: true });
        finish("최신 목록");
        await settle();
        expect(querySnapshot(key)).toMatchObject({ data: "최신 목록", loading: false });
    } finally { off(); clearServerCache(); clock.mockRestore(); }
});

it("구독자가 없는 선조회 중 도착한 변경도 다음 구독에서 다시 확인한다", async () => {
    const key = "recent:range:4h:30";
    let finish!: (value: string) => void;
    const get = vi.fn(() => new Promise<string>((resolve) => { finish = resolve; }));
    subscribeQuery(key, get, () => undefined)();
    try {
        invalidate("recent");
        finish("이전 목록");
        await settle();
        expect(get).toHaveBeenCalledTimes(1);
        const off = subscribeQuery(key, get, () => undefined);
        try {
            expect(get).toHaveBeenCalledTimes(2);
            finish("바뀐 목록");
            await settle();
            expect(querySnapshot(key).data).toBe("바뀐 목록");
        } finally { off(); }
    } finally { clearServerCache(); }
});

it("화면에 들어가기 전에 실패한 선조회는 열 때 다시 읽는다", async () => {
    const key = "files:project:nested";
    const read = vi.fn<() => Promise<string>>().mockRejectedValueOnce(new Error("unavailable")).mockResolvedValue("목록");
    subscribeQuery(key, read, () => undefined)();
    await settle();
    const off = subscribeQuery(key, read, () => undefined);
    try {
        await settle();
        expect(read).toHaveBeenCalledTimes(2);
        expect(querySnapshot(key)).toMatchObject({ data: "목록", error: null });
    } finally { off(); clearServerCache(); }
});

describe("임시 응답의 수명", () => {
    function partials() {
        let result: Record<string, unknown> = {};
        setLive((l) => { result = l.partials; return l; });
        return result;
    }
    function turn(id: string, status: string) {
        applyEvent({
            kind: "turn.updated", session_id: "s", project_id: "p",
            payload: { id, status }, seq: 1, created_at: "2026-01-01T00:00:00Z",
        });
    }
    it.each(["completed", "failed", "cancelled", "interrupted"])("%s이면 같은 턴의 임시 응답만 지운다", (status) => {
        try {
            const other = { turn_id: "other", text: "다른 대화" };
            setLive((l) => ({ ...l, partials: { s: { turn_id: "done", text: "이전 응답" }, other } }));
            turn("done", status);
            expect(partials()).toEqual({ other });
        } finally { clearServerCache(); }
    });
    it("이전 턴의 종료 이벤트가 다음 턴의 임시 응답을 지우지 않는다", () => {
        try {
            const next = { turn_id: "next", text: "다음 응답" };
            setLive((l) => ({ ...l, partials: { s: next } }));
            turn("previous", "completed");
            turn("next", "running");
            expect(partials()).toEqual({ s: next });
        } finally { clearServerCache(); }
    });
    it("연속 snapshot은 묶어서 대화별 최신 것만 한 번에 반영한다", () => {
        vi.useFakeTimers();
        try {
            let renders = 0;
            const count = () => setLive((l) => { renders += 1; return l; });
            queuePartial("a", { turn_id: "t", text: "첫" });
            expect(partials()).toEqual({ a: { turn_id: "t", text: "첫" } });
            renders = 0;
            queuePartial("a", { turn_id: "t", text: "첫 응" });
            queuePartial("b", { turn_id: "u", text: "다른" });
            queuePartial("a", { turn_id: "t", text: "첫 응답" });
            count();
            expect(renders).toBe(1);
            expect(partials()).toEqual({ a: { turn_id: "t", text: "첫" } });
            vi.advanceTimersByTime(PARTIAL_FLUSH_MS);
            expect(partials()).toEqual({ a: { turn_id: "t", text: "첫 응답" }, b: { turn_id: "u", text: "다른" } });
        } finally { clearServerCache(); vi.useRealTimers(); }
    });
    it("확정 이벤트는 앞서 받은 snapshot을 먼저 반영한 뒤 적용한다", () => {
        vi.useFakeTimers();
        try {
            queuePartial("s", { turn_id: "done", text: "첫" });
            queuePartial("s", { turn_id: "done", text: "마지막" });
            turn("done", "completed");
            expect(partials()).toEqual({});
            vi.advanceTimersByTime(PARTIAL_FLUSH_MS);
            expect(partials()).toEqual({});
        } finally { clearServerCache(); vi.useRealTimers(); }
    });
    it("재동기화·로그아웃은 아직 반영하지 않은 snapshot도 버린다", () => {
        vi.useFakeTimers();
        try {
            queuePartial("s", { turn_id: "t", text: "첫" });
            queuePartial("s", { turn_id: "t", text: "이전 연결" });
            resyncAll();
            vi.advanceTimersByTime(PARTIAL_FLUSH_MS);
            expect(partials()).toEqual({});
            queuePartial("s", { turn_id: "t", text: "이전 세대" });
            queuePartial("s", { turn_id: "t", text: "이전 세대 2" });
            clearServerCache();
            vi.advanceTimersByTime(PARTIAL_FLUSH_MS);
            expect(partials()).toEqual({});
        } finally { clearServerCache(); vi.useRealTimers(); }
    });
    it("재동기화하면 삭제 신호를 놓친 숨겨진 대화의 임시 응답도 비운다", () => {
        try {
            setLive((l) => ({ ...l, status: "live", partials: {
                visible: { turn_id: "done", text: "이전 응답" },
                hidden: { turn_id: "hidden-done", text: "숨긴 응답" },
            } }));
            resyncAll();
            expect(partials()).toEqual({});
        } finally { clearServerCache(); }
    });
});

it("봇·대화 변경을 다른 화면의 그룹에도 반영한다", async () => {
    const keys = ["bots", "bot-rooms", "bot-room:s"];
    const fetchers = keys.map(() => vi.fn(async () => ({})));
    const offs = keys.map((key, i) => subscribeQuery(key, fetchers[i]!, () => undefined));
    try {
        await settle();
        applyEvent({ kind: "bot.changed", session_id: null, project_id: "p", payload: { id: "b" }, seq: 1, created_at: "2026-01-01T00:00:00Z" });
        await settle();
        for (const f of fetchers) expect(f).toHaveBeenCalledTimes(2);
        applyEvent({ kind: "session.updated", session_id: "s", project_id: "p", payload: {}, seq: 3, created_at: "2026-01-01T00:00:00Z" });
        await settle();
        expect(fetchers[1]).toHaveBeenCalledTimes(3);
        expect(fetchers[2]).toHaveBeenCalledTimes(3);
    } finally { offs.forEach((off) => off()); clearServerCache(); }
});

it("종료 이벤트의 화면 반영 측정은 재동기화·로그아웃 때 정리한다", () => {
    const off = deliveryTiming.watch("delivery");
    const event = (id: string, status: string) => applyEvent({
        kind: "turn.updated", session_id: "delivery", project_id: null,
        payload: { id, status }, seq: 1, created_at: "2026-01-01T00:00:00Z",
    });
    try {
        event("running", "running");
        expect(deliveryTiming.applied("running")).toBeNull();
        event("done", "completed");
        expect(deliveryTiming.applied("done")).toBeGreaterThanOrEqual(0);
        resyncAll();
        expect(deliveryTiming.applied("done")).toBeNull();
        event("cancelled", "cancelled");
        expect(deliveryTiming.applied("cancelled")).not.toBeNull();
        clearServerCache();
        expect(deliveryTiming.applied("cancelled")).toBeNull();
    } finally { off(); clearServerCache(); }
});

describe("이벤트 무효화 범위", () => {
    it("같은 이벤트 묶음의 조회를 합치고 대화 본문·실행 상태를 우선 갱신한다", async () => {
        const order: string[] = [];
        const offs = ["recent", "session:s", "messages:s", "turns:s"].map((key) =>
            subscribeQuery(key, async () => { order.push(key); return {}; }, () => undefined));
        try {
            await settle();
            order.length = 0;
            const event = { session_id: "s", project_id: "p", seq: 1, created_at: "2026-01-01T00:00:00Z" };
            batchEventQueries(() => {
                applyEvent({ ...event, kind: "message.created", payload: {} });
                applyEvent({ ...event, kind: "message.created", seq: 2, payload: {} });
                applyEvent({ ...event, kind: "turn.updated", seq: 3, payload: { status: "completed", id: "t" } });
            });
            await settle();
            expect(order).toEqual(["messages:s", "turns:s", "session:s", "recent"]);
        } finally { offs.forEach((off) => off()); clearServerCache(); }
    });

    it.each([true, false])("같은 묶음에 숨김 이벤트가 있으면 뒤늦은 목록을 표시하지 않는다 (숨김 먼저 %s)", async (hideFirst) => {
        const key = "recent:range:4h:30";
        let finish!: (value: string[]) => void;
        const get = vi.fn(() => new Promise<string[]>((resolve) => { finish = resolve; }));
        const off = subscribeQuery(key, get, () => undefined);
        try {
            batchEventQueries(() => {
                for (const [index, hidden] of [hideFirst, !hideFirst].entries()) {
                    applyEvent({ kind: "recent.updated", payload: { hidden }, seq: index + 1,
                        session_id: null, project_id: "p", created_at: "2026-01-01T00:00:00Z" });
                }
            });
            finish(["숨긴 항목"]);
            await settle();
            expect(get).toHaveBeenCalledTimes(2);
            expect(querySnapshot(key).data).toBeUndefined();
            finish([]);
            await settle();
            expect(querySnapshot(key).data).toEqual([]);
        } finally { off(); clearServerCache(); }
    });

    it("새 응답 이벤트가 사용량 대시보드 조회를 다시 읽게 한다", async () => {
        const fetcher = vi.fn(async () => "usage");
        const off = subscribeQuery("usage:dashboard:range-7d", fetcher, () => undefined);
        try {
            await settle();
            applyEvent({ kind: "message.created", session_id: null, project_id: null, payload: {}, seq: 1, created_at: "2026-01-01T00:00:00Z" });
            await settle();
            expect(fetcher).toHaveBeenCalledTimes(2);
        } finally { off(); clearServerCache(); }
    });
});

describe("연결 문제 조회", () => {
    it("연결 문제는 화면 오류로 넘기지 않고 기존 값을 둔 채 연결 확인을 요청하며, 복구되면 다시 읽는다", async () => {
        const handler = vi.fn();
        setTransportFailureHandler(handler);
        let fail: unknown = null;
        let value = "first";
        const fetcher = vi.fn(async () => { if (fail) throw fail; return value; });
        const key = "recent:transport";
        const off = subscribeQuery(key, fetcher, () => undefined);
        try {
            await settle();
            fail = new ApiError(0, "network_error", "서버 응답을 받지 못했습니다", true, { result_unknown: false });
            invalidate(key);
            await settle();
            expect(handler).toHaveBeenCalledTimes(1);
            expect(querySnapshot(key)).toEqual({ data: "first", error: null, loading: true });
            fail = null;
            value = "second";
            retryWaiting();
            await settle();
            expect(querySnapshot(key)).toEqual({ data: "second", error: null, loading: false });
            // 연결 문제가 아닌 오류는 화면에 그대로 보이고 연결 복구 재시도 대상이 아니다.
            const forbidden = new ApiError(403, "forbidden", "권한이 없습니다");
            fail = forbidden;
            invalidate(key);
            await settle();
            expect(querySnapshot(key)).toEqual({ data: "second", error: forbidden, loading: false });
            retryWaiting();
            await settle();
            // 첫 조회·연결 실패·복구 재조회·403 조회. 403 뒤의 retryWaiting은 다시 읽지 않는다.
            expect(fetcher).toHaveBeenCalledTimes(4);
            expect(handler).toHaveBeenCalledTimes(1);
        } finally { off(); setTransportFailureHandler(null); clearServerCache(); }
    });

    it("응답을 받지 못한 변경(결과 불명)은 연결 문제로 숨기지 않는다", () => {
        expect(isTransportError(new TypeError("암호화 연결이 끊겼습니다."))).toBe(true);
        expect(isTransportError(new ApiError(0, "network_error", "x", true, { result_unknown: false }))).toBe(true);
        expect(isTransportError(new ApiError(0, "network_error", "x", true, { result_unknown: true }))).toBe(false);
        expect(isTransportError(new ApiError(0, "network_error", "x", true, { result_unknown: true }), true)).toBe(true);
        expect(isTransportError(new ApiError(409, "revision_conflict", "x"))).toBe(false);
    });
});

describe("중복 viewer의 조회 구독(PANE-007)", () => {
    it("연결 재검증 중 같은 대화의 진행 중 응답을 먼저 표시하되 후속 조회는 유지한다", async () => {
        const releases: ((v: string) => void)[] = [];
        const load = vi.fn(() => new Promise<string>((resolve) => releases.push(resolve)));
        const off = subscribeQuery("messages:resume", load, () => undefined);
        try {
            resyncAll(true);
            resyncAll(true);
            expect(load).toHaveBeenCalledTimes(1);
            releases[0]!("first");
            await settle();
            expect(querySnapshot("messages:resume").data).toBe("first");
            expect(load).toHaveBeenCalledTimes(2);
            releases[1]!("current");
            await settle();
            expect(querySnapshot("messages:resume").data).toBe("current");
        } finally { off(); clearServerCache(); }
    });
    it("첫 조회 중 이벤트가 몰려도 한 요청과 후속 재검증 한 번으로 합친다", async () => {
        const releases: ((value: string) => void)[] = [];
        const fetcher = vi.fn(() => new Promise<string>((resolve) => releases.push(resolve)));
        const off = subscribeQuery("burst", fetcher, () => undefined);
        try {
            for (let i = 0; i < 10; i++) invalidate("burst");
            expect(fetcher).toHaveBeenCalledTimes(1);
            releases[0]!("old");
            await settle();
            expect(fetcher).toHaveBeenCalledTimes(2);
            expect(querySnapshot("burst").data).toBeUndefined();
            releases[1]!("latest");
            await settle();
            expect(querySnapshot("burst")).toEqual({ data: "latest", error: null, loading: false });
        } finally { off(); clearServerCache(); }
    });
    it("조회 중 마지막 구독자가 닫히면 후속 요청을 미루고 다시 열 때만 갱신한다", async () => {
        let release!: (value: string) => void;
        const fetcher = vi.fn(() => new Promise<string>((resolve) => { release = resolve; }));
        const off = subscribeQuery("hidden-burst", fetcher, () => undefined);
        invalidate("hidden-burst");
        off();
        release("stale");
        await settle();
        expect(fetcher).toHaveBeenCalledTimes(1);
        const again = subscribeQuery("hidden-burst", async () => "fresh", () => undefined);
        try {
            await settle();
            expect(querySnapshot("hidden-burst").data).toBe("fresh");
        } finally { again(); clearServerCache(); }
    });
    it("같은 대화를 여러 pane에서 보면 한 번 읽고 무효화도 한 번만 다시 읽는다", async () => {
        const fetcher = vi.fn(async () => "data");
        const a = vi.fn();
        const b = vi.fn();
        const offA = subscribeQuery("messages:dup", fetcher, a);
        const offB = subscribeQuery("messages:dup", fetcher, b);
        await settle();
        expect(fetcher).toHaveBeenCalledTimes(1);
        invalidate("messages:dup");
        await settle();
        expect(fetcher).toHaveBeenCalledTimes(2);
        expect(a).toHaveBeenCalled();
        expect(b).toHaveBeenCalled();
        // 한 viewer를 닫아도 남은 viewer는 계속 갱신된다.
        offA();
        b.mockClear();
        invalidate("messages:dup");
        await settle();
        expect(fetcher).toHaveBeenCalledTimes(3);
        expect(b).toHaveBeenCalled();
        offB();
    });
    it("마지막 viewer를 닫으면 다시 읽지 않고, 다시 열 때 한 번만 최신 값을 읽는다", async () => {
        const fetcher = vi.fn(async () => fetcher.mock.calls.length);
        const off = subscribeQuery("messages:closed", fetcher, () => undefined);
        await settle();
        off();
        invalidate("messages:closed");
        invalidate("messages:closed");
        await settle();
        expect(fetcher).toHaveBeenCalledTimes(1);
        const again = subscribeQuery("messages:closed", fetcher, () => undefined);
        await settle();
        expect(fetcher).toHaveBeenCalledTimes(2);
        again();
        // 무효화가 없었으면 다시 열어도 cache를 그대로 쓴다.
        const third = subscribeQuery("messages:closed", fetcher, () => undefined);
        await settle();
        expect(fetcher).toHaveBeenCalledTimes(2);
        third();
    });
    it("구독자가 없는 항목은 상한까지만 보관하고 보고 있는 항목은 버리지 않는다", async () => {
        const kept = subscribeQuery("messages:kept", async () => "x", () => undefined);
        for (let i = 0; i < IDLE_ENTRY_LIMIT + 50; i++) subscribeQuery(`messages:idle-${i}`, async () => i, () => undefined)();
        await settle();
        const stats = cacheStats();
        expect(stats.entries).toBeLessThanOrEqual(IDLE_ENTRY_LIMIT + stats.subscribed);
        expect(stats.subscribed).toBeGreaterThanOrEqual(1);
        const fetcher = vi.fn(async () => "y");
        const again = subscribeQuery("messages:kept", fetcher, () => undefined);
        await settle();
        expect(fetcher).not.toHaveBeenCalled();
        again();
        kept();
    });
});

describe("이벤트 payload로 대화 cache를 갱신", () => {
    const at = "2026-01-01T00:00:00Z";
    const message = (seq: number, role = "assistant", content: unknown = { text: `m${seq}` }) =>
        ({ id: `m${seq}`, session_id: "s", seq, role, content, turn_id: null, created_at: at });
    const page = (seqs: number[], more = false) =>
        ({ items: seqs.map((seq) => message(seq)), has_more_before: false, has_more_after: more, timeline_revision: 1, rewind_boundary_seq: null });
    const created = (payload: unknown, seq = 1) => applyEvent({ kind: "message.created", session_id: "s", project_id: "p", payload, seq, created_at: at });
    const call = (id: string, revision: number, status = "running", created = at) =>
        ({ id, session_id: "s", revision, status, created_at: created, args: { text: "x".repeat(8) } });
    const updated = (payload: unknown) => applyEvent({ kind: "tool_call.updated", session_id: "s", project_id: "p", payload, seq: 1, created_at: at });
    const seqs = () => (querySnapshot<{ items: { seq: number }[] }>("messages:s").data?.items ?? []).map((item) => item.seq);

    it("새 메시지는 최신 창을 다시 받지 않고 끝에 붙이며, 대화 보기에서 숨는 메시지는 건드리지 않는다", async () => {
        const fetcher = vi.fn(async () => page([1, 2]));
        const off = subscribeQuery("messages:s", fetcher, () => undefined);
        try {
            await settle();
            created(message(3, "tool"));
            created(message(4, "note", { type: "cli_activity" }));
            created(message(5));
            created(message(5));
            await settle();
            expect(fetcher).toHaveBeenCalledTimes(1);
            expect(seqs()).toEqual([1, 2, 5]);
        } finally { off(); clearServerCache(); }
    });

    it.each([
        ["경계를 바꿀 수 있는 note", () => message(3, "note", { type: "compaction" }), page([1, 2])],
        ["형태를 알 수 없는 payload", () => ({}), page([1, 2])],
        ["다른 대화의 메시지", () => ({ ...message(3), session_id: "other" }), page([1, 2])],
        ["최신 창이 아닌 페이지", () => message(3), page([1, 2], true)],
        ["순서가 어긋난 메시지", () => ({ ...message(2), id: "unknown" }), page([1, 2])],
    ])("%s는 기존처럼 다시 읽는다", async (_name, payload, initial) => {
        const fetcher = vi.fn(async () => initial);
        const off = subscribeQuery("messages:s", fetcher, () => undefined);
        try {
            await settle();
            created(payload());
            await settle();
            expect(fetcher).toHaveBeenCalledTimes(2);
        } finally { off(); clearServerCache(); }
    });

    it("최신 창이 서버 페이지 상한까지 커지면 다시 읽어 최근 창으로 되돌린다", async () => {
        const full = Array.from({ length: RANGE_WINDOW }, (_, index) => index + 1);
        const fetcher = vi.fn(async () => page(full.slice(0, RANGE_WINDOW - 1)));
        const off = subscribeQuery("messages:s", fetcher, () => undefined);
        try {
            await settle();
            created(message(RANGE_WINDOW));
            await settle();
            expect(fetcher).toHaveBeenCalledTimes(1);
            expect(seqs()).toHaveLength(RANGE_WINDOW);
            created(message(RANGE_WINDOW + 1));
            await settle();
            expect(fetcher).toHaveBeenCalledTimes(2);
        } finally { off(); clearServerCache(); }
    });

    it("조회 중에 온 메시지는 그 조회 결과로 덮이지 않고 한 번 더 확인한다", async () => {
        let finish!: (value: unknown) => void;
        const fetcher = vi.fn(() => new Promise<unknown>((resolve) => { finish = resolve; }));
        const off = subscribeQuery("messages:s", fetcher, () => undefined);
        try {
            // 첫 조회 전에는 붙일 창이 없으므로 진행 중인 조회에 재확인을 기록한다.
            created(message(3));
            finish(page([1, 2]));
            await settle();
            expect(fetcher).toHaveBeenCalledTimes(2);
            finish(page([1, 2, 3]));
            await settle();
            invalidate("messages:s");
            created(message(4));
            expect(seqs()).toEqual([1, 2, 3, 4]);
            finish(page([1, 2, 3]));
            await settle();
            expect(seqs()).toEqual([1, 2, 3, 4]);
            expect(fetcher).toHaveBeenCalledTimes(4);
            finish(page([1, 2, 3, 4]));
            await settle();
            expect(seqs()).toEqual([1, 2, 3, 4]);
        } finally { off(); clearServerCache(); }
    });

    it("도구 호출 변경은 목록을 다시 받지 않고 그 한 건만 반영한다", async () => {
        const fetcher = vi.fn(async () => [call("b", 1, "running", "2026-01-01T00:00:02Z"), call("a", 3, "succeeded", "2026-01-01T00:00:01Z")]);
        const off = subscribeQuery("calls:s", fetcher, () => undefined);
        try {
            await settle();
            updated(call("b", 2, "succeeded", "2026-01-01T00:00:02Z"));
            updated(call("a", 2, "running", "2026-01-01T00:00:01Z"));
            updated(call("c", 1, "pending_approval", "2026-01-01T00:00:03Z"));
            await settle();
            expect(fetcher).toHaveBeenCalledTimes(1);
            expect(querySnapshot<{ id: string; status: string }[]>("calls:s").data?.map((row) => [row.id, row.status]))
                .toEqual([["c", "pending_approval"], ["b", "succeeded"], ["a", "succeeded"]]);
            updated({ id: "d" });
            await settle();
            expect(fetcher).toHaveBeenCalledTimes(2);
        } finally { off(); clearServerCache(); }
    });
});
