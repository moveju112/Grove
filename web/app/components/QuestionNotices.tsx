import { Banner } from "@astryxdesign/core/Banner";
import * as stylex from "@stylexjs/stylex";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Button } from "../design/Button";
import { noticeStyles } from "../design/notices.stylex";
import { requestOpenSession } from "../state/attention";
import { dismissQuestionNotice, useQuestionNotices, type QuestionNotice as Notice } from "../state/questionNotices";
import { Icon } from "./icons";

const DURATION = 10_000;

const drain = stylex.keyframes({
    from: { transform: "scaleX(1)" },
    to: { transform: "scaleX(0)" },
});

const styles = stylex.create({
    frame: { position: "relative", overflow: "hidden", borderRadius: 12 },
    open: { color: "inherit", minWidth: 0, maxWidth: "100%" },
    text: { display: "block", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
    // 남은 시간은 transform으로만 줄인다. 모션 줄이기에서는 막대를 멈춰 두고 시간만 센다.
    bar: {
        position: "absolute", insetInline: 0, bottom: 0, height: 3, pointerEvents: "none",
        backgroundColor: "var(--color-warning)", transformOrigin: "left",
        animationName: { default: drain, "@media (prefers-reduced-motion: reduce)": "none" },
        animationDuration: `${DURATION}ms`, animationTimingFunction: "linear", animationFillMode: "forwards",
    },
    paused: { animationPlayState: "paused" },
});

function subscribeVisibility(listener: () => void) {
    document.addEventListener("visibilitychange", listener);
    return () => document.removeEventListener("visibilitychange", listener);
}

export function QuestionNotices() {
    return useQuestionNotices().map((notice) => <QuestionNotice key={notice.id} notice={notice} />);
}

function QuestionNotice({ notice }: { notice: Notice }) {
    const [hovered, setHovered] = useState(false);
    const [focused, setFocused] = useState(false);
    const visible = useSyncExternalStore(subscribeVisibility, () => document.visibilityState === "visible", () => true);
    // 가리키거나 포커스했거나 탭이 숨겨진 동안은 시간을 멈춘다.
    const paused = hovered || focused || !visible;
    const left = useRef(DURATION);
    useEffect(() => {
        if (paused) return;
        const started = performance.now();
        const timer = window.setTimeout(() => dismissQuestionNotice(notice.id), left.current);
        return () => {
            window.clearTimeout(timer);
            left.current = Math.max(0, left.current - (performance.now() - started));
        };
    }, [paused, notice.id]);
    const label = `질문 · ${notice.text}`;
    return <div {...stylex.props(noticeStyles.interactive, styles.frame)} data-testid="question-notice"
        onPointerEnter={() => setHovered(true)} onPointerLeave={() => setHovered(false)}
        onFocus={() => setFocused(true)}
        onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocused(false); }}>
        <Banner status="warning" role="status" icon={<Icon name="help" />}
            isDismissable dismissLabel="질문 알림 닫기" onDismiss={() => dismissQuestionNotice(notice.id)}
            title={<Button type="button" appearance="link" xstyle={styles.open} title={label}
                onClick={() => { dismissQuestionNotice(notice.id); requestOpenSession(notice.projectId, notice.sessionId); }}>
                <span {...stylex.props(styles.text)}>{label}</span>
            </Button>} />
        <div aria-hidden="true" data-testid="question-notice-timer" {...stylex.props(styles.bar, paused && styles.paused)} />
    </div>;
}
