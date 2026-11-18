import { describe, expect, it } from "vitest";
import * as L from "./layout";
import {
    DEFAULT_SHORTCUTS, SHORTCUT_ACTIONS, applyTabShortcut, conflictingShortcut, formatShortcut,
    normalizeShortcuts, parseShortcut, physicalBinding, shortcutBinding, shortcutFor,
} from "./shortcuts";

function key(code: string, modifiers: Partial<KeyboardEvent> = {}) {
    return { key: code.startsWith("Key") ? code.slice(3).toLowerCase() : code, code,
        ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, isComposing: false, ...modifiers };
}
function layout() {
    let value = L.emptyLayout();
    for (const id of ["one", "two", "three"])
        value = L.openTab(value, value.focused_leaf, { id, kind: "session", project_id: "project", resource_id: id, title: id });
    return value;
}

describe("키보드 프리셋과 사용자 지정", () => {
    it("기본 프리셋은 Windows/Linux에서 Ctrl, Mac에서 Cmd를 쓴다", () => {
        expect(shortcutFor(key("KeyW", { ctrlKey: true }), DEFAULT_SHORTCUTS, false)).toBe("closeTab");
        expect(shortcutFor(key("KeyT", { metaKey: true }), DEFAULT_SHORTCUTS, true)).toBe("newSession");
        expect(shortcutFor(key("KeyT", { ctrlKey: true }), DEFAULT_SHORTCUTS, true)).toBeNull();
        expect(shortcutFor(key("Tab", { ctrlKey: true, shiftKey: true }), DEFAULT_SHORTCUTS, true)).toBe("previousTab");
        expect(shortcutFor(key("KeyW", { ctrlKey: true, shiftKey: true }), DEFAULT_SHORTCUTS, false)).toBeNull();
    });
    it("IME 조합·dead key는 실행하지 않고 키 위치를 사용한다", () => {
        expect(shortcutFor(key("KeyT", { ctrlKey: true, key: "ㅅ" }), DEFAULT_SHORTCUTS, false)).toBe("newSession");
        expect(shortcutFor(key("KeyT", { ctrlKey: true, isComposing: true }), DEFAULT_SHORTCUTS, false)).toBeNull();
        expect(shortcutFor(key("KeyT", { ctrlKey: true, key: "Dead" }), DEFAULT_SHORTCUTS, false)).toBeNull();
    });
    it("Ctrl+Shift+T는 새 터미널이며 새 대화 조합과 구분한다", () => {
        for (const mac of [false, true]) {
            expect(shortcutFor(key("KeyT", { ctrlKey: true, shiftKey: true }), DEFAULT_SHORTCUTS, mac)).toBe("newTerminal");
            expect(shortcutFor(key("KeyT", { ctrlKey: true, shiftKey: true, isComposing: true }), DEFAULT_SHORTCUTS, mac)).toBeNull();
        }
        expect(conflictingShortcut(DEFAULT_SHORTCUTS, "newSession", "Ctrl+Shift+KeyT", false)).toBe("newTerminal");
        expect(shortcutFor(key("KeyT", { ctrlKey: true, shiftKey: true }),
            normalizeShortcuts({ preset: "custom", bindings: { newTerminal: null } }), false)).toBeNull();
    });
    it("수정·개별 해제·전체 해제를 구분하며 기본 복원은 overrides를 무시한다", () => {
        const settings = normalizeShortcuts({ preset: "custom", bindings: { newSession: "Ctrl+Shift+KeyK", closeTab: null } });
        expect(shortcutFor(key("KeyK", { ctrlKey: true, shiftKey: true }), settings, false)).toBe("newSession");
        expect(shortcutFor(key("KeyT", { ctrlKey: true }), settings, false)).toBeNull();
        expect(shortcutFor(key("KeyW", { ctrlKey: true }), settings, false)).toBeNull();
        expect(shortcutFor(key("KeyK", { ctrlKey: true, shiftKey: true }), { ...settings, preset: "off" }, false)).toBeNull();
        expect(shortcutBinding({ ...settings, preset: "default" }, "closeTab")).toBe("Mod+KeyW");
    });
    it("문자·기호·기능키를 정규화하고 잘못된 입력을 저장하지 않는다", () => {
        expect(parseShortcut(" control + shift + k ")).toBe("Ctrl+Shift+KeyK");
        expect(parseShortcut("Cmd+,")).toBe("Meta+Comma");
        expect(parseShortcut("Alt+PageDown")).toBe("Alt+PageDown");
        expect(parseShortcut("F10")).toBe("F10");
        expect(parseShortcut(" ")).toBeNull();
        for (const value of ["K", "Shift+K", "Ctrl", "Ctrl+What", "Ctrl+constructor", "Ctrl+toString"])
            expect(parseShortcut(value)).toBeUndefined();
        expect(normalizeShortcuts(null)).toEqual(DEFAULT_SHORTCUTS);
        expect(normalizeShortcuts({ preset: "custom", bindings: { newSession: "KeyT", closeTab: 42, tab1: "Ctrl+Digit1" } }))
            .toEqual({ preset: "custom", bindings: { tab1: "Ctrl+Digit1" } });
    });
    it("모든 기본값은 화면 표시와 재입력 후에도 동일하고, 플랫폼별 중복을 잡는다", () => {
        for (const mac of [false, true]) for (const { binding } of SHORTCUT_ACTIONS) {
            expect(parseShortcut(formatShortcut(binding, mac))).toBe(physicalBinding(binding, mac));
        }
        expect(conflictingShortcut(DEFAULT_SHORTCUTS, "newSession", "Ctrl+KeyW", false)).toBe("closeTab");
        expect(conflictingShortcut(DEFAULT_SHORTCUTS, "newSession", "Meta+KeyW", true)).toBe("closeTab");
        expect(conflictingShortcut(DEFAULT_SHORTCUTS, "newSession", "Ctrl+KeyW", true)).toBeNull();
        expect(conflictingShortcut(DEFAULT_SHORTCUTS, "newSession", "Ctrl+KeyT", false)).toBeNull();
    });
});

describe("현재 pane에만 적용되는 탭 명령", () => {
    it("다음·이전은 순환하고 숫자·마지막은 현재 pane의 탭을 고른다", () => {
        const value = layout();
        expect(L.focusedLeaf(applyTabShortcut(value, "nextTab")).active_tab).toBe("one");
        expect(L.focusedLeaf(applyTabShortcut(L.activate(value, "one"), "previousTab")).active_tab).toBe("three");
        expect(L.focusedLeaf(applyTabShortcut(value, "tab2")).active_tab).toBe("two");
        expect(L.focusedLeaf(applyTabShortcut(L.activate(value, "one"), "lastTab")).active_tab).toBe("three");
        expect(applyTabShortcut(value, "tab8")).toBe(value);
    });
    it("새 세션은 매번 독립된 초안 탭이며 세션 자원을 만들지 않는다", () => {
        const value = layout();
        const first = applyTabShortcut(value, "newSession");
        const second = applyTabShortcut(first, "newSession");
        expect(L.allTabs(first)).toHaveLength(4);
        expect(L.allTabs(second)).toHaveLength(5);
        const leaf = L.focusedLeaf(second);
        expect(leaf.tabs.at(-1)).toMatchObject({ kind: "project", project_id: "project", title: "새 대화" });
        expect(leaf.tabs.at(-1)?.resource_id).toBeUndefined();
        expect(leaf.tabs.at(-1)?.id).not.toBe(leaf.tabs.at(-2)?.id);
        const empty = L.emptyLayout();
        expect(applyTabShortcut(empty, "newSession")).toBe(empty);
        expect(L.allTabs(applyTabShortcut(empty, "newSession", "fallback"))[0]?.project_id).toBe("fallback");
    });
    it("닫기와 새 탭은 포커스된 pane만 바꾸고 다른 pane은 보존한다", () => {
        const source = layout();
        const split = L.splitLeaf(source, source.focused_leaf, "row", { kind: "session", project_id: "other", resource_id: "other", title: "other" });
        const before = L.findLeaf(split, source.focused_leaf);
        const opened = applyTabShortcut(split, "newSession");
        expect(L.focusedLeaf(opened).tabs.at(-1)?.project_id).toBe("other");
        expect(L.findLeaf(opened, source.focused_leaf)).toEqual(before);
        const closed = applyTabShortcut(split, "closeTab");
        expect(L.allTabs(closed).map((tab) => tab.resource_id)).toEqual(["one", "two", "three"]);
        expect(L.leaves(closed.root)).toHaveLength(1);
    });
    it("빈 탭 닫기와 탭 한도에서는 변화가 없다", () => {
        const empty = L.emptyLayout();
        expect(applyTabShortcut(empty, "closeTab")).toBe(empty);
        let full = empty;
        for (let i = 0; i < L.MAX_TABS; i++)
            full = L.openTab(full, full.focused_leaf, { kind: "project", project_id: "project", title: "초안" });
        expect(applyTabShortcut(full, "newSession")).toBe(full);
    });
});
