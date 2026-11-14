import { describe, expect, it, vi } from "vitest";
import { applyEvent, cacheStats, clearServerCache, IDLE_ENTRY_LIMIT, invalidate, querySnapshot, resyncAll, retryWaiting, setLive, setTransportFailureHandler, subscribeQuery } from "./store";
import { ApiError, isTransportError } from "../api/client";
import type { EventRecord } from "../api/generated";
import { deliveryTiming } from "./deliveryTiming";

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

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

it("MCP 진행은 전체 도구 목록을 다시 읽지 않고 해당 대화만 갱신하며 종료 때 메모리를 지운다",async()=>{
    const fetcher=vi.fn(async()=>[]);
    const mcpFetcher=vi.fn(async()=>[]);
    const off=subscribeQuery("calls:progress-a",fetcher,()=>undefined);
    const offMcp=subscribeQuery("mcp",mcpFetcher,()=>undefined);
    const event=(kind:string,sid:string,id:string,payload:Record<string,unknown>)=>applyEvent({
        kind,session_id:sid,project_id:"p",payload:{id,name:"mcp_call",...payload},seq:1,created_at:"2026-01-01T00:00:00Z",
    } as EventRecord);
    try {
        await settle();
        event("tool_call.progress","progress-a","call-a",{progress:{value:50,total:100}});
        let first:unknown;
        setLive((l)=>{first=l.mcpProgress?.["progress-a"];return l;});
        event("tool_call.progress","progress-b","call-b",{progress:{value:1,total:null}});
        setLive((l)=>{
            expect(l.mcpProgress?.["progress-a"]).toBe(first);
            expect(l.mcpProgress?.["progress-a"]?.["call-a"]).toEqual({value:50,total:100});
            return l;
        });
        await settle();
        expect(fetcher).toHaveBeenCalledTimes(1);
        expect(mcpFetcher).toHaveBeenCalledTimes(1);
        event("tool_call.updated","progress-a","call-a",{status:"unknown"});
        setLive((l)=>{expect(l.mcpProgress?.["progress-a"]).toBeUndefined();return l;});
        await settle();
        expect(fetcher).toHaveBeenCalledTimes(2);
        expect(mcpFetcher).toHaveBeenCalledTimes(2);
        resyncAll();
        setLive((l)=>{expect(l.mcpProgress).toEqual({});return l;});
    } finally { off();offMcp();clearServerCache(); }
});
