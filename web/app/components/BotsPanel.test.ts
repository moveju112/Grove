import { describe, expect, it } from "vitest";
import { avatarInk } from "./BotsPanel";

function lum(hex: string): number {
    const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((x) => (x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4));
    return 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;
}
const contrast = (a: string, b: string) => {
    const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
    return (x! + 0.05) / (y! + 0.05);
};

describe("기본형 봇 아바타 글자색", () => {
    it("서버 기본 팔레트 8색 모두에서 AA(4.5:1) 이상이다", () => {
        // src/bots.rs COLORS
        for (const bg of ["#2563eb", "#16a34a", "#d97706", "#dc2626", "#7c3aed", "#0891b2", "#db2777", "#4b5563"]) {
            expect(contrast(avatarInk(bg), bg), bg).toBeGreaterThanOrEqual(4.5);
        }
    });
    it("형식이 다른 값은 흰 글자로 둔다", () => {
        expect(avatarInk("blue")).toBe("#ffffff");
    });
});
