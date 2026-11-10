import { describe, expect, it } from "vitest";
import { Cursor, FrameParser, backoff } from "./events";

describe("events", () => {
    it("parses frames split across chunks", () => {
        const p = new FrameParser();
        expect(p.push("event: ev")).toEqual([]);
        const a = p.push("ent\nid: 3\ndata: {\"a\"\n");
        expect(a).toEqual([]);
        const b = p.push("data: :1}\n\n: hb\n\nevent: hello\ndata: x\n\n");
        expect(b).toEqual([
            { event: "event", data: "{\"a\"\n:1}", id: "3" },
            { event: "hello", data: "x", id: undefined },
        ]);
    });

    it("dedupes by seq", () => {
        const c = new Cursor(5);
        expect(c.accept(5)).toBe(false);
        expect(c.accept(6)).toBe(true);
        expect(c.accept(6)).toBe(false);
        expect(c.seq).toBe(6);
    });

    it("backs off with jitter and cap", () => {
        expect(backoff(0, () => 0)).toBe(250);
        expect(backoff(0, () => 1)).toBe(500);
        expect(backoff(20, () => 1)).toBe(30000);
    });
});
