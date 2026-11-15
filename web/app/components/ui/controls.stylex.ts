import * as stylex from "@stylexjs/stylex";

// Badge 자체에는 다른 컨트롤의 모서리에 고정하는 배치 속성이 없다.
export const controlStyles = stylex.create({
    toolTrigger: { position: "relative", flexShrink: 0 },
    toolActivity: {
        position: "absolute",
        top: 0,
        right: 0,
        minWidth: 14,
        lineHeight: "14px",
        fontSize: 11,
        borderRadius: "var(--radius-element)",
        backgroundColor: "var(--panel)",
    },
});
