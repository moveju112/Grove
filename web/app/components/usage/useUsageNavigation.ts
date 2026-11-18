import { useCallback, useEffect, useRef, useState } from "react";

/** 사용량은 명시적으로 연 모달에서만 표시하고, 닫아도 기간·필터는 유지한다. */
export function useUsageNavigation() {
    const [usageOpen, setOpen] = useState(false);
    const [usageVisited, setVisited] = useState(false);
    const returnFocus = useRef<HTMLElement | null>(null);
    useEffect(() => {
        // 모바일에서는 모달을 연 탐색 서랍이 이미 닫혔으므로 보이는 버튼으로 돌아간다.
        const restore = (event: Event) => {
            if (!(event.target instanceof HTMLDialogElement) || event.target.getAttribute("aria-label") !== "사용량"
                || document.querySelector("dialog:modal")) return;
            const target = returnFocus.current;
            const visible = target?.isConnected && target.getClientRects().length && !target.closest("[hidden], [inert]");
            (visible ? target : document.querySelector<HTMLButtonElement>('[data-testid="workspace"] button[aria-label="사이드바"]'))?.focus({ preventScroll: true });
        };
        document.addEventListener("close", restore, true);
        return () => document.removeEventListener("close", restore, true);
    }, []);
    const openUsage = useCallback(() => {
        returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        setVisited(true);
        setOpen(true);
    }, []);
    const closeUsage = useCallback(() => setOpen(false), []);
    return { usageOpen, usageVisited, openUsage, closeUsage, leaveUsage: closeUsage };
}
