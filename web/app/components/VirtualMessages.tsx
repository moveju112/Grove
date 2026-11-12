import { Fragment, useCallback, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import type { Message } from "../api/generated";
import { messageOffsets, messageRange } from "../state/virtualMessages";
import { usePaneVisible } from "../state/paneVisibility";

type Anchor = { id: string; offset: number };
type Geometry = { width: number; height: number; origin: number };
const geometryOf = (el: HTMLElement, root: HTMLElement): Geometry => ({
    width: el.clientWidth, height: el.clientHeight,
    origin: root.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop,
});
const sameGeometry = (a: Geometry | null, b: Geometry) => !a || a.width === b.width && a.height === b.height && Math.abs(a.origin - b.origin) < 1;
type Props = {
    messages: Message[];
    targetSeq: number | null;
    presentationKey: string;
    stick: RefObject<boolean>;
    bottom: RefObject<HTMLDivElement | null>;
    onNavigate: () => void;
    render: (message: Message) => ReactNode;
};

function MeasuredMessage({ message, position, size, presentationKey, states, register, children }: {
    message: Message; position: number; size: number; presentationKey: string;
    states: Map<string, boolean[]>; register: (id: string, node: HTMLDivElement | null) => void; children: ReactNode;
}) {
    const previous = useRef<HTMLDivElement | null>(null);
    const stateKey = `${message.id}:${presentationKey}`;
    const ref = useCallback((node: HTMLDivElement | null) => {
        if (!node && previous.current) {
            states.set(stateKey, [...previous.current.querySelectorAll("details")].map((d) => d.open));
        }
        if (node) {
            const saved = states.get(stateKey);
            if (saved) [...node.querySelectorAll("details")].forEach((d, i) => { if (saved[i] !== undefined) d.open = saved[i]!; });
        }
        previous.current = node;
        register(message.id, node);
    }, [message.id, register, states, stateKey]);
    return <div ref={ref} role="article" tabIndex={-1} aria-label={`메시지 ${message.seq}`}
        aria-posinset={position + 1} aria-setsize={size} data-virtual-seq={message.seq} data-virtual-id={message.id}
        className="virtual-message" style={{ paddingBottom: position === size - 1 ? 0 : "0.5em" }}>
        {children}
    </div>;
}

/// 화면 주변·검색/복원 대상·현재 초점 행만 유지한다. 높이 갱신은 같은 읽기 anchor에 맞춘다.
export function VirtualMessages({ messages, targetSeq, presentationKey, stick, bottom, onNavigate, render }: Props) {
    const visible = usePaneVisible();
    const wasVisible = useRef(visible);
    const root = useRef<HTMLDivElement>(null);
    const nodes = useRef(new Map<string, HTMLDivElement>());
    const heights = useRef(new Map<string, number>());
    const details = useRef(new Map<string, boolean[]>());
    const observer = useRef<ResizeObserver | null>(null);
    const anchor = useRef<Anchor | null>(null);
    const geometry = useRef<Geometry | null>(null);
    // anchor가 아직 없을 때도 측정/resize에 따른 맨 아래 보정은 대기 중일 수 있다.
    const adjustment = useRef<{ point: Anchor | null } | null>(null);
    const pendingFocus = useRef<string | null>(null);
    const previousFirst = useRef(messages[0]?.id);
    const previousTarget = useRef(targetSeq);
    const [focused, setFocused] = useState<string | null>(null);
    const [viewport, setViewport] = useState({ top: 0, bottom: 800 });
    const [, measured] = useState(0);
    const pane = () => root.current?.closest(".pane-body") as HTMLElement | null;
    const updateViewport = useCallback(() => {
        const el = pane();
        if (!el || !el.clientWidth || !el.clientHeight || !root.current) return;
        // resize에 따른 scroll 이벤트가 observer의 보정보다 먼저 와도 기존 읽기 anchor는 덮어쓰지 않는다.
        if (!sameGeometry(geometry.current, geometryOf(el, root.current))) return;
        const bounds = el.getBoundingClientRect();
        const top = bounds.top - root.current.getBoundingClientRect().top;
        setViewport((v) => v.top === top && v.bottom === top + el.clientHeight ? v : { top, bottom: top + el.clientHeight });
        let first: Anchor | null = null;
        for (const [id, node] of nodes.current) {
            const rect = node.getBoundingClientRect();
            if (rect.bottom > bounds.top && rect.top < bounds.bottom && (!first || rect.top - bounds.top < first.offset)) {
                first = { id, offset: rect.top - bounds.top };
            }
        }
        anchor.current = first;
    }, []);
    const register = useCallback((id: string, node: HTMLDivElement | null) => {
        const old = nodes.current.get(id);
        if (old) observer.current?.unobserve(old);
        if (node) {
            nodes.current.set(id, node);
            observer.current?.observe(node);
        } else nodes.current.delete(id);
    }, []);
    useLayoutEffect(() => {
        const el = pane();
        if (!el) return;
        const view = root.current?.closest(".session-view");
        const ro = new ResizeObserver((entries) => {
            if (!el.clientWidth || !el.clientHeight) return;
            let changed = false;
            for (const entry of entries) {
                const node = entry.target as HTMLElement;
                const id = node.dataset.virtualId;
                if (!id || node.getBoundingClientRect().width === 0) continue;
                const height = Math.max(1, node.getBoundingClientRect().height);
                if (Math.abs((heights.current.get(id) ?? -1) - height) > 0.5) {
                    heights.current.set(id, height);
                    changed = true;
                }
            }
            // 메시지 높이가 같아도 헤더 줄바꿈·키보드로 feed 시작점/viewport가 움직인다.
            if (changed || entries.some((entry) => entry.target === el || entry.target === view)) {
                adjustment.current = { point: anchor.current };
                measured((v) => v + 1);
            } else updateViewport();
        });
        observer.current = ro;
        for (const node of nodes.current.values()) ro.observe(node);
        ro.observe(el);
        if (view) ro.observe(view);
        el.addEventListener("scroll", updateViewport, { passive: true });
        updateViewport();
        return () => {
            ro.disconnect();
            observer.current = null;
            el.removeEventListener("scroll", updateViewport);
        };
    }, [updateViewport]);
    const offsets = messageOffsets(messages, heights.current);
    const range = messageRange(offsets, viewport.top, viewport.bottom);
    const indices = new Set(Array.from({ length: range.end - range.start }, (_, i) => range.start + i));
    for (const index of [
        messages.findIndex((m) => m.seq === targetSeq),
        messages.findIndex((m) => m.id === focused),
        messages.findIndex((m) => m.id === anchor.current?.id),
    ]) if (index >= 0) indices.add(index);
    const ordered = [...indices].sort((a, b) => a - b);

    useLayoutEffect(() => {
        const el = pane();
        if (!el || !root.current) return;
        if (!visible) { wasVisible.current = false; return; }
        if (!wasVisible.current || !sameGeometry(geometry.current, geometryOf(el, root.current))) {
            adjustment.current = { point: anchor.current };
            wasVisible.current = true;
        }
        const targetChanged = previousTarget.current !== targetSeq;
        if (targetChanged) {
            anchor.current = null;
            adjustment.current = null;
        }
        if (pendingFocus.current) {
            const node = nodes.current.get(pendingFocus.current);
            if (node) {
                node.focus({ preventScroll: true });
                node.scrollIntoView({ block: "nearest" });
                pendingFocus.current = null;
            }
        } else if (!targetChanged && (adjustment.current || previousFirst.current !== messages[0]?.id)) {
            const point = adjustment.current?.point ?? anchor.current;
            if (stick.current) bottom.current?.scrollIntoView({ block: "end" });
            else if (point) {
                const node = nodes.current.get(point.id);
                if (node) el.scrollTop += node.getBoundingClientRect().top - el.getBoundingClientRect().top - point.offset;
            }
        }
        adjustment.current = null;
        previousFirst.current = messages[0]?.id;
        previousTarget.current = targetSeq;
        geometry.current = geometryOf(el, root.current);
        updateViewport();
    });

    const move = (index: number) => {
        const message = messages[index];
        if (!message) return;
        onNavigate();
        anchor.current = null;
        adjustment.current = null;
        pendingFocus.current = message.id;
        setFocused(message.id);
        const node = nodes.current.get(message.id);
        if (node) {
            node.focus({ preventScroll: true });
            node.scrollIntoView({ block: "nearest" });
            pendingFocus.current = null;
        }
    };
    let previous = 0;
    return <div ref={root} role="feed" tabIndex={0} aria-label="불러온 대화 메시지" aria-live="off"
        onFocusCapture={(e) => setFocused((e.target as HTMLElement).closest<HTMLElement>("[data-virtual-id]")?.dataset.virtualId ?? null)}
        onBlurCapture={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocused(null); }}
        onKeyDown={(e) => {
            if (e.target !== e.currentTarget && !(e.target as HTMLElement).matches("[data-virtual-id]")) return;
            const index = messages.findIndex((m) => m.id === focused);
            let next: number;
            if (e.key === "Home") next = 0;
            else if (e.key === "End") next = messages.length - 1;
            else if (e.key === "ArrowDown") next = Math.min(messages.length - 1, Math.max(0, index + 1));
            else if (e.key === "ArrowUp") next = Math.max(0, index < 0 ? range.start : index - 1);
            else return;
            e.preventDefault();
            move(next);
        }}>
        {ordered.map((index) => {
            const before = offsets[index]! - offsets[previous]!;
            previous = index + 1;
            const message = messages[index]!;
            return <Fragment key={message.id}>
                {before > 0 && <div aria-hidden="true" style={{ height: before }} />}
                <MeasuredMessage message={message} position={index} size={messages.length} presentationKey={presentationKey}
                    states={details.current} register={register}>{render(message)}</MeasuredMessage>
            </Fragment>;
        })}
        <div aria-hidden="true" style={{ height: offsets.at(-1)! - offsets[previous]! }} />
    </div>;
}
