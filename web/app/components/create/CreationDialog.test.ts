import { describe, expect, it, vi } from "vitest";
import { containCreationTab } from "./CreationDialog";

type ControlOptions = { tabIndex: number; disabled: boolean; hidden: boolean; rendered: boolean; visibility: string };

function fixture(options: Partial<ControlOptions>[] = [{}, {}, {}]) {
    const controls = options.map((option) => {
        const state = { tabIndex: 0, disabled: false, hidden: false, rendered: true, visibility: "visible", ...option };
        return {
            tabIndex: state.tabIndex, focus: vi.fn(),
            matches: () => state.disabled, closest: () => state.hidden ? {} : null,
            getClientRects: () => state.rendered ? [{}] : [], visibility: state.visibility,
        };
    });
    const document = {
        activeElement: controls[0] as unknown,
        defaultView: { getComputedStyle: (node: typeof controls[number]) => ({ visibility: node.visibility }) },
    };
    const dialog = { querySelectorAll: () => controls, ownerDocument: document, focus: vi.fn() };
    const event = { key: "Tab", shiftKey: false, altKey: false, ctrlKey: false, metaKey: false, defaultPrevented: false, preventDefault: vi.fn() };
    const run = () => containCreationTab(dialog as unknown as HTMLDialogElement, event as unknown as KeyboardEvent);
    return { controls, document, dialog, event, run };
}

describe("생성 modal의 Tab 경계", () => {
    it("마지막 조작 요소에서 Tab은 첫 요소로 순환한다", () => {
        const f = fixture();
        f.document.activeElement = f.controls.at(-1);
        f.run();
        expect(f.event.preventDefault).toHaveBeenCalledOnce();
        expect(f.controls[0]!.focus).toHaveBeenCalledOnce();
    });
    it("첫 조작 요소에서 Shift+Tab은 마지막 요소로 순환한다", () => {
        const f = fixture();
        f.event.shiftKey = true;
        f.run();
        expect(f.event.preventDefault).toHaveBeenCalledOnce();
        expect(f.controls.at(-1)!.focus).toHaveBeenCalledOnce();
    });
    it.each([false, true])("내부 이동은 브라우저의 기본 순서를 유지한다(역방향 %s)", (shift) => {
        const f = fixture();
        f.document.activeElement = f.controls[1];
        f.event.shiftKey = shift;
        f.run();
        expect(f.event.preventDefault).not.toHaveBeenCalled();
        expect(f.controls.every((control) => control.focus.mock.calls.length === 0)).toBe(true);
    });
    it("비활성·음수 tabindex·hidden/inert·닫힌 details·visibility:hidden은 경계에서 제외한다", () => {
        const f = fixture([{ disabled: true }, { tabIndex: -1 }, { hidden: true }, { rendered: false }, { visibility: "hidden" }, {}]);
        f.document.activeElement = f.controls.at(-1);
        f.run();
        expect(f.controls.at(-1)!.focus).toHaveBeenCalledOnce();
        expect(f.controls.slice(0, -1).every((control) => control.focus.mock.calls.length === 0)).toBe(true);
    });
    it("양수 tabindex는 기본 tabindex보다 먼저 이동한다", () => {
        const f = fixture([{ tabIndex: 0 }, { tabIndex: 2 }, { tabIndex: 1 }]);
        f.document.activeElement = f.controls[0];
        f.run();
        expect(f.controls[2]!.focus).toHaveBeenCalledOnce();
    });
    it.each([false, true])("활성 요소가 제거된 뒤에도 dialog 안으로 회수한다(역방향 %s)", (shift) => {
        const f = fixture();
        f.document.activeElement = {};
        f.event.shiftKey = shift;
        f.run();
        expect(f.event.preventDefault).toHaveBeenCalledOnce();
        expect(f.controls[shift ? 2 : 0]!.focus).toHaveBeenCalledOnce();
    });
    it("모든 조작 요소가 비활성화됐으면 dialog 자체에 초점을 유지한다", () => {
        const f = fixture([{ disabled: true }]);
        f.run();
        expect(f.event.preventDefault).toHaveBeenCalledOnce();
        expect(f.dialog.focus).toHaveBeenCalledOnce();
    });
    it.each(["Escape", "Enter", "ArrowRight"])("%s 기본 처리는 가로채지 않는다", (key) => {
        const f = fixture();
        f.event.key = key;
        f.run();
        expect(f.event.preventDefault).not.toHaveBeenCalled();
    });
    it.each(["altKey", "ctrlKey", "metaKey", "defaultPrevented"] as const)("%s 처리된 Tab은 가로채지 않는다", (key) => {
        const f = fixture();
        f.event[key] = true;
        f.run();
        expect(f.event.preventDefault).not.toHaveBeenCalled();
    });
});
