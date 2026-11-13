import { afterEach, describe, expect, it, vi } from "vitest";
import { applyModifiers, guardComposition, NO_MODIFIERS, TerminalInput } from "./input";

describe("터미널 보조키", () => {
    it.each([
        ["c", { ctrl: true, alt: false }, "\x03"],
        ["[", { ctrl: true, alt: false }, "\x1b"],
        [" ", { ctrl: true, alt: false }, "\x00"],
        ["?", { ctrl: true, alt: false }, "\x7f"],
        ["x", { ctrl: false, alt: true }, "\x1bx"],
        ["c", { ctrl: true, alt: true }, "\x1b\x03"],
        ["\x1b", NO_MODIFIERS, "\x1b"],
        ["\t", NO_MODIFIERS, "\t"],
        ["\x1b[A", { ctrl: true, alt: false }, "\x1b[1;5A"],
        ["\x1bOB", { ctrl: false, alt: true }, "\x1b[1;3B"],
        ["\x1b[D", { ctrl: true, alt: true }, "\x1b[1;7D"],
        ["cat", { ctrl: true, alt: false }, "\x03at"],
        ["😀끝", { ctrl: false, alt: true }, "\x1b😀끝"],
        ["한글", { ctrl: true, alt: false }, "한글"],
        ["ß", { ctrl: true, alt: false }, "ß"],
    ])("%j에 %j를 적용한다", (data, modifiers, expected) => {
        expect(applyModifiers(data, modifiers)).toBe(expected);
    });

    it("데스크톱 키 시퀀스는 변경하지 않는다", () => {
        for (const data of ["abc", "\x03", "\x1b[1;5A", "\x1bOA", "\x1b[200~a\r\nb\x1b[201~", "한글"]) {
            expect(applyModifiers(data, NO_MODIFIERS)).toBe(data);
        }
    });

    it("React 재렌더 전 연속 입력과 특수키에도 다음 키 한 번만 적용한다", () => {
        const send = vi.fn();
        const changed = vi.fn();
        const input = new TerminalInput(send, changed);
        input.toggle("ctrl");
        input.data("");
        input.data("c");
        input.data("c");
        input.toggle("ctrl");
        input.data("\x1b[A");
        input.data("d");
        input.toggle("ctrl");
        input.toggle("alt");
        input.data("\t");
        input.data("z");
        expect(send.mock.calls.map(([data]) => data)).toEqual(["\x03", "c", "\x1b[1;5A", "d", "\x1b\t", "z"]);
        expect(changed).toHaveBeenLastCalledWith(NO_MODIFIERS);
    });

    it("보조키 해제와 연결 초기화 뒤에는 상태가 남지 않는다", () => {
        const send = vi.fn();
        const input = new TerminalInput(send, vi.fn());
        input.toggle("alt");
        input.reset();
        input.data("x");
        expect(send).toHaveBeenCalledWith("x");
    });
});

describe("붙여넣기", () => {
    it.each(["a\nb", "a\rb", "a\r\nb", "a\n"])("여러 줄 %j는 승인하기 전 xterm에도 전달하지 않는다", (text) => {
        const input = new TerminalInput(vi.fn(), vi.fn());
        const paste = vi.fn();
        const confirm = vi.fn(() => false);
        expect(input.paste(text, confirm, paste)).toBe(false);
        expect(confirm).toHaveBeenCalledOnce();
        expect(paste).not.toHaveBeenCalled();
    });

    it("한 줄은 확인 없이 전달하고 줄바꿈·bracketed paste 형식은 xterm에 맡긴다", () => {
        const input = new TerminalInput(vi.fn(), vi.fn());
        const paste = vi.fn();
        const confirm = vi.fn(() => true);
        expect(input.paste("한글", confirm, paste)).toBe(true);
        expect(confirm).not.toHaveBeenCalled();
        expect(paste).toHaveBeenLastCalledWith("한글");
        expect(input.paste("a\r\nb", confirm, paste)).toBe(true);
        expect(paste).toHaveBeenLastCalledWith("a\r\nb");
    });

    it("확정 IME → 붙여넣기 → 다음 보조키 순서를 보존하고 paste 바이트는 변형하지 않는다", () => {
        const send = vi.fn();
        const input = new TerminalInput(send, vi.fn());
        input.data("한글");
        input.toggle("ctrl");
        input.toggle("alt");
        const pasted = "\x1b[200~a\rb\x1b[201~";
        input.paste("a\nb", () => true, () => input.data(pasted));
        input.data("c");
        input.data("d");
        expect(send.mock.calls.map(([data]) => data)).toEqual(["한글", pasted, "\x1b\x03", "d"]);
    });

    it("붙여넣기 예외 뒤에도 키 변환을 복구한다", () => {
        const send = vi.fn();
        const input = new TerminalInput(send, vi.fn());
        input.toggle("ctrl");
        expect(() => input.paste("a", () => true, () => { throw new Error("paste failed"); })).toThrow("paste failed");
        input.data("c");
        expect(send).toHaveBeenCalledWith("\x03");
    });
});

describe("IME input 중복 방지", () => {
    afterEach(() => vi.useRealTimers());

    function setup() {
        const host = new EventTarget() as unknown as HTMLElement;
        const dispose = guardComposition(host);
        const nativeInput = vi.fn();
        const nativeEnd = vi.fn();
        host.addEventListener("input", nativeInput);
        host.addEventListener("compositionend", nativeEnd);
        const input = (data: string, inputType: string, isComposing = false) => {
            host.dispatchEvent(Object.assign(new Event("input"), { data, inputType, isComposing }));
        };
        return { host, dispose, nativeInput, nativeEnd, input };
    }

    it("중간 insertText와 확정 직후 중복 input만 막고 xterm의 compositionend는 유지한다", () => {
        vi.useFakeTimers();
        const { host, dispose, nativeInput, nativeEnd, input } = setup();
        host.dispatchEvent(new Event("compositionstart"));
        input("ㅎ", "insertText", true);
        input("하", "insertCompositionText", true);
        input("한글", "insertText", false);
        expect(nativeInput).not.toHaveBeenCalled();
        host.dispatchEvent(new Event("compositionend"));
        expect(nativeEnd).toHaveBeenCalledOnce();
        input("한글", "insertText");
        input("한글", "insertFromComposition");
        expect(nativeInput).not.toHaveBeenCalled();
        vi.runAllTimers();
        input("x", "insertText");
        expect(nativeInput).toHaveBeenCalledOnce();
        dispose();
    });

    it("빠르게 이어지는 조합과 취소에서도 중간 글자를 보내지 않으며 해제 시 listener를 제거한다", () => {
        vi.useFakeTimers();
        const { host, dispose, nativeInput, input } = setup();
        host.dispatchEvent(new Event("compositionstart"));
        host.dispatchEvent(new Event("compositionend"));
        host.dispatchEvent(new Event("compositionstart"));
        vi.runAllTimers();
        input("ㄱ", "insertText");
        expect(nativeInput).not.toHaveBeenCalled();
        host.dispatchEvent(new Event("compositionend"));
        dispose();
        vi.runAllTimers();
        input("x", "insertText");
        expect(nativeInput).toHaveBeenCalledOnce();
    });
});
