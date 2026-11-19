import { Fragment, useCallback, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { Stack } from "@astryxdesign/core/Stack";
import type { Message } from "../api/generated";
import { messageOffsets, messageRange } from "../state/virtualMessages";
import { usePaneVisible } from "../state/paneVisibility";

type Anchor = { id: string; offset: number };
type Geometry = { width: number; height: number; origin: number; scrollTop: number };
const geometryOf = (el: HTMLElement, root: HTMLElement): Geometry => ({
    width: el.clientWidth, height: el.clientHeight, scrollTop: el.scrollTop,
    origin: root.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop,
});
const sameGeometry = (a: Geometry | null, b: Geometry) => !a || a.width === b.width && a.height === b.height && Math.abs(a.origin - b.origin) < 1;
type Props = {
    messages: Message[];
    targetSeq: number | null;
    onTargetReached: (seq: number) => void;
    restorePosition: { anchorSeq: number | null; offset: number } | null;
    onRestored: () => void;
    presentationKey: string;
    stick: RefObject<boolean>;
    /** 사용자가 직접 스크롤하기 전까지 맨 아래 고정을 유지한다. */
    pinned: RefObject<boolean>;
    bottom: RefObject<HTMLDivElement | null>;
    onNavigate: () => void;
    render: (message: Message) => ReactNode;
};

function MeasuredMessage({ message, position, size, register, children }: {
    message: Message; position: number; size: number;
    register: (id: string, node: HTMLDivElement | null) => void; children: ReactNode;
}) {
    const ref = useCallback((node: HTMLDivElement | null) => {
        register(message.id, node);
    }, [message.id, register]);
    return <Stack ref={ref} gap={0} role="article" tabIndex={-1} aria-label={`메시지 ${message.seq}`}
        aria-posinset={position + 1} aria-setsize={size} data-virtual-seq={message.seq} data-virtual-id={message.id}
        paddingBlockEnd={position === size - 1 ? 0 : 2}>
        {children}
    </Stack>;
}

/// 화면 주변·검색/복원 대상·현재 초점 행만 유지한다. 높이 갱신은 같은 읽기 anchor에 맞춘다.
export function VirtualMessages({ messages, targetSeq, onTargetReached, restorePosition, onRestored, presentationKey, stick, pinned, bottom, onNavigate, render }: Props) {
    const visible = usePaneVisible();
    const wasVisible = useRef(visible);
    const root = useRef<HTMLDivElement>(null);
    const nodes = useRef(new Map<string, HTMLDivElement>());
    const heights = useRef(new Map<string, number>());
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
    const pane = () => root.current?.closest('[data-testid="pane-body"]') as HTMLElement | null;
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
        const view = root.current?.closest('[data-testid="session-view"]');
        const ro = new ResizeObserver((entries) => {
            if (!el.clientWidth || !el.clientHeight) return;
            // 사용자의 scroll 이벤트가 아직 전달되지 않은 동안 폼·메시지가 resize될 수 있다.
            // 이때 이전 stick/anchor로 되돌리지 않고 실제로 이동한 viewport를 먼저 인수한다.
            if (root.current && geometry.current && Math.abs(el.scrollTop - geometry.current.scrollTop) > 1) {
                const marker = bottom.current;
                const margin = marker ? parseFloat(getComputedStyle(marker).scrollMarginBottom) || 0 : 0;
                stick.current = pinned.current || (!!marker && marker.getBoundingClientRect().top <= el.getBoundingClientRect().bottom - margin + 80);
                geometry.current = geometryOf(el, root.current);
                updateViewport();
            }
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
        // 새 가상 창의 실제 높이를 다음 범위 계산 전에 반영한다.
        // ResizeObserver까지 기다리면 추정 높이로 범위를 왕복하며 layout 렌더가 반복될 수 있다.
        let changed = false;
        for (const [id, node] of nodes.current) {
            const height = Math.max(1, node.getBoundingClientRect().height);
            if (Math.abs((heights.current.get(id) ?? -1) - height) > 0.5) {
                heights.current.set(id, height);
                changed = true;
            }
        }
        if (changed) {
            adjustment.current ??= { point: anchor.current };
            measured((version) => version + 1);
        }
        if (!wasVisible.current || !sameGeometry(geometry.current, geometryOf(el, root.current))) {
            adjustment.current = { point: anchor.current };
            wasVisible.current = true;
        }
        const targetChanged = previousTarget.current !== targetSeq;
        if (targetChanged && targetSeq !== null) {
            anchor.current = null;
            adjustment.current = null;
        }
        const targetMessage = targetSeq !== null && messages.find((message) => message.seq === targetSeq);
        const targetNode = targetMessage && nodes.current.get(targetMessage.id);
        if (targetMessage && targetNode && !restorePosition) {
            // 검색 이동도 행 측정·anchor 보정과 같은 소유자가 확정한다.
            // 부모에서 먼저 요청을 지우면 이전 viewport가 대상 행을 가상 창 밖으로 밀어낼 수 있다.
            stick.current = false;
            adjustment.current = null;
            targetNode.scrollIntoView({ block: "center" });
            anchor.current = { id: targetMessage.id, offset: targetNode.getBoundingClientRect().top - el.getBoundingClientRect().top };
            setFocused(targetMessage.id);
            previousFirst.current = messages[0]?.id;
            previousTarget.current = targetSeq;
            geometry.current = geometryOf(el, root.current);
            updateViewport();
            onTargetReached(targetMessage.seq);
            return;
        }
        const restoreMessage = restorePosition && messages.find((message) => message.seq === restorePosition.anchorSeq);
        const restoreNode = restoreMessage && nodes.current.get(restoreMessage.id);
        if (restorePosition && restoreMessage && restoreNode) {
            // 저장 위치 복원과 가상 행 높이 보정의 소유자를 하나로 둔다.
            // 부모가 먼저 scrollTop을 바꾸면 observer가 복원 전 anchor로 다시 덮을 수 있다.
            stick.current = false;
            el.scrollTop += restoreNode.getBoundingClientRect().top - el.getBoundingClientRect().top - restorePosition.offset;
            anchor.current = { id: restoreMessage.id, offset: restorePosition.offset };
            adjustment.current = null;
            previousFirst.current = messages[0]?.id;
            previousTarget.current = targetSeq;
            geometry.current = geometryOf(el, root.current);
            updateViewport();
            onRestored();
            return;
        }
        if (pendingFocus.current) {
            const node = nodes.current.get(pendingFocus.current);
            if (node) {
                node.focus({ preventScroll: true });
                node.scrollIntoView({ block: "nearest" });
                pendingFocus.current = null;
            }
        } else if ((!targetChanged || targetSeq === null)
            && (adjustment.current || previousFirst.current !== messages[0]?.id)) {
            // 스크롤로 표시 범위만 바뀌면 위치를 보정하지 않는다.
            // 맨 아래 80px 안에서는 stick이 유지되므로 매번 끝으로 맞추면 느린 터치 스크롤을 되돌린다.
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
    return <Stack ref={root} gap={0} role="feed" tabIndex={0} aria-label="불러온 대화 메시지" aria-live="off"
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
                {before > 0 && <Stack aria-hidden="true" height={before} />}
                <MeasuredMessage message={message} position={index} size={messages.length}
                    register={register}>{render(message)}</MeasuredMessage>
            </Fragment>;
        })}
        <Stack aria-hidden="true" height={offsets.at(-1)! - offsets[previous]!} />
    </Stack>;
}
