import * as stylex from "@stylexjs/stylex";

const recentOrbit = stylex.keyframes({
    from: { strokeDashoffset: "0" },
    to: { strokeDashoffset: "-100" },
});
const RECENT_ROW_HEIGHT = 24;
const RECENT_VISIBLE_ROWS = 6;

// 앱 탐색과 작업 면의 팔레트. 크기·배치·스크롤은 Layout/Stack 속성이 소유한다.
export const workspaceStyles = stylex.create({
    navigation: {
        height: "100%",
        fontSize: 12,
        lineHeight: "18px",
        backgroundColor: "var(--bg)",
    },
    rail: { borderInlineEndWidth: 1, borderInlineEndStyle: "solid", borderInlineEndColor: "var(--line)" },
    main: { backgroundColor: "var(--panel)" },
    projects: { minHeight: 0 },
    projectRow: {
        position: "relative",
        "::after": { content: '""', position: "absolute", pointerEvents: "none", zIndex: 21, left: 0, right: 0, height: 2, backgroundColor: "transparent" },
        ':is([data-order-drop="before"])::after': { top: 0, backgroundColor: "var(--accent)" },
        ':is([data-order-drop="after"])::after': { bottom: 0, backgroundColor: "var(--accent)" },
    },
    projectDragHandle: { userSelect: "none", WebkitTouchCallout: "none" },
    projectListHeading: { alignSelf: "stretch", display: "flex", alignItems: "center" },
    folderDrop: {
        position: "relative",
        zIndex: 21,
        backgroundColor: "var(--split-bg)",
        borderRadius: "var(--radius-element)",
        boxShadow: "inset 0 0 0 1px var(--accent)",
    },
    projectLift: (x: number, y: number) => ({
        transform: `translate(${x}px, ${y}px)`,
        zIndex: 20,
        backgroundColor: "var(--raised)",
        boxShadow: "var(--shadow-float)",
        borderRadius: "var(--radius-element)",
        pointerEvents: "none",
    }),
    recentDock: { flexShrink: 0, minHeight: 0 },
    recentPanel: { flexShrink: 1, minHeight: 0 },
    recentItems: { maxHeight: RECENT_ROW_HEIGHT * RECENT_VISIBLE_ROWS, minHeight: 0, overflowY: "auto", overflowX: "hidden", overscrollBehaviorY: "contain" },
    recentList: { rowGap: 0 },
    recentRow: { minHeight: RECENT_ROW_HEIGHT, paddingBlock: 0 },
    recentRowControl: { height: RECENT_ROW_HEIGHT, minHeight: RECENT_ROW_HEIGHT, paddingBlock: 0 },
    recentTitle: { paddingInlineEnd: "var(--spacing-1)" },
    recentActions: { flexShrink: 0 },
    recentClose: { minWidth: "var(--spacing-8)", paddingInline: 0 },
    recentTime: {
        position: "relative",
        minWidth: "var(--spacing-8)",
        paddingInline: "var(--spacing-1)",
        textAlign: "center",
        fontVariantNumeric: "tabular-nums",
    },
    recentRing: { position: "absolute", inset: 0, width: "100%", height: "100%", pointerEvents: "none" },
    recentRingOutline: {
        width: "calc(100% - 2px)", height: "calc(100% - 2px)", fill: "none",
        stroke: { default: "var(--split-line)", "@media (forced-colors: active)": "CanvasText" },
        strokeWidth: 1.25,
    },
    recentRingTrack: { opacity: { default: 1, "@media (prefers-reduced-motion: no-preference)": 0.32 } },
    recentRingSweep: {
        display: { default: "none", "@media (prefers-reduced-motion: no-preference)": "inline" },
        animationName: { default: "none", "@media (prefers-reduced-motion: no-preference)": recentOrbit },
        animationDuration: "1.3s", animationTimingFunction: "linear", animationIterationCount: "infinite",
        strokeDasharray: "28 72", strokeLinecap: "round",
    },
    recentCheck: {
        position: "absolute", insetInlineEnd: "calc(-1 * var(--spacing-1))", insetBlockStart: 0,
        color: "var(--text-2)", pointerEvents: "none",
    },
    recentGroup: {
        position: "relative",
        backgroundColor: "var(--split-bg)",
        borderWidth: 0,
        borderRadius: 6,
        overflow: "hidden",
        // 분할 표시선을 겹쳐 그려 일반 행과 제목 시작점을 맞춘다.
        "::after": {
            content: '""', position: "absolute", pointerEvents: "none", insetBlock: 0, insetInlineStart: 0,
            borderInlineStartWidth: 3, borderInlineStartStyle: "solid", borderInlineStartColor: "var(--split-line)",
        },
    },
});
