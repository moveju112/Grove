import * as stylex from "@stylexjs/stylex";

// Composer 자체가 입력 표면이므로 TextArea의 제어 상자 테두리는 중복해서 그리지 않는다.
export const composerStyles = stylex.create({
    content: { padding: "var(--spacing-2)" },
    toolbar: { gridTemplateColumns: "32px minmax(0, 1fr) auto", alignItems: "center" },
    modelSlot: { gridColumn: "2", gridRow: "1", minWidth: 0 },
    expandedModel: { gridColumn: "1 / -1" },
    attachmentSlot: { gridColumn: "1", gridRow: "1", minWidth: 0 },
    sendSlot: { gridColumn: "3", gridRow: "1" },
    secondRow: { gridRow: "2" },
    modelControl: { minWidth: 0 },
    modelTrigger: { minWidth: 0, minHeight: 32, height: "auto", paddingInline: 8, textAlign: "start" },
    modelName: { flexGrow: 1, minWidth: 0, whiteSpace: "normal", overflowWrap: "anywhere" },
    modelMeasurement: {
        position: "fixed", visibility: "hidden", pointerEvents: "none", inset: "0 auto auto -10000px",
        display: "flex", alignItems: "center", gap: 8, paddingInline: 8, width: "max-content", whiteSpace: "nowrap",
    },
    inputControl: {
        borderWidth: 0,
        borderRadius: 0,
        backgroundColor: "transparent",
        boxShadow: "none",
        padding: 0,
        minHeight: 32,
        maxHeight: 160,
        lineHeight: "24px",
        resize: "none",
        overflowY: "auto",
        ":focus-within": { boxShadow: "none", outline: "none" },
    },
});
