import * as stylex from "@stylexjs/stylex";

// Banner가 상태 표면을 소유하고, 앱은 작업 화면을 밀지 않는 전역 배치만 제공한다.
export const noticeStyles = stylex.create({
    loading: { position: "fixed", inset: "0 0 auto", zIndex: 1000, pointerEvents: "none" },
    lifecycle: {
        flexShrink: 0,
        maxHeight: "min(35dvh, 20rem)",
        overflowY: "auto",
    },
    connection: {
        position: "fixed",
        zIndex: 40,
        top: "calc(env(safe-area-inset-top, 0px) + 56px)",
        left: "50%",
        transform: "translateX(-50%)",
        maxWidth: "calc(100vw - 24px)",
        width: "max-content",
    },
    update: {
        position: "fixed",
        zIndex: 40,
        bottom: "var(--spacing-3)",
        left: "50%",
        transform: "translateX(-50%)",
        width: "max-content",
        maxWidth: "calc(100vw - 24px)",
        maxHeight: "35dvh",
        overflowY: "auto",
    },
    protocol: { top: "var(--spacing-3)", bottom: "auto" },
});
