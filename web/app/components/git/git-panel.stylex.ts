import * as stylex from "@stylexjs/stylex";

export const gitPanelStyles = stylex.create({
    shrink: { minWidth: 0 },
    actions: { flexShrink: 0, whiteSpace: "nowrap" },
    path: { minWidth: 0, width: "100%", maxWidth: "100%", textAlign: "start" },
    // 전체 Git 상태와 fingerprint는 보존하고, 화면에 올리는 행과 스크롤 높이만 제한한다.
    viewport: { maxHeight: 360 },
    definition: { margin: 0 },
    term: { flexShrink: 0, color: "var(--muted)" },
    value: { minWidth: 0, margin: 0, textAlign: "end", overflowWrap: "anywhere" },
});
