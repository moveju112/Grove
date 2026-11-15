import * as stylex from "@stylexjs/stylex";

// 비율은 서버에 저장한 중첩 배치의 값이다. Resizable의 픽셀 선택 모델로 대체하지 않는다.
export const splitStyles = stylex.create({
    fill: { flexGrow: 1, minWidth: 0, minHeight: 0 },
    child: (basis: string) => ({ flexBasis: basis, flexGrow: 0, flexShrink: 1, minWidth: "8em", minHeight: "6em" }),
    divider: {
        position: "relative", flexBasis: 6, flexGrow: 0, flexShrink: 0,
        backgroundColor: "transparent", touchAction: "none", alignSelf: "stretch",
        "::after": { content: '""', position: "absolute", backgroundColor: "var(--line)" },
        ":hover::after": { backgroundColor: "var(--accent)" },
        ":focus::after": { backgroundColor: "var(--accent)" },
    },
    horizontal: { cursor: "col-resize", width: 6, height: "auto", "::after": { inset: "0 2.5px" } },
    vertical: { cursor: "row-resize", height: 6, width: "auto", "::after": { inset: "2.5px 0" } },
    pane: {
        position: "relative", flexGrow: 1, minWidth: 0, minHeight: 0,
        backgroundColor: "var(--panel)", borderWidth: 1, borderStyle: "solid", borderColor: "transparent",
        ':is([data-focused="true"])': { borderColor: "var(--accent-weak)" },
    },
    drop: {
        position: "absolute", zIndex: 5, pointerEvents: "none", backgroundColor: "var(--accent-weak)",
        borderWidth: 2, borderStyle: "dashed", borderColor: "var(--accent)", opacity: 0.7, inset: 0,
        ':is([data-zone="left"])': { right: "50%" },
        ':is([data-zone="right"])': { left: "50%" },
        ':is([data-zone="top"])': { bottom: "50%" },
        ':is([data-zone="bottom"])': { top: "50%" },
    },
    tabs: { flexShrink: 0, borderBottomWidth: 1, borderBottomStyle: "solid", borderBottomColor: "var(--line)" },
    tab: {
        flexShrink: 0, borderRadius: "var(--radius-element)", color: "var(--muted)",
        ":hover": { backgroundColor: "var(--hover)" },
        ':is([aria-selected="true"])': { backgroundColor: "var(--bg)", color: "var(--text)" },
    },
    title: { maxWidth: "16em", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", cursor: "grab" },
    body: {
        "--pane-inset": "var(--spacing-3)",
        padding: "var(--pane-inset)",
        // 입력 표면이 하단 가림 영역을 소유한다. scroll container는 추가 여백을 만들지 않는다.
        ':has(> [data-testid="session-view"]), :has(> [data-testid="project-view"])': { paddingBottom: 0 },
        containerType: "inline-size",
    },
});
