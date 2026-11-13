import { describe, expect, it } from "vitest";
import { pairingLink, pairingStatus, parsePairingLink } from "./pairing";

const code = "018f1080-0000-7000-8000-000000000001." + "a".repeat(43);
describe("기기 한 대용 페어링 링크", () => {
    it("서버 origin과 fragment만 허용하고 원문 자격을 query로 전송하지 않는다", () => {
        const link = pairingLink("HTTPS://EXAMPLE.test:443", code);
        expect(link).toBe("https://example.test/#pairing=" + code);
        expect(parsePairingLink(link)).toEqual({ origin: "https://example.test", code });
        const url = new URL(link);
        expect(url.pathname).toBe("/");
        expect(url.search).toBe("");
        expect(url.username).toBe("");
        expect(url.password).toBe("");
    });
    it.each([
        "https://user:password@example.test/#pairing=" + code,
        "https://example.test/sub/#pairing=" + code,
        "https://example.test/?token=long-lived#pairing=" + code,
        "javascript:alert(1)#pairing=" + code,
        "https://example.test/#pairing=" + code + "&token=x",
        "https://example.test/#pairing=grv_id.long-lived",
        "https://example.test/#pairing=" + code + "#extra",
    ])("비밀번호·장기 토큰·모호한 링크를 거절한다: %s", (link) => {
        expect(() => parsePairingLink(link)).toThrow();
    });
    it("만료 경계와 사용·폐기를 구분한다", () => {
        const time = Date.parse("2026-01-01T00:05:00Z");
        const info = { expires_at: "2026-01-01T00:05:00Z", revoked_at: null, consumed_at: null };
        expect(pairingStatus(info, time - 1)).toBe("대기 중");
        expect(pairingStatus(info, time)).toBe("만료됨");
        expect(pairingStatus({ ...info, revoked_at: "2026-01-01T00:01:00Z" }, time)).toBe("폐기됨");
        expect(pairingStatus({ ...info, consumed_at: "2026-01-01T00:01:00Z" }, time)).toBe("사용됨");
    });
    it("만료 없는 링크와 잠금·소비를 구분한다", () => {
        const info = { expires_at: null, revoked_at: null, consumed_at: null, locked_at: null };
        expect(pairingStatus(info, Date.parse("2099-01-01T00:00:00Z"))).toBe("대기 중");
        expect(pairingStatus({ ...info, locked_at: "2026-01-01T00:00:00Z" })).toBe("잠김");
        expect(pairingStatus({ ...info, consumed_at: "2026-01-01T00:00:00Z" })).toBe("사용됨");
    });
});
