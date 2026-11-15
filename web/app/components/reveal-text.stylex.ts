import * as stylex from "@stylexjs/stylex";

const reveal = stylex.keyframes({
    from: { opacity: 0, transform: "translateY(6px)" },
    to: { opacity: 1, transform: "none" },
});

// Text에는 글자별 지연 속성이 없다. 접근성 문장은 별도로 한 번만 제공한다.
export const revealStyles = stylex.create({
    letter: (index: number) => ({
        display: "inline-block",
        animationName: { default: reveal, "@media (prefers-reduced-motion: reduce)": "none" },
        animationDuration: "var(--motion-reveal)",
        animationTimingFunction: "var(--motion-ease)",
        animationFillMode: "both",
        animationDelay: `${Math.min(index, 5) * 45}ms`,
    }),
});
