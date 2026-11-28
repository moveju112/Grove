import { describe, expect, it, vi } from "vitest";
import type { Message, MessagePage, ToolCallRow } from "../api/generated";
import { CONVERSATION_CALLS, KEPT_SESSIONS, clearKeptPages, conversationVisibility, keepOlderPages, mergeMessages, mergeToolCall, readMessageRange, singleFlight, takeOlderPages } from "./conversationPages";

const msg = (seq: number): Message => ({ id: `m${seq}`, session_id: "s", seq, role: "user", content: null, turn_id: null, created_at: "2026-01-01T00:00:00Z" });
const page = (seqs: number[], more = false, revision = 1): MessagePage => ({ items: seqs.map(msg), has_more_before: more, has_more_after: false, timeline_revision: revision, rewind_boundary_seq: null });
const range = (from: number, to: number) => Array.from({ length: Math.max(0, to - from + 1) }, (_, i) => from + i);

/// seq 1..max가 있는 가짜 서버.
function server(max: number, revision = 1) {
    const calls: string[] = [];
    let active = 0;
    let peak = 0;
    const get = async (path: string) => {
        calls.push(path);
        active++; peak = Math.max(peak, active);
        await Promise.resolve();
        active--;
        const q = new URLSearchParams(path.split("?")[1]);
        const limit = Number(q.get("limit"));
        const all = range(1, max);
        if (q.has("after_seq")) return page(all.filter((s) => s > Number(q.get("after_seq"))).slice(0, limit), false, revision);
        const before = all.filter((s) => s < Number(q.get("before_seq")));
        return page(before.slice(-limit), before.length > limit, revision);
    };
    return { get, calls, peak: () => peak };
}

describe("이전 메시지 조회", () => {
    it("같은 페이지가 두 번 와도 seq로 한 번만 합친다", () => {
        expect(mergeMessages([msg(1), msg(2)], [msg(2), msg(3)]).map((m) => m.seq)).toEqual([1, 2, 3]);
    });

    it("첫 응답 전에 두 번 호출해도 요청은 하나다", async () => {
        const flight = singleFlight();
        const task = vi.fn(() => new Promise<void>((resolve) => setTimeout(resolve, 5)));
        const a = flight.run("s", task);
        const b = flight.run("s", task);
        expect(a).toBe(b);
        expect(flight.busy("s")).toBe(true);
        await a;
        expect(task).toHaveBeenCalledTimes(1);
        expect(flight.busy("s")).toBe(false);
    });
});

describe("목적지까지 한 번에 읽기", () => {
    it("목적지 주변과 사이 구간을 빠짐없이 병렬로 읽는다", async () => {
        const s = server(3000);
        const result = await readMessageRange("s", 120, 2901, 1, s.get);
        expect(result!.items.map((m) => m.seq)).toEqual(range(71, 2900));
        expect(result!.more).toBe(true);
        // 목적지 문맥 1회 + 500개 창 6회. 100개씩 순차 28회가 아니다.
        expect(s.calls).toHaveLength(7);
        expect(s.peak()).toBeGreaterThan(1);
        expect(s.peak()).toBeLessThanOrEqual(4);
    });

    it("되감기로 seq가 비어도 범위를 덮는다", async () => {
        const get = async (path: string) => {
            const q = new URLSearchParams(path.split("?")[1]);
            const all = range(1, 2000).filter((s) => s < 300 || s > 900);
            if (q.has("after_seq")) return page(all.filter((s) => s > Number(q.get("after_seq"))).slice(0, Number(q.get("limit"))));
            return page(all.filter((s) => s < Number(q.get("before_seq"))).slice(-Number(q.get("limit"))), true);
        };
        const result = await readMessageRange("s", 100, 1500, 1, get);
        expect(result!.items.map((m) => m.seq)).toEqual(range(51, 1499).filter((s) => s < 300 || s > 900));
    });

    it("timeline이 바뀌었으면 버린다", async () => {
        expect(await readMessageRange("s", 10, 200, 2, server(300, 1).get)).toBeNull();
    });
});

describe("읽던 과거 구간 보관", () => {
    it("최신 창과 이어질 때만 돌려주고 끊기면 버린다", () => {
        clearKeptPages();
        keepOlderPages("s", 1, range(1, 300).map(msg), false);
        expect(takeOlderPages("s", page(range(251, 350)))!.items.map((m) => m.seq)).toEqual(range(1, 250));
        expect(takeOlderPages("s", page(range(301, 400)))).toBeNull();
        expect(takeOlderPages("s", page(range(251, 350)))).toBeNull();
    });

    it("다른 timeline이면 쓰지 않는다", () => {
        clearKeptPages();
        keepOlderPages("s", 1, range(1, 300).map(msg), true);
        expect(takeOlderPages("s", page(range(201, 300), true, 2))).toBeNull();
    });

    it("보관 대화 수를 제한한다", () => {
        clearKeptPages();
        for (let i = 0; i <= KEPT_SESSIONS; i++) keepOlderPages(`s${i}`, 1, range(1, 200).map(msg), false);
        expect(takeOlderPages("s0", page(range(101, 200)))).toBeNull();
        expect(takeOlderPages(`s${KEPT_SESSIONS}`, page(range(101, 200)))).not.toBeNull();
    });
});

describe("이벤트로 받은 한 건의 반영", () => {
    it("대화 보기의 포함 여부를 서버 필터와 같게 판정한다", () => {
        const visibility = (role: string, content: unknown = null) => conversationVisibility({ role, content });
        expect([visibility("user"), visibility("assistant"), visibility("tool")]).toEqual(["shown", "shown", "hidden"]);
        expect([visibility("note", { type: "cli_activity" }), visibility("note", { type: "task_result" })]).toEqual(["hidden", "hidden"]);
        expect([visibility("note", { type: "compaction" }), visibility("note", null), visibility("system")]).toEqual(["unknown", "unknown", "unknown"]);
    });

    it("도구 호출은 최신순과 상한을 지키고 오래된 revision으로 되돌리지 않는다", () => {
        const call = (id: string, revision = 1, created_at = `2026-01-01T00:00:${id.padStart(2, "0")}Z`) => ({ id, revision, created_at }) as ToolCallRow;
        const ids = (list: ToolCallRow[]) => list.map((row) => row.id);
        const list = [call("5"), call("3"), call("1")];
        expect(ids(mergeToolCall(list, call("4")))).toEqual(["5", "4", "3", "1"]);
        expect(ids(mergeToolCall(list, call("9")))).toEqual(["9", "5", "3", "1"]);
        expect(mergeToolCall(list, call("3", 2))[1]!.revision).toBe(2);
        expect(mergeToolCall([call("3", 4)], call("3", 2))[0]!.revision).toBe(4);
        // 같은 시각이면 id가 큰 쪽이 앞이다(서버의 created_at DESC, id DESC).
        expect(ids(mergeToolCall([call("b", 1, "t"), call("a", 1, "t")], call("c", 1, "t")))).toEqual(["c", "b", "a"]);
        const full = Array.from({ length: CONVERSATION_CALLS }, (_, i) => call(String(i), 1, `t${String(CONVERSATION_CALLS - i).padStart(4, "0")}`));
        expect(mergeToolCall(full, call("old", 1, "t0000"))).toBe(full);
        const next = mergeToolCall(full, call("new", 1, "t9999"));
        expect([next.length, next[0]!.id, next.at(-1)!.id]).toEqual([CONVERSATION_CALLS, "new", String(CONVERSATION_CALLS - 2)]);
    });
});
