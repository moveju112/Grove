import { useEffect, useRef } from "react";
import { macShortcuts, shortcutFor, type KeyboardShortcuts, type ShortcutAction } from "../../state/shortcuts";

const APP_WINDOW = "(display-mode: standalone), (display-mode: window-controls-overlay)";

/// 작업 공간 단축키는 설치된 앱 창에서만 동작한다.
export function shortcutWindow(): boolean {
    return window.matchMedia(APP_WINDOW).matches || !!(navigator as Navigator & { standalone?: boolean }).standalone;
}

export function useWorkspaceShortcuts(settings: KeyboardShortcuts, run: (action: ShortcutAction) => void) {
    const current = useRef({ settings, run });
    current.current = { settings, run };
    useEffect(() => {
        const mac = macShortcuts();
        const key = (event: KeyboardEvent) => {
            // 일반 브라우저의 탭·창 단축키는 그대로 둔다. 설치된 앱 창에서만 가로챈다.
            if (!shortcutWindow() || event.defaultPrevented) return;
            if (document.querySelector("dialog[open]") || [...document.querySelectorAll<HTMLElement>('[role="dialog"][aria-modal="true"]:not(dialog)')]
                .some((dialog) => dialog.getClientRects().length > 0)) return;
            const action = shortcutFor(event, current.current.settings, mac);
            if (!action) return;
            // 탭 명령은 터미널에서도 동일하게 동작하되, 나머지 터미널 조합키는 빼앗지 않는다.
            if (event.target instanceof Element && event.target.closest(".xterm") && (action === "settings" || action === "toggleSidebar")) return;
            event.preventDefault();
            event.stopPropagation();
            if (!event.repeat) current.current.run(action);
        };
        window.addEventListener("keydown", key, true);
        return () => window.removeEventListener("keydown", key, true);
    }, []);
}
