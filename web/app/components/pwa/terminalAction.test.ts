import { afterEach, beforeEach, expect, it, vi } from "vitest";

let lifecycle: typeof import("./lifecycle");
let action: typeof import("./terminalAction");
let browser: { onLine: boolean };
beforeEach(async () => {
    vi.resetModules();
    browser = { onLine: true };
    vi.stubGlobal("navigator", browser);
    vi.stubGlobal("fetch", vi.fn(async () => new Response('{"protocol":1}')));
    lifecycle = await import("./lifecycle");
    action = await import("./terminalAction");
});
afterEach(() => vi.unstubAllGlobals());

it("호환 확인 전 초기 resize와 입력 활성화를 허용하지 않는다", () => {
    const send = vi.fn(), blocked = vi.fn();
    expect(action.terminalAction(send, blocked)).toBe(false);
    expect(send).not.toHaveBeenCalled();
    expect(blocked).toHaveBeenCalledWith(expect.stringContaining("호환성을 확인"));
});

it("offline 이벤트 전에도 키보드·paste·보조키·resize를 버리고 복구 뒤 재전송하지 않는다", async () => {
    await lifecycle.checkCompatibility();
    const sent: string[] = [];
    const blocked = vi.fn();
    browser.onLine = false;
    for (const kind of ["keyboard", "paste", "helper", "observer-resize", "initial-resize"]) {
        expect(action.terminalAction(() => sent.push(kind), blocked)).toBe(false);
    }
    expect(blocked).toHaveBeenCalledTimes(5);
    expect(sent).toEqual([]);
    await lifecycle.checkCompatibility();
    browser.onLine = true;
    await lifecycle.checkCompatibility();
    expect(sent).toEqual([]);
    expect(action.terminalAction(() => sent.push("new-explicit-input"), blocked)).toBe(true);
    expect(sent).toEqual(["new-explicit-input"]);
});

it("protocol 불일치·서버 연결 실패도 입력과 resize에 같은 guard를 적용한다", async () => {
    const send = vi.fn(), blocked = vi.fn();
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("offline transport"); }));
    await lifecycle.checkCompatibility();
    expect(action.terminalAction(send, blocked)).toBe(false);
    vi.stubGlobal("fetch", vi.fn(async () => new Response('{"protocol":2}')));
    await lifecycle.checkCompatibility();
    expect(action.terminalAction(send, blocked)).toBe(false);
    expect(blocked).toHaveBeenLastCalledWith(expect.stringContaining("protocol 2"));
    expect(send).not.toHaveBeenCalled();
});

it("실제 socket 전송 오류를 PWA 차단으로 삼키거나 PTY 실패로 바꾸지 않는다", async () => {
    await lifecycle.checkCompatibility();
    const error = new Error("fixture socket failure"), blocked = vi.fn();
    expect(() => action.terminalAction(() => { throw error; }, blocked)).toThrow(error);
    expect(blocked).not.toHaveBeenCalled();
});
