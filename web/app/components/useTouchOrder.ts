import { useEffect, useLayoutEffect, useRef, useState } from "react";

type Gesture = {
    id: string; finger: number; row: HTMLElement; viewport: HTMLElement;
    startX: number; startY: number; scrollTop: number; x: number; y: number;
    active: boolean;
};

type Options<T> = {
    enabled: boolean; selector: string;
    idFor: (row: HTMLElement) => string;
    viewportFor: (row: HTMLElement) => HTMLElement | null;
    targetAt: (gesture: Gesture) => T | null;
    onDrop: (source: string, target: T) => void;
};

// 길게 누르기 전에는 브라우저가 탭과 스크롤을 처리한다.
export function useTouchOrder<T>(options: Options<T>) {
    const { enabled, selector } = options;
    const [drag, setDrag] = useState<{ id: string; dx: number; dy: number; target: T | null } | null>(null);
    const latest = useRef(options);
    useLayoutEffect(() => { latest.current = options; });
    useEffect(() => {
        if (!enabled || navigator.maxTouchPoints === 0) return;
        let gesture: Gesture | null = null;
        let timer = 0, frame = 0, suppressClickUntil = 0;
        const cancel = () => {
            if (gesture?.active) suppressClickUntil = performance.now() + 700;
            gesture = null;
            clearTimeout(timer);
            cancelAnimationFrame(frame);
            setDrag(null);
        };
        const targetAt = (g: Gesture) => {
            const edge = g.viewport.getBoundingClientRect();
            if (g.x < edge.left || g.x > edge.right || g.y < edge.top || g.y > edge.bottom) return null;
            return latest.current.targetAt(g);
        };
        const publish = (g: Gesture) => {
            setDrag({ id: g.id, dx: g.x - g.startX, dy: g.y - g.startY + g.viewport.scrollTop - g.scrollTop, target: targetAt(g) });
        };
        const follow = () => {
            const g = gesture;
            if (!g?.active) return;
            if (!g.row.isConnected) { cancel(); return; }
            const edge = g.viewport.getBoundingClientRect();
            if (g.x >= edge.left && g.x <= edge.right && g.y >= edge.top && g.y <= edge.bottom) {
                const distance = g.y < edge.top + 32 ? g.y - edge.top - 32 : g.y > edge.bottom - 32 ? g.y - edge.bottom + 32 : 0;
                if (distance) {
                    const previousTop = g.viewport.scrollTop;
                    g.viewport.scrollTop += distance / 4;
                    if (previousTop !== g.viewport.scrollTop) publish(g);
                }
            }
            frame = requestAnimationFrame(follow);
        };
        const start = (event: TouchEvent) => {
            cancel();
            suppressClickUntil = 0;
            if (event.touches.length !== 1) return;
            const row = (event.target as Element).closest<HTMLElement>(selector);
            const viewport = row && latest.current.viewportFor(row);
            if (!row || !viewport) return;
            const touch = event.touches[0]!;
            const g: Gesture = { id: latest.current.idFor(row), finger: touch.identifier, row, viewport,
                startX: touch.clientX, startY: touch.clientY, scrollTop: viewport.scrollTop,
                x: touch.clientX, y: touch.clientY, active: false };
            gesture = g;
            timer = window.setTimeout(() => {
                if (gesture !== g || !row.isConnected) return;
                g.active = true;
                document.getSelection()?.removeAllRanges();
                publish(g);
                follow();
            }, 400);
        };
        const move = (event: TouchEvent) => {
            const g = gesture;
            if (!g) return;
            if (event.touches.length !== 1) { cancel(); return; }
            const touch = event.touches[0]!;
            if (touch.identifier !== g.finger) { cancel(); return; }
            g.x = touch.clientX; g.y = touch.clientY;
            if (!g.active) {
                if (Math.hypot(g.x - g.startX, g.y - g.startY) > 8) cancel();
                return;
            }
            if (!event.cancelable) { cancel(); return; }
            event.preventDefault();
            event.stopPropagation();
            publish(g);
        };
        const end = (event: TouchEvent) => {
            const g = gesture;
            if (!g?.active || event.touches.length !== 0) { cancel(); return; }
            event.preventDefault();
            const touch = event.changedTouches[0];
            if (!touch || touch.identifier !== g.finger) { cancel(); return; }
            g.x = touch.clientX; g.y = touch.clientY;
            const target = targetAt(g);
            cancel();
            if (target !== null) latest.current.onDrop(g.id, target);
        };
        const click = (event: MouseEvent) => {
            if (performance.now() < suppressClickUntil && (event.target as Element).closest(selector)) {
                event.preventDefault();
                event.stopPropagation();
            }
        };
        const context = (event: Event) => { if (gesture) event.preventDefault(); };
        const nativeDrag = (event: DragEvent) => {
            if (gesture && gesture.row.contains(event.target as Node)) {
                event.preventDefault();
                event.stopPropagation();
            }
        };
        const key = (event: KeyboardEvent) => {
            if (event.key !== "Escape" || !gesture?.active) return;
            event.preventDefault();
            event.stopPropagation();
            cancel();
        };
        document.addEventListener("touchstart", start, { passive: true, capture: true });
        // 들어 올린 행은 서랍 스와이프보다 먼저 이동을 소비한다. 짧은 스와이프는 그대로 전달한다.
        window.addEventListener("touchmove", move, { passive: false, capture: true });
        document.addEventListener("touchend", end, { passive: false, capture: true });
        document.addEventListener("touchcancel", cancel, true);
        document.addEventListener("dragstart", nativeDrag, true);
        document.addEventListener("click", click, true);
        document.addEventListener("contextmenu", context, true);
        document.addEventListener("keydown", key, true);
        document.addEventListener("visibilitychange", cancel);
        window.addEventListener("blur", cancel);
        return () => {
            cancel();
            document.removeEventListener("touchstart", start, true);
            window.removeEventListener("touchmove", move, true);
            document.removeEventListener("touchend", end, true);
            document.removeEventListener("touchcancel", cancel, true);
            document.removeEventListener("dragstart", nativeDrag, true);
            document.removeEventListener("click", click, true);
            document.removeEventListener("contextmenu", context, true);
            document.removeEventListener("keydown", key, true);
            document.removeEventListener("visibilitychange", cancel);
            window.removeEventListener("blur", cancel);
        };
    }, [enabled, selector]);
    return drag;
}
