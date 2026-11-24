import * as stylex from "@stylexjs/stylex";

export const touchOrderStyles = stylex.create({
    handle: { userSelect: "none", WebkitTouchCallout: "none" },
    lift: (x: number, y: number) => ({
        transform: `translate(${x}px, ${y}px)`,
        zIndex: 20,
        backgroundColor: "var(--raised)",
        boxShadow: "var(--shadow-float)",
        borderRadius: "var(--radius-element)",
        pointerEvents: "none",
    }),
});
