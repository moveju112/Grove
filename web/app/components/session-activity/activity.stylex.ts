import * as stylex from "@stylexjs/stylex";

const desktop = "@media (min-width: 761px)";

export const activityStyles = stylex.create({
    overlay: {
        position: "absolute", inset: 0, zIndex: 4, overflow: "hidden",
        pointerEvents: "none", color: "var(--brand)",
        opacity: 0,
    },
    runner: {
        display: { default: "inline", "@media (prefers-reduced-motion: reduce)": "none" },
    },
    stem: {
        // 기존 모바일 경계(760px)까지는 같은 두께와 농도를 유지한다.
        strokeWidth: { default: .5, [desktop]: 1 },
        opacity: { default: .14, [desktop]: .55 },
    },
    leaf: {
        strokeWidth: { default: .3, [desktop]: .4 },
        transform: { default: "none", [desktop]: "scale(1.2)" },
        transformOrigin: "0 0",
    },
    leafTile: {
        position: "absolute", left: -1, top: -1, width: 7, height: 7,
        transformOrigin: "1px 1px",
    },
    canvas: { display: "block", overflow: "visible" },
});
