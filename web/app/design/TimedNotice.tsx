import { Banner, type BannerProps } from "@astryxdesign/core/Banner";
import * as stylex from "@stylexjs/stylex";
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { usePrefs } from "../state/device";
import { noticeStyles } from "./notices.stylex";

const drain = stylex.keyframes({
    from: { transform: "scaleX(1)" },
    to: { transform: "scaleX(0)" },
});

const styles = stylex.create({
    frame: { position: "relative", overflow: "hidden", borderRadius: 12 },
    // 남은 시간은 transform으로만 줄인다. 모션 줄이기에서는 막대를 멈춰 두고 시간만 센다.
    bar: {
        position: "absolute", insetInline: 0, bottom: 0, height: 3, pointerEvents: "none",
        transformOrigin: "left",
        animationName: { default: drain, "@media (prefers-reduced-motion: reduce)": "none" },
        animationTimingFunction: "linear", animationFillMode: "forwards",
    },
    warning: { backgroundColor: "var(--color-warning)" },
    error: { backgroundColor: "var(--color-error)" },
    success: { backgroundColor: "var(--color-success)" },
    paused: { animationPlayState: "paused" },
    duration: (ms: number) => ({ animationDuration: `${ms}ms` }),
});

function subscribeVisibility(listener: () => void) {
    document.addEventListener("visibilitychange", listener);
    return () => document.removeEventListener("visibilitychange", listener);
}

/** 정한 시간 뒤 스스로 닫히는 상단 알림의 틀. 가리키거나 포커스했거나 탭이 숨겨진 동안은 시간을 멈춘다. 떠 있는 동안 바뀐 시간은 다음 알림부터 쓴다. */
export function TimedNotice({ tone, seconds, onExpire, children, timerTestId, "data-testid": testId }: {
    tone: "warning" | "error" | "success"; seconds: number; onExpire: () => void; children: ReactNode; timerTestId?: string; "data-testid"?: string;
}) {
    const [duration] = useState(seconds * 1000);
    const [hovered, setHovered] = useState(false);
    const [focused, setFocused] = useState(false);
    const visible = useSyncExternalStore(subscribeVisibility, () => document.visibilityState === "visible", () => true);
    const paused = hovered || focused || !visible;
    const left = useRef(duration);
    const expire = useRef(onExpire);
    useEffect(() => { expire.current = onExpire; });
    useEffect(() => {
        if (paused) return;
        const started = performance.now();
        const timer = window.setTimeout(() => expire.current(), left.current);
        return () => {
            window.clearTimeout(timer);
            left.current = Math.max(0, left.current - (performance.now() - started));
        };
    }, [paused]);
    return <div {...stylex.props(noticeStyles.interactive, styles.frame)} data-testid={testId}
        onPointerEnter={() => setHovered(true)} onPointerLeave={() => setHovered(false)}
        onFocus={() => setFocused(true)}
        onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocused(false); }}>
        {children}
        <div aria-hidden="true" data-testid={timerTestId} {...stylex.props(styles.bar, styles[tone], styles.duration(duration), paused && styles.paused)} />
    </div>;
}

/** 떠 있는 오류 알림. 직접 닫거나 기기 설정의 시간이 지나면 사라지고, 설정에서 끄면 띄우지 않는다. 같은 문제의 차단·재확인은 각 상태가 계속 맡는다. */
export function ErrorNotice({ onDismiss, ...banner }: Omit<BannerProps, "status" | "xstyle">) {
    const [open, setOpen] = useState(true);
    const { noticeErrorSeconds: seconds } = usePrefs("noticeErrorSeconds");
    if (!open || !seconds) return null;
    const close = () => { setOpen(false); onDismiss?.(); };
    return <TimedNotice tone="error" seconds={seconds} onExpire={close} timerTestId="error-notice-timer">
        <Banner status="error" role="alert" {...banner} onDismiss={close} />
    </TimedNotice>;
}
