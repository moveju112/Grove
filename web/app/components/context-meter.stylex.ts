import * as stylex from "@stylexjs/stylex";

export const contextMeterStyles = stylex.create({
    ring: { display: "block", width: "var(--spacing-4)", height: "var(--spacing-4)" },
    track: { stroke: "currentColor", opacity: 0.3 },
    warning: { color: "var(--warn)" },
});
