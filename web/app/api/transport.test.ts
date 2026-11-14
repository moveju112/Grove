import { afterEach, describe, expect, it, vi } from "vitest";
import { Cipher, Mux, base64, connectionLink, parseConnectionLink, transportFetch, validateConnection } from "./transport";

afterEach(() => vi.unstubAllGlobals());
const key = base64(new Uint8Array(32).fill(7));
describe("E2EE connection", () => {
    it("rejects a blocked WebSocket even when no close event follows the error", async () => {
        class BlockedSocket extends EventTarget {
            onerror: (() => void) | null = null;
            constructor() {
                super();
                queueMicrotask(() => {
                    this.onerror?.();
                    this.dispatchEvent(new Event("error"));
                });
            }
            close() {}
        }
        vi.stubGlobal("WebSocket", BlockedSocket);
        await expect(Mux.open({ endpoint: "ws://127.0.0.1/api/e2ee", key })).rejects.toThrow("암호화 연결");
    });
    it("preserves the relay room while keeping pairing credentials in the fragment", () => {
        const config = { endpoint: "wss://relay.example/api/e2ee/" + "a".repeat(64), key };
        expect(parseConnectionLink(connectionLink(config)).connection).toEqual(config);
        expect(() => validateConnection({ endpoint: config.endpoint + "/control", key })).toThrow();
    });
    it("uses a fragment for the pin and one-time code, never query parameters", () => {
        const config = { endpoint: "wss://daemon.example/api/e2ee", key };
        const code = "12345678-1234-1234-1234-123456789012." + "a".repeat(43);
        const link = connectionLink(config, code);
        expect(new URL(link).origin).toBe("https://grove.choondoggy.com");
        expect(new URL(link).search).toBe("");
        expect(parseConnectionLink(link)).toEqual({ connection: config, code });
    });
    it.each(["ws://daemon.example/api/e2ee", "wss://user:secret@daemon.example/api/e2ee",
        "wss://daemon.example/api/e2ee?token=x", "wss://daemon.example/other"])("rejects unsafe endpoint %s", (endpoint) => {
        expect(() => validateConnection({ endpoint, key })).toThrow();
    });
    it("does not fall back to HTTP for damaged stored settings or an unconnected Pages client", async () => {
        const fetch = vi.fn();
        vi.stubGlobal("fetch", fetch);
        vi.stubGlobal("localStorage", { getItem: () => "broken" });
        await expect(transportFetch("/api/v1/health")).rejects.toThrow();
        vi.stubGlobal("localStorage", { getItem: () => null });
        vi.stubGlobal("location", { hostname: "grove.choondoggy.com" });
        await expect(transportFetch("/api/v1/health")).rejects.toThrow("연결 링크");
        expect(fetch).not.toHaveBeenCalled();
    });
    it("authenticates ciphertext and rejects replay", async () => {
        const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
        const sender = new Cipher(key);
        const receiver = new Cipher(key);
        const plain = new TextEncoder().encode("transport secret");
        const ciphertext = await sender.seal(plain);
        expect(await receiver.open(ciphertext)).toEqual(plain);
        await expect(receiver.open(ciphertext)).rejects.toThrow();
        const corrupted = new Uint8Array(ciphertext.slice(0));
        corrupted[0] = corrupted[0]! ^ 1;
        await expect(new Cipher(key).open(corrupted.buffer)).rejects.toThrow();
    });
});
