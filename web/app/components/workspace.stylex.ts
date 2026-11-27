import * as stylex from "@stylexjs/stylex";

const RECENT_ROW_HEIGHT = 24;
const RECENT_VISIBLE_ROWS = 6;
// 실행 줄의 조각은 transform만 바꿔 합성 단계에서 움직인다. 줄 안에서 자라고 오른쪽으로 빠지므로 잘라낼 영역이 필요 없다.
const runningSweep = stylex.keyframes({
    "0%": { transform: "translateX(0) scaleX(0)" },
    "40%": { transform: "translateX(0) scaleX(0.4)" },
    "100%": { transform: "translateX(100%) scaleX(0)" },
});
const runningLine = {
    content: '""', position: "absolute", pointerEvents: "none", insetInline: 6, bottom: 1, height: 2, borderRadius: 1,
} as const;

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
    projectListHeading: { alignSelf: "stretch", display: "flex", alignItems: "center" },
    folderDrop: {
        position: "relative",
        zIndex: 21,
        backgroundColor: "var(--split-bg)",
        borderRadius: "var(--radius-element)",
        boxShadow: "inset 0 0 0 1px var(--accent)",
    },
    mobileTerminals: { flexShrink: 0, maxHeight: "30%" },
    mobileSafeEnd: { paddingBlockEnd: "calc(var(--spacing-2) + env(safe-area-inset-bottom, 0px))" },
    mobileDraftDock: { flexShrink: 0, maxHeight: "40%", paddingBlockEnd: "calc(var(--spacing-2) + env(safe-area-inset-bottom, 0px))" },
    recentDock: { flexShrink: 0, minHeight: 0 },
    recentPanel: { flexShrink: 1, minHeight: 0 },
    recentItems: { height: RECENT_ROW_HEIGHT * RECENT_VISIBLE_ROWS, minHeight: 0, overflowY: "auto", overflowX: "hidden", overscrollBehaviorY: "contain" },
    recentList: { rowGap: 0 },
    recentRow: { minHeight: RECENT_ROW_HEIGHT, paddingBlock: 0 },
    recentRowControl: { height: RECENT_ROW_HEIGHT, minHeight: RECENT_ROW_HEIGHT, paddingBlock: 0 },
    recentTitleContent: { minWidth: 0 },
    recentTitle: { paddingInlineEnd: "var(--spacing-1)" },
    recentActions: { flexShrink: 0 },
    recentClose: { minWidth: "var(--spacing-8)", paddingInline: 0 },
    recentTime: {
        minWidth: "var(--spacing-8)",
        paddingInline: "var(--spacing-1)",
        textAlign: "center",
        fontVariantNumeric: "tabular-nums",
    },
    // 질문 대기·미확인 완료는 행 배경, 실행은 아래 진행 줄로 표시한다. 상태가 바뀌어도 제목·시간·숨김 버튼은 움직이지 않는다.
    recentState: {
        borderRadius: 6,
        backgroundColor: {
            default: null,
            ':is([data-recent-state="completed"])': "var(--ok-weak)",
            ':is([data-recent-state="question"])': "var(--question-bg)",
        },
        // 강제 색상 모드는 배경을 지우므로 상태 행에만 테두리를 남긴다.
        outline: { default: null, ":is([data-recent-state])": { default: null, "@media (forced-colors: active)": "1px solid CanvasText" } },
        outlineOffset: -1,
    },
    // 정지 상태에서도 트랙과 조각을 함께 보여 실행 중임을 알린다. 움직임은 recentRunningMotion만 더한다.
    recentRunning: {
        position: "relative",
        "::before": { ...runningLine, backgroundColor: "color-mix(in srgb, var(--split-line) 22%, transparent)" },
        "::after": {
            ...runningLine, backgroundColor: "var(--split-line)", transformOrigin: "left center",
            transform: "translateX(30%) scaleX(0.4)",
        },
    },
    // 가상 요소 안에는 조건 값을 둘 수 없어 모션 줄이기 판단을 행의 변수로 넘긴다.
    recentRunningMotion: {
        "--recent-running-sweep": { default: "none", "@media (prefers-reduced-motion: no-preference)": runningSweep },
        "::after": {
            animationName: "var(--recent-running-sweep)",
            animationDuration: "1.8s",
            animationTimingFunction: "ease-in-out",
            animationIterationCount: "infinite",
        },
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
