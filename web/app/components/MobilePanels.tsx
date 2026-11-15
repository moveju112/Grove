import { Text as GroveText } from "@astryxdesign/core/Text";
import { Button as GroveButton } from "../design/Button";
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";

export type MobilePanel = "left" | "right";
type Drag = { side: MobilePanel; progress: number };

// 채팅 본문에서는 양방향, 다른 화면에서는 가장자리에서 연다. 세로 스크롤·편집·텍스트 선택은 보존한다.
export function useMobilePanels(enabled: boolean) {
    const [panel, setPanel] = useState<MobilePanel | null>(null);
    const [drag, setDrag] = useState<Drag | null>(null);
    const current = useRef(panel);
    useLayoutEffect(() => { current.current = panel; }, [panel]);
    useEffect(() => {
        if (!enabled) { setPanel(null); setDrag(null); return; }
        type Gesture = { x: number; y: number; at: number; origin: MobilePanel | null; chat: boolean; side?: MobilePanel; progress: number };
        let gesture: Gesture | null = null;
        let frame = 0;
        const cancel = () => {
            if (gesture?.side) setPanel(gesture.origin);
            gesture = null;
            cancelAnimationFrame(frame);
            setDrag(null);
        };
        const start = (event: TouchEvent) => {
            if (event.touches.length !== 1) { cancel(); return; }
            gesture = null;
            if (document.querySelector('dialog:modal:not(.mobile-drawer), [popover]:popover-open')) return;
            const target = event.target as Element;
            if (document.getSelection()?.isCollapsed === false) return;
            if (target.closest("input, textarea, select, [contenteditable=true], .xterm, .md-code, .md-table, [data-swipe-blocked]")) return;
            if (!current.current && target.closest("button, a[href], summary")) return;
            for (let node: Element | null = target; node && node !== document.body; node = node.parentElement) {
                if (node.scrollWidth > node.clientWidth + 1 && ["auto", "scroll"].includes(getComputedStyle(node).overflowX)) return;
            }
            const touch = event.touches[0]!;
            const chat = !!target.closest(".session-view .workbench-main, .project-view .workbench-main");
            if (!current.current && !chat && touch.clientX > 32 && touch.clientX < innerWidth - 32) return;
            gesture = { x: touch.clientX, y: touch.clientY, at: performance.now(), origin: current.current, chat, progress: current.current ? 1 : 0 };
        };
        const move = (event: TouchEvent) => {
            if (!gesture) return;
            if (event.touches.length !== 1) { cancel(); return; }
            const touch = event.touches[0]!;
            const dx = touch.clientX - gesture.x, dy = touch.clientY - gesture.y;
            if (!gesture.side) {
                if (document.getSelection()?.isCollapsed === false || performance.now() - gesture.at > 500) { gesture = null; return; }
                if (Math.abs(dy) > 10 && Math.abs(dy) >= Math.abs(dx)) { gesture = null; return; }
                if (Math.abs(dx) < 10 || Math.abs(dx) < Math.abs(dy) * 1.4) return;
                const side = gesture.origin ?? (dx > 0 ? "left" : "right");
                if (!gesture.origin && !gesture.chat && ((side === "left" && gesture.x > 32) || (side === "right" && gesture.x < innerWidth - 32))) {
                    gesture = null; return;
                }
                gesture.side = side;
                setPanel(side);
            }
            if (event.cancelable) event.preventDefault();
            const direction = gesture.side === "left" ? 1 : -1;
            const width = Math.min(320, innerWidth * 0.88);
            gesture.progress = Math.max(0, Math.min(1, (gesture.origin ? 1 : 0) + dx * direction / width));
            const next = { side: gesture.side, progress: gesture.progress };
            cancelAnimationFrame(frame);
            frame = requestAnimationFrame(() => setDrag(next));
        };
        const end = (event: TouchEvent) => {
            if (!gesture?.side) { gesture = null; return; }
            const dx = event.changedTouches[0]!.clientX - gesture.x;
            const velocity = dx * (gesture.side === "left" ? 1 : -1) / Math.max(1, performance.now() - gesture.at);
            const opened = velocity > 0.5 || (velocity >= -0.5 && gesture.progress > (gesture.origin ? 2 / 3 : 1 / 3));
            setPanel(opened ? gesture.side : null);
            gesture = null;
            cancelAnimationFrame(frame);
            setDrag(null);
        };
        document.addEventListener("touchstart", start, { passive: true, capture: true });
        document.addEventListener("touchmove", move, { passive: false, capture: true });
        document.addEventListener("touchend", end, true);
        document.addEventListener("touchcancel", cancel, true);
        return () => {
            cancelAnimationFrame(frame);
            document.removeEventListener("touchstart", start, true);
            document.removeEventListener("touchmove", move, true);
            document.removeEventListener("touchend", end, true);
            document.removeEventListener("touchcancel", cancel, true);
        };
    }, [enabled]);
    return { panel, setPanel, drag };
}

export function MobileDrawer({ enabled, side, open, drag, label, children, onClose }: {
    enabled: boolean; side: MobilePanel; open: boolean; drag: Drag | null;
    label: string; children: ReactNode; onClose: () => void;
}) {
    const dialog = useRef<HTMLDialogElement>(null);
    const [visited, setVisited] = useState(false);
    const progress = drag?.side === side ? drag.progress : open ? 1 : 0;
    useLayoutEffect(() => {
        const node = dialog.current;
        if (!enabled || !node) return;
        if (open) {
            setVisited(true);
            if (!node.open) { node.showModal(); node.focus({ preventScroll: true }); }
            return;
        }
        // modal 잠금은 즉시 해제한다. 시각적 퇴장은 CSS의 display·overlay 전환이 담당한다.
        node.close();
    }, [enabled, open]);
    if (!enabled) return children;
    return <dialog ref={dialog} tabIndex={-1} className={`mobile-drawer mobile-drawer-${side}`} aria-label={label}
        aria-hidden={!open || undefined} inert={!open}
        data-open={open} data-dragging={drag?.side === side || undefined}
        style={{ "--drawer-progress": progress } as CSSProperties}
        onCancel={(event) => { event.preventDefault(); onClose(); }}
        onClick={(event) => {
            if (event.target !== dialog.current) return;
            const bounds = event.currentTarget.getBoundingClientRect();
            if (event.clientX < bounds.left || event.clientX > bounds.right) onClose();
        }}>
        <div className="mobile-drawer-heading"><GroveText type="inherit" color="inherit">{label}</GroveText>
            <GroveButton type="button" className="ghost icon-btn" aria-label={`${label} 닫기`} onClick={onClose}>×</GroveButton>
        </div>
        <div className="mobile-drawer-body">{(visited || open) && children}</div>
    </dialog>;
}
