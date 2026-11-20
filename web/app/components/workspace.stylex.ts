import * as stylex from "@stylexjs/stylex";

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
    mobileDraftDock: { flexShrink: 0, maxHeight: "40%", paddingBlockEnd: "calc(var(--spacing-2) + env(safe-area-inset-bottom, 0px))" },
    recentDock: { flexShrink: 0, minHeight: 0 },
    recentPanel: { flexShrink: 1, minHeight: 0 },
    recentItems: { height: RECENT_ROW_HEIGHT * RECENT_VISIBLE_ROWS, minHeight: 0, overflowY: "auto", overflowX: "hidden", overscrollBehaviorY: "contain" },
    recentList: { rowGap: 0 },
    recentRow: { minHeight: RECENT_ROW_HEIGHT, paddingBlock: 0 },
    recentRowControl: { height: RECENT_ROW_HEIGHT, minHeight: RECENT_ROW_HEIGHT, paddingBlock: 0 },
    recentTitle: { paddingInlineEnd: "var(--spacing-1)" },
    recentActions: { flexShrink: 0 },
    recentClose: { minWidth: "var(--spacing-8)", paddingInline: 0 },
    recentTime: {
        minWidth: "var(--spacing-8)",
        paddingInline: "var(--spacing-1)",
        textAlign: "center",
        fontVariantNumeric: "tabular-nums",
    },
    // 실행·미확인 완료는 행 배경으로만 표시한다. 상태가 바뀌어도 제목·시간·숨김 버튼은 움직이지 않는다.
    recentState: {
        borderRadius: 6,
        backgroundColor: {
            default: null,
            ':is([data-recent-state="running"])': "var(--split-bg)",
            ':is([data-recent-state="completed"])': "var(--ok-weak)",
        },
        // 강제 색상 모드는 배경을 지우므로 상태 행에만 테두리를 남긴다.
        outline: { default: null, ":is([data-recent-state])": { default: null, "@media (forced-colors: active)": "1px solid CanvasText" } },
        outlineOffset: -1,
    },
    recentGroup: {
        position: "relative",
        backgroundColor: "transparent",
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
