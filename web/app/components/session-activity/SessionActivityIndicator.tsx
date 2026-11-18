import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import * as stylex from "@stylexjs/stylex";
import { Stack } from "@astryxdesign/core/Stack";
import type { Turn } from "../../api/generated";
import { api } from "../../api/client";
import { usePrefs, type Prefs } from "../../state/device";
import { useQuery } from "../../state/store";
import { activityStyles } from "./activity.stylex";
import { orbitDelay, orbitKeyframes, perimeterGeometry } from "./vineGeometry";

export const VINE_LENGTHS = { short: 64, medium: 104, long: 152 } as const;
export const VINE_LEAF_SPACING = 8;
export const VINE_DURATIONS = { slow: 36, normal: 24, fast: 14 } as const;
const LEAF_PATH = "M0 0C-.6 1.4 .2 3.6 2.8 4C3.2 2.2 2 .6 0 0Z";

export function isWaitingForResponse(status: Turn["status"]): boolean {
    return status === "queued" || status === "running";
}

// 탭 아래 viewport에만 겹치며 스크롤바 영역은 제외한다.
export function SessionActivityIndicator({ sessionId, visible, viewportRef }: {
    sessionId: string; visible: boolean; viewportRef: RefObject<HTMLDivElement | null>;
}) {
    const prefs = usePrefs();
    const [pageVisible, setPageVisible] = useState(() => document.visibilityState === "visible");
    useEffect(() => {
        const changed = () => setPageVisible(document.visibilityState === "visible");
        document.addEventListener("visibilitychange", changed);
        return () => document.removeEventListener("visibilitychange", changed);
    }, []);
    const turns = useQuery<Turn[]>(visible && prefs.sessionVines ? `turns:${sessionId}` : null,
        () => api.get(`/sessions/${sessionId}/turns?limit=5`));
    const enabled = visible && pageVisible && prefs.sessionVines;
    const active = enabled && !!turns.data?.some((turn) => isWaitingForResponse(turn.status));
    const [present, setPresent] = useState(false);
    useLayoutEffect(() => {
        if (active) setPresent(true);
        else if (!enabled) setPresent(false);
    }, [active, enabled]);
    const exited = useCallback(() => setPresent(false), []);
    if (!enabled || (!active && !present)) return null;
    return <SessionVines active={active} onExited={exited} viewportRef={viewportRef}
        length={prefs.sessionVineLength} speed={prefs.sessionVineSpeed} groups={prefs.sessionVineGroups} />;
}

export function SessionVines({ active, onExited, viewportRef, length, speed, groups }: {
    active: boolean; onExited: () => void; length: Prefs["sessionVineLength"]; speed: Prefs["sessionVineSpeed"];
    viewportRef: RefObject<HTMLDivElement | null>; groups: Prefs["sessionVineGroups"];
}) {
    const root = useRef<HTMLDivElement>(null);
    const [size, setSize] = useState<{ width: number; height: number } | null>(null);
    const [reduced, setReduced] = useState(() => matchMedia("(prefers-reduced-motion: reduce)").matches);
    useEffect(() => {
        const media = matchMedia("(prefers-reduced-motion: reduce)");
        const changed = () => setReduced(media.matches);
        media.addEventListener("change", changed);
        return () => media.removeEventListener("change", changed);
    }, []);
    useLayoutEffect(() => {
        const node = root.current!;
        const viewport = viewportRef.current!;
        const measure = () => {
            // 기존 본문 여백 안에 겹친다. 공간을 차지하는 스크롤바가 있으면 두께와 간격을 뺀다.
            const horizontal = viewport.offsetHeight - viewport.clientHeight;
            const vertical = viewport.offsetWidth - viewport.clientWidth;
            node.style.right = `${vertical > 0 ? vertical + 4 : 0}px`;
            node.style.bottom = `${Math.max(horizontal > 0 ? horizontal + 4 : 0, viewport.scrollWidth > viewport.clientWidth ? 16 : 0)}px`;
            const { width, height } = node.getBoundingClientRect();
            setSize((previous) => previous?.width === width && previous.height === height ? previous : { width, height });
        };
        const observer = new ResizeObserver(measure);
        observer.observe(node);
        observer.observe(viewport);
        let content: Element[] = [];
        const observeContent = () => {
            content.forEach((element) => observer.unobserve(element));
            content = Array.from(viewport.children);
            content.forEach((element) => observer.observe(element));
            measure();
        };
        const contentObserver = new MutationObserver(observeContent);
        contentObserver.observe(viewport, { childList: true });
        observeContent();
        return () => { observer.disconnect(); contentObserver.disconnect(); };
    }, [viewportRef]);
    useLayoutEffect(() => {
        const node = root.current!;
        const target = active ? "1" : "0";
        const finish = () => {
            node.style.opacity = target;
            if (!active) onExited();
        };
        if (reduced) {
            finish();
            return;
        }
        const animation = node.animate([{ opacity: getComputedStyle(node).opacity }, { opacity: target }],
            { duration: 600, easing: getComputedStyle(node).getPropertyValue("--motion-ease").trim(), fill: "both" });
        animation.onfinish = finish;
        return () => {
            // 사라지는 중 다음 응답이 시작되면 현재 농도에서 이어가고 이전 완료 알림은 해제한다.
            node.style.opacity = getComputedStyle(node).opacity;
            animation.onfinish = null;
            animation.cancel();
        };
    }, [active, reduced, onExited]);
    const pixels = VINE_LENGTHS[length];
    const duration = VINE_DURATIONS[speed];
    const leafCount = Math.floor((pixels - VINE_LEAF_SPACING) / VINE_LEAF_SPACING);
    return <Stack ref={root} xstyle={activityStyles.overlay} data-testid="session-activity" data-state={active ? "active" : "leaving"} aria-hidden="true">
        {size && (reduced ? <StaticVineFrame width={size.width} height={size.height} />
            : <VineOrbit width={size.width} height={size.height} pixels={pixels} duration={duration} leafCount={leafCount} groups={groups} />)}
    </Stack>;
}

export function StaticVineFrame({ width, height }: { width: number; height: number }) {
    const { path } = perimeterGeometry(width, height);
    const corners = ["", `translate(${width} 0) scale(-1 1)`,
        `translate(${width} ${height}) scale(-1 -1)`, `translate(0 ${height}) scale(1 -1)`];
    return <svg width="100%" height="100%" {...stylex.props(activityStyles.canvas)} data-testid="session-activity-static">
        <path d={path} fill="none" stroke="currentColor" strokeWidth=".65" opacity=".55" />
        {corners.map((transform, index) => <g key={index} transform={transform} data-static-vine-corner="" opacity=".85">
            <path d="M4 4Q8 9 22 8M4 4Q9 8 8 22" fill="none" stroke="currentColor" strokeWidth=".65" />
            <path d={LEAF_PATH} transform="translate(13 8) rotate(-55) scale(1.8)" fill="currentColor" />
            <path d={LEAF_PATH} transform="translate(8 13) rotate(25) scale(1.8)" fill="currentColor" />
            <path d={LEAF_PATH} transform="translate(7 7) rotate(180)" fill="currentColor" />
        </g>)}
    </svg>;
}

export function VineOrbit({ width, height, pixels, duration, leafCount, groups }: {
    width: number; height: number; pixels: number; duration: number; leafCount: number; groups: Prefs["sessionVineGroups"];
}) {
    const runners = useRef<HTMLSpanElement>(null);
    const startedAt = useRef<Animation["startTime"]>(null);
    const geometry = useMemo(() => perimeterGeometry(width, height), [width, height]);
    useLayoutEffect(() => {
        const keyframes = orbitKeyframes(geometry);
        if (!keyframes.length) return;
        // 창 크기가 바뀌어 경로를 다시 만들어도 같은 재생 시각에서 이어간다.
        const startTime = startedAt.current ??= document.timeline.currentTime;
        // SVG 경로는 작은 타일 안에 고정하고 브라우저가 HTML 타일의 transform만 합성한다.
        const animations = Array.from(runners.current!.querySelectorAll<HTMLElement>("[data-vine-tile]"), (tile, i) => {
            const phase = .18 + Math.floor(i / leafCount) / groups;
            const distance = (i % leafCount) * VINE_LEAF_SPACING + 6;
            const animation = tile.animate(keyframes, {
                duration: duration * 1000, delay: orbitDelay(phase, distance, geometry.perimeter, duration) * 1000,
                iterations: Infinity, fill: "backwards",
            });
            if (startTime !== null) animation.startTime = startTime;
            return animation;
        });
        return () => animations.forEach((animation) => animation.cancel());
    }, [geometry, duration, leafCount, groups]);
    return <>
        <svg width="100%" height="100%" {...stylex.props(activityStyles.canvas)}>
            <path data-vine-stem="" d={geometry.path} fill="none" stroke="currentColor"
                {...stylex.props(activityStyles.runner, activityStyles.stem)} />
        </svg>
        <span ref={runners} {...stylex.props(activityStyles.runner)}>
            {geometry.radius > 0 && Array.from({ length: groups }, (_, vine) => (
                <span key={vine} data-testid="session-vine-runner">
                    {Array.from({ length: leafCount }, (_, index) => {
                        const depth = (index * VINE_LEAF_SPACING + 6) / pixels;
                        return <span key={index} data-vine-tile="" data-vine-head={index === 0 ? "" : undefined}
                            {...stylex.props(activityStyles.leafTile)}>
                            <svg width="7" height="7" viewBox="-1 -1 7 7" {...stylex.props(activityStyles.canvas)}>
                                <path data-vine-leaf="" d={LEAF_PATH} fill="currentColor" stroke="currentColor" strokeLinejoin="round"
                                    {...stylex.props(activityStyles.leaf)} opacity={.96 * Math.pow(1 - depth, 1.2)} />
                            </svg>
                        </span>;
                    })}
                </span>
            ))}
        </span>
    </>;
}
