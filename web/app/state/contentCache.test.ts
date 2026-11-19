import { describe, expect, it } from "vitest";
import { clearContentCaches, createContentCache, textBytes } from "./contentCache";

function cache(maxBytes = 100, maxEntries = 3) {
    let owner = 1;
    const c = createContentCache<string>({ maxBytes, maxEntries, size: (v) => v.length, owner: () => owner });
    return { c, setOwner: (o: number) => { owner = o; } };
}

describe("contentCache", () => {
    it("항목 수 상한을 넘으면 가장 오래 쓰지 않은 항목부터 버린다", () => {
        const { c } = cache();
        c.set("a", "1"); c.set("b", "2"); c.set("c", "3");
        expect(c.get("a")).toBe("1");
        c.set("d", "4");
        expect(c.get("b")).toBeUndefined();
        expect(c.get("a")).toBe("1");
        expect(c.stats().entries).toBe(3);
    });

    it("바이트 상한을 지키고 상한보다 큰 항목은 보관하지 않는다", () => {
        const { c } = cache(10, 10);
        c.set("a", "xxxx"); c.set("b", "yyyy");
        c.set("c", "zzzz");
        expect(c.get("a")).toBeUndefined();
        expect(c.stats().bytes).toBe(8);
        c.set("big", "x".repeat(11));
        expect(c.get("big")).toBeUndefined();
        expect(c.get("c")).toBe("zzzz");
    });

    it("같은 key를 갱신하면 크기를 다시 계산한다", () => {
        const { c } = cache();
        c.set("a", "xx");
        c.set("a", "xxxxx");
        expect(c.stats()).toEqual({ entries: 1, bytes: 5 });
    });

    it("인증 세대가 바뀌면 이전 항목을 돌려주지 않고, 이전 세대에 시작한 조회 결과도 저장하지 않는다", () => {
        const { c, setOwner } = cache();
        c.set("a", "old");
        setOwner(2);
        expect(c.get("a")).toBeUndefined();
        c.set("b", "late", 1);
        expect(c.get("b")).toBeUndefined();
        c.set("b", "fresh");
        expect(c.get("b")).toBe("fresh");
    });

    it("로그아웃 정리는 모든 본문 cache를 비운다", () => {
        const { c } = cache();
        c.set("a", "1");
        clearContentCaches();
        expect(c.stats()).toEqual({ entries: 0, bytes: 0 });
        expect(c.get("a")).toBeUndefined();
    });

    it("문자열 크기를 UTF-16 기준으로 추정한다", () => {
        expect(textBytes("ab", null)).toBe(68);
    });
});
