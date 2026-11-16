import * as stylex from "@stylexjs/stylex";

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
        "::after": { content: '""', position: "absolute", pointerEvents: "none", left: 0, right: 0, height: 2, backgroundColor: "transparent" },
        ':is([data-order-drop="before"])::after': { top: 0, backgroundColor: "var(--accent)" },
        ':is([data-order-drop="after"])::after': { bottom: 0, backgroundColor: "var(--accent)" },
    },
    recentDock: { flexShrink: 0, minHeight: 0 },
    recentPanel: { flexShrink: 1, minHeight: 0 },
    // 32px 행 다섯 개와 4px 행 간격 네 개.
    recentItems: { maxHeight: 176, minHeight: 0, overflowY: "auto", overflowX: "hidden", overscrollBehaviorY: "contain" },
    recentList: { rowGap: 4 },
    recentIndicator: { flexShrink: 0, width: 16, height: 16 },
    recentGroup: {
        backgroundColor: "var(--split-bg)",
        borderWidth: 0,
        borderInlineStartWidth: 3,
        borderInlineStartStyle: "solid",
        borderInlineStartColor: "var(--split-line)",
        borderRadius: 6,
        overflow: "hidden",
    },
});
