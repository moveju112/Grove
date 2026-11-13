import { describe, expect, it, vi } from "vitest";
import { applyEvent, cacheStats, clearServerCache, IDLE_ENTRY_LIMIT, invalidate, resyncAll, setLive, subscribeQuery } from "./store";
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
