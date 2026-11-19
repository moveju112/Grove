import * as L from "./layout";

export const SHORTCUT_ACTIONS = [
    { id: "newSession", label: "새 세션 탭", binding: "Mod+KeyT" },
    { id: "newTerminal", label: "새 터미널 탭", binding: "Ctrl+Shift+KeyT" },
    { id: "closeTab", label: "현재 탭 닫기", binding: "Mod+KeyW" },
    { id: "nextTab", label: "다음 탭", binding: "Ctrl+Tab" },
    { id: "previousTab", label: "이전 탭", binding: "Ctrl+Shift+Tab" },
    { id: "settings", label: "설정 열기", binding: "Mod+Comma" },
    { id: "toggleSidebar", label: "사이드바 전환", binding: "Mod+KeyB" },
    { id: "tab1", label: "첫 번째 탭", binding: "Mod+Digit1" },
    { id: "tab2", label: "두 번째 탭", binding: "Mod+Digit2" },
    { id: "tab3", label: "세 번째 탭", binding: "Mod+Digit3" },
    { id: "tab4", label: "네 번째 탭", binding: "Mod+Digit4" },
    { id: "tab5", label: "다섯 번째 탭", binding: "Mod+Digit5" },
    { id: "tab6", label: "여섯 번째 탭", binding: "Mod+Digit6" },
    { id: "tab7", label: "일곱 번째 탭", binding: "Mod+Digit7" },
    { id: "tab8", label: "여덟 번째 탭", binding: "Mod+Digit8" },
    { id: "lastTab", label: "마지막 탭", binding: "Mod+Digit9" },
] as const;
export type ShortcutAction = typeof SHORTCUT_ACTIONS[number]["id"];
export type KeyboardShortcuts = {
    preset: "default" | "custom" | "off";
    bindings: Partial<Record<ShortcutAction, string | null>>;
};
export const DEFAULT_SHORTCUTS: KeyboardShortcuts = { preset: "default", bindings: {} };
const MODIFIERS = ["Mod", "Ctrl", "Alt", "Shift", "Meta"] as const;
const KEY_NAMES: Record<string, string> = {
    Comma: ",", Period: ".", Slash: "/", Semicolon: ";", Quote: "'", Minus: "-", Equal: "=",
    BracketLeft: "[", BracketRight: "]", Backslash: "\\", Space: "Space", Tab: "Tab", Enter: "Enter",
    Backspace: "Backspace", Delete: "Delete", Home: "Home", End: "End", PageUp: "PageUp", PageDown: "PageDown",
    ArrowLeft: "←", ArrowRight: "→", ArrowUp: "↑", ArrowDown: "↓",
};

function keyCode(value: string): string | undefined {
    if (/^[a-z]$/i.test(value)) return `Key${value.toUpperCase()}`;
    if (/^[0-9]$/.test(value)) return `Digit${value}`;
    if (/^F(?:[1-9]|1[0-2])$/i.test(value)) return value.toUpperCase();
    return Object.keys(KEY_NAMES).find((code) => code.toLowerCase() === value.toLowerCase() || KEY_NAMES[code]!.toLowerCase() === value.toLowerCase());
}

function parts(binding: string): { modifiers: string[]; code: string } | undefined {
    const tokens = binding.split("+");
    const code = tokens.pop()!;
    if (!/^Key[A-Z]$|^Digit[0-9]$|^F(?:[1-9]|1[0-2])$/.test(code) && !Object.hasOwn(KEY_NAMES, code)) return;
    if (!tokens.every((token) => MODIFIERS.includes(token as typeof MODIFIERS[number]))) return;
    const modifiers = MODIFIERS.filter((token) => tokens.includes(token));
    if (!modifiers.some((token) => token !== "Shift") && !/^F\d+$/.test(code)) return;
    return { modifiers, code };
}

export function normalizeShortcuts(value: unknown): KeyboardShortcuts {
    if (!value || typeof value !== "object" || Array.isArray(value)) return { ...DEFAULT_SHORTCUTS, bindings: {} };
    const input = value as { preset?: unknown; bindings?: unknown };
    const preset = input.preset === "custom" || input.preset === "off" ? input.preset : "default";
    const bindings: KeyboardShortcuts["bindings"] = {};
    if (input.bindings && typeof input.bindings === "object" && !Array.isArray(input.bindings)) {
        const saved = input.bindings as Record<string, unknown>;
        for (const { id } of SHORTCUT_ACTIONS) {
            const binding = saved[id];
            if (binding === null) bindings[id] = null;
            else if (typeof binding === "string") {
                const parsed = parts(binding);
                if (parsed) bindings[id] = [...parsed.modifiers, parsed.code].join("+");
            }
        }
    }
    return { preset, bindings };
}

export function shortcutBinding(settings: KeyboardShortcuts, action: ShortcutAction): string | null {
    if (settings.preset === "off") return null;
    if (settings.preset === "custom" && action in settings.bindings) return settings.bindings[action] ?? null;
    return SHORTCUT_ACTIONS.find((item) => item.id === action)!.binding;
}

export function physicalBinding(binding: string, mac: boolean): string {
    const parsed = parts(binding)!;
    const modifiers = new Set(parsed.modifiers.map((modifier) => modifier === "Mod" ? mac ? "Meta" : "Ctrl" : modifier));
    return [...["Ctrl", "Alt", "Shift", "Meta"].filter((modifier) => modifiers.has(modifier)), parsed.code].join("+");
}

export function formatShortcut(binding: string | null, mac: boolean): string {
    if (!binding) return "";
    const parsed = parts(physicalBinding(binding, mac))!;
    const key = /^Key[A-Z]$/.test(parsed.code) ? parsed.code.slice(3)
        : /^Digit[0-9]$/.test(parsed.code) ? parsed.code.slice(5) : KEY_NAMES[parsed.code] ?? parsed.code;
    return [...parsed.modifiers.map((modifier) => modifier === "Meta" ? "Cmd" : modifier), key].join("+");
}

/// Astryx `Kbd`의 keys 형식(소문자, `+` 구분)으로 바꾼다. Cmd는 Kbd의 meta 키다.
export function kbdKeys(binding: string | null, mac: boolean): string {
    return formatShortcut(binding, mac).split("+").map((key) => key === "Cmd" ? "meta" : key.toLowerCase()).join("+");
}

// 빈칸은 해제, undefined는 잘못된 조합이다. 표시용 입력을 저장 형식으로 정규화한다.
export function parseShortcut(text: string): string | null | undefined {
    if (!text.trim()) return null;
    const tokens = text.trim().split(/\s*\+\s*/);
    const code = keyCode(tokens.pop()!);
    if (!code) return undefined;
    const aliases: Record<string, string> = { ctrl: "Ctrl", control: "Ctrl", alt: "Alt", shift: "Shift", cmd: "Meta", command: "Meta", meta: "Meta", "⌘": "Meta", mod: "Mod" };
    const modifiers = tokens.map((token) => aliases[token.toLowerCase()]);
    if (modifiers.some((token) => !token)) return undefined;
    const binding = [...MODIFIERS.filter((token) => modifiers.includes(token)), code].join("+");
    return parts(binding) ? binding : undefined;
}

type ShortcutKey = Pick<KeyboardEvent, "key" | "code" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey" | "isComposing">;
export function shortcutFor(event: ShortcutKey, settings: KeyboardShortcuts, mac: boolean): ShortcutAction | null {
    if (event.isComposing || event.key === "Dead" || settings.preset === "off") return null;
    const code = event.code || keyCode(event.key);
    const pressed = [
        ...[event.ctrlKey && "Ctrl", event.altKey && "Alt", event.shiftKey && "Shift", event.metaKey && "Meta"].filter(Boolean), code,
    ].join("+");
    return SHORTCUT_ACTIONS.find(({ id }) => {
        const binding = shortcutBinding(settings, id);
        return binding !== null && physicalBinding(binding, mac) === pressed;
    })?.id ?? null;
}

export function conflictingShortcut(settings: KeyboardShortcuts, action: ShortcutAction, binding: string, mac: boolean): ShortcutAction | null {
    const candidate = physicalBinding(binding, mac);
    return SHORTCUT_ACTIONS.find(({ id }) => id !== action && (() => {
        const other = shortcutBinding({ ...settings, preset: "custom" }, id);
        return other !== null && physicalBinding(other, mac) === candidate;
    })())?.id ?? null;
}

export function applyTabShortcut(layout: L.Layout, action: ShortcutAction, projectId?: string): L.Layout {
    const leaf = L.focusedLeaf(layout);
    const active = leaf.tabs.find((tab) => tab.id === leaf.active_tab);
    if (action === "newSession") {
        const project = active?.project_id ?? projectId;
        return project ? L.openTab(layout, leaf.id, { kind: "project", project_id: project, title: "새 대화" }) : layout;
    }
    if (action === "closeTab") return active ? L.closeTab(layout, active.id) : layout;
    if (!leaf.tabs.length) return layout;
    const index = leaf.tabs.findIndex((tab) => tab.id === leaf.active_tab);
    const target = action === "nextTab" ? (index + 1) % leaf.tabs.length
        : action === "previousTab" ? (index - 1 + leaf.tabs.length) % leaf.tabs.length
        : action === "lastTab" ? leaf.tabs.length - 1
        : /^tab[1-8]$/.test(action) ? Number(action.slice(3)) - 1 : -1;
    return leaf.tabs[target] ? L.activate(layout, leaf.tabs[target]!.id) : layout;
}

export function macShortcuts(): boolean {
    return /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent);
}
