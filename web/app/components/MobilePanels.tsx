import { Stack, StackItem } from "@astryxdesign/core/Stack";
import { Drawer } from "@astryxdesign/core/Drawer";
import { Divider } from "@astryxdesign/core/Divider";
import { mobilePanelStyles } from "./mobile-panels.stylex";
import { Text as GroveText } from "@astryxdesign/core/Text";
import { Button as GroveButton } from "../design/Button";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";

export type MobilePanel = "left" | "right";
type Drag = { side: MobilePanel; progress: number };
const PANEL_SWIPE_SURFACE = '[data-ui="workspace-header"], [data-testid="session-view"] [data-ui="workbench-main"], [data-testid="project-view"] [data-ui="workbench-main"]';
const SWIPE_SLOP = 8;

// 표 안에 그 방향으로 더 읽을 내용이 있으면 터치를 브라우저에 맡긴다.
function canScrollTable(node: Element, dx: number) {
    const range = node.scrollWidth - node.clientWidth;
    const rtl = getComputedStyle(node).direction === "rtl";
    const left = node.scrollLeft + (rtl ? range : 0);
    return dx > 0 ? left > 1 : left < range - 1;
}

// 상단 바·채팅 본문에서는 양방향, 그 외에는 가장자리에서 연다. 세로 스크롤·편집·텍스트 선택은 보존한다.
export function useMobilePanels(enabled: boolean) {
    const [panel, setPanel] = useState<MobilePanel | null>(null);
    const [drag, setDrag] = useState<Drag | null>(null);
    const current = useRef(panel);
    useLayoutEffect(() => { current.current = panel; }, [panel]);
    useEffect(() => {
        if (!enabled) { setPanel(null); setDrag(null); return; }
        type Gesture = { x: number; y: number; at: number; origin: MobilePanel | null; fromSurface: boolean; tableScrollers: Element[]; side?: MobilePanel; progress: number };
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
            if (document.querySelector('dialog:modal:not([data-mobile-drawer]), [popover]:popover-open')) return;
            const target = event.target as Element;
            if (document.getSelection()?.isCollapsed === false) return;
            if (target.closest("input, textarea, select, [contenteditable=true], .xterm, [data-testid=md-code], [data-swipe-blocked]")) return;
            const table = target.closest('[data-testid="md-table"]');
            const tableScrollers: Element[] = [];
            for (let node: Element | null = target; node && node !== document.body; node = node.parentElement) {
                if (node.scrollWidth <= node.clientWidth + 1 || !["auto", "scroll"].includes(getComputedStyle(node).overflowX)) continue;
                if (!table?.contains(node)) return;
                tableScrollers.push(node);
            }
            const touch = event.touches[0]!;
            const fromSurface = !!target.closest(PANEL_SWIPE_SURFACE);
            if (!current.current && !fromSurface && touch.clientX > 32 && touch.clientX < innerWidth - 32) return;
            gesture = { x: touch.clientX, y: touch.clientY, at: performance.now(), origin: current.current, fromSurface, tableScrollers, progress: current.current ? 1 : 0 };
        };
        const move = (event: TouchEvent) => {
            if (!gesture) return;
            if (event.touches.length !== 1) { cancel(); return; }
            const touch = event.touches[0]!;
            const dx = touch.clientX - gesture.x, dy = touch.clientY - gesture.y;
            if (!gesture.side) {
                if (document.getSelection()?.isCollapsed === false || performance.now() - gesture.at > 500) { gesture = null; return; }
                if (Math.abs(dy) > SWIPE_SLOP && Math.abs(dy) >= Math.abs(dx)) { gesture = null; return; }
                if (Math.abs(dx) < SWIPE_SLOP || Math.abs(dx) < Math.abs(dy) * 1.4) return;
                if (!event.cancelable || gesture.tableScrollers.some((node) => canScrollTable(node, dx))) { gesture = null; return; }
                const side = gesture.origin ?? (dx > 0 ? "left" : "right");
                if (!gesture.origin && !gesture.fromSurface && ((side === "left" && gesture.x > 32) || (side === "right" && gesture.x < innerWidth - 32))) {
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

export function MobileDrawer({ enabled, side, open, drag, label, headerActions, children, onClose }: {
    enabled: boolean; side: MobilePanel; open: boolean; drag: Drag | null;
    label: string; headerActions?: ReactNode; children: ReactNode; onClose: () => void;
}) {
    const [visited, setVisited] = useState(false);
    const progress = drag?.side === side ? drag.progress : open ? 1 : 0;
    useLayoutEffect(() => {
        if (enabled && open) setVisited(true);
    }, [enabled, open]);
    if (!enabled) return children;
    return <Drawer label={label} isOpen={open} side={side === "left" ? "start" : "end"}
        width="min(88vw, 320px)" padding={0} data-mobile-drawer="true" data-testid={`mobile-drawer-${side}`}
        xstyle={drag?.side === side && mobilePanelStyles.dragging((side === "left" ? progress - 1 : 1 - progress) * 100, progress)}
        onOpenChange={(opened) => { if (!opened) onClose(); }}>
        <Stack gap={0} height="100%">
        <Stack direction="horizontal" align="center" justify="between" gap={2} paddingInline={3} paddingBlock={1} minHeight={40} data-testid="mobile-drawer-header"><GroveText type="label">{label}</GroveText>
            <Stack direction="horizontal" align="center" gap={0}>
                {headerActions}
                <GroveButton type="button" variant="secondary" appearance="icon" aria-label={`${label} 닫기`} onClick={onClose}>×</GroveButton>
            </Stack>
        </Stack>
        <Divider />
        <StackItem size="fill" isScrollable aria-label={label}>{(visited || open) && children}</StackItem>
        </Stack>
    </Drawer>;
}
