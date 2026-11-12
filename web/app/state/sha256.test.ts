import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { sha256Fallback } from "./sha256";

const node = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

describe("SHA-256 대체 구현", () => {
    it("FIPS 예제와 Node crypto 결과가 같다", () => {
        expect(sha256Fallback(new Uint8Array())).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
        expect(sha256Fallback(new TextEncoder().encode("abc"))).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
        // 블록 경계(55·56·63·64·65바이트)와 여러 블록
        for (const n of [1, 55, 56, 63, 64, 65, 1000, 70_000]) {
            const b = Uint8Array.from({ length: n }, (_, i) => (i * 31 + 7) % 256);
            expect(sha256Fallback(b), `${n}바이트`).toBe(node(b));
        }
    });
});
