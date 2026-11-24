import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Project } from "../../api/generated";
import { projectFolderDropAt, type ProjectDrop } from "../../state/projectOrder";

type Drag = { id: string; dx: number; dy: number; target: ProjectDrop | null };
type Item = Pick<Project, "id" | "folder_id">;
const PROJECT_ROW = "[data-project-order-id]";

type Gesture = {
    id: string; finger: number; row: HTMLElement; viewport: HTMLElement;
    startX: number; startY: number; scrollTop: number; x: number; y: number;
    active: boolean;
};

// HTML drag 대신 native touchmove를 사용한다. 길게 누르기 전에는 스크롤을 가로채지 않는다.
export function useTouchProjectOrder(enabled: boolean, projects: readonly Item[],
    canMoveToFolder: (sourceId: string, folderId: string | null) => boolean, onDrop: (source: string, target: ProjectDrop) => void) {
    const [drag, setDrag] = useState<Drag | null>(null);
    const latest = useRef({ projects, canMoveToFolder, onDrop });
    useLayoutEffect(() => { latest.current = { projects, canMoveToFolder, onDrop }; }, [projects, canMoveToFolder, onDrop]);
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
        const targetAt = (g: Gesture): ProjectDrop | null => {
            const edge = g.viewport.getBoundingClientRect();
            if (g.x < edge.left || g.x > edge.right || g.y < edge.top || g.y > edge.bottom) return null;
            const folderId = projectFolderDropAt(document.elementFromPoint(g.x, g.y));
            if (folderId !== undefined && latest.current.canMoveToFolder(g.id, folderId)) return { kind: "folder", folderId };
            const source = latest.current.projects.find((p) => p.id === g.id);
            if (!source) return null;
            for (const row of g.viewport.querySelectorAll<HTMLElement>(PROJECT_ROW)) {
                const id = row.dataset.projectOrderId!;
                if (id === g.id) continue;
                const project = latest.current.projects.find((p) => p.id === id);
                if (!project || (source.folder_id ?? null) !== (project.folder_id ?? null)) continue;
                const box = row.getBoundingClientRect();
                if (g.x >= box.left && g.x <= box.right && g.y >= box.top && g.y <= box.bottom) {
                    // 행 가운데에서는 원래 이동 방향으로 자리를 바꾸고, 양 끝에서는 정확한 삽입 위치를 고른다.
                    const fraction = (g.y - box.top) / box.height;
                    const belowSource = !!(g.row.compareDocumentPosition(row) & Node.DOCUMENT_POSITION_FOLLOWING);
                    return { kind: "order", id, after: fraction > 0.75 || (fraction >= 0.25 && belowSource) };
                }
            }
            return null;
        };
        const publish = (g: Gesture) => {
            const target = targetAt(g);
            const next = { id: g.id, dx: g.x - g.startX, dy: g.y - g.startY + g.viewport.scrollTop - g.scrollTop, target };
            setDrag((old) => {
                if (old?.id !== next.id || old.dx !== next.dx || old.dy !== next.dy) return next;
                const previous = old.target;
                if (previous === target || (previous?.kind === "folder" && target?.kind === "folder" && previous.folderId === target.folderId)
                    || (previous?.kind === "order" && target?.kind === "order" && previous.id === target.id && previous.after === target.after)) return old;
                return next;
            });
        };
        const follow = () => {
            const g = gesture;
            if (!g?.active) return;
            if (!g.row.isConnected) { cancel(); return; }
            const edge = g.viewport.getBoundingClientRect();
            if (g.x >= edge.left && g.x <= edge.right && g.y >= edge.top && g.y <= edge.bottom) {
                const distance = g.y < edge.top + 32 ? g.y - edge.top - 32 : g.y > edge.bottom - 32 ? g.y - edge.bottom + 32 : 0;
                g.viewport.scrollTop += distance / 4;
            }
            publish(g);
            frame = requestAnimationFrame(follow);
        };
        const start = (event: TouchEvent) => {
            cancel();
            suppressClickUntil = 0;
            if (event.touches.length !== 1) return;
            const row = (event.target as Element).closest<HTMLElement>(PROJECT_ROW);
            const viewport = row?.closest<HTMLElement>('[data-testid="sidebar-scroll"]');
            if (!row || !viewport) return;
            const touch = event.touches[0]!;
            const g: Gesture = { id: row.dataset.projectOrderId!, finger: touch.identifier, row, viewport,
                startX: touch.clientX, startY: touch.clientY, scrollTop: viewport.scrollTop,
                x: touch.clientX, y: touch.clientY, active: false };
            gesture = g;
            timer = window.setTimeout(() => {
                if (gesture !== g || !row.isConnected) return;
                g.active = true;
                document.getSelection()?.removeAllRanges();
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
            if (target) latest.current.onDrop(g.id, target);
        };
        const click = (event: MouseEvent) => {
            if (performance.now() < suppressClickUntil && (event.target as Element).closest(PROJECT_ROW)) {
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
    }, [enabled]);
    return drag;
}
