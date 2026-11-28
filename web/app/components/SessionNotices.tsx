import { Banner } from "@astryxdesign/core/Banner";
import * as stylex from "@stylexjs/stylex";
import { Button } from "../design/Button";
import { TimedNotice } from "../design/TimedNotice";
import { requestOpenSession } from "../state/attention";
import { usePrefs } from "../state/device";
import { dismissSessionNotice, useSessionNotices, type SessionNotice } from "../state/sessionNotices";
import { Icon } from "./icons";

const styles = stylex.create({
    open: { color: "inherit", minWidth: 0, maxWidth: "100%" },
    text: { display: "block", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
});

const KINDS = {
    question: { tone: "warning", icon: "help", name: "질문", seconds: "noticeQuestionSeconds" },
    done: { tone: "success", icon: "check", name: "완료", seconds: "noticeDoneSeconds" },
} as const;

export function SessionNotices() {
    const prefs = usePrefs("noticeQuestionSeconds", "noticeDoneSeconds");
    return useSessionNotices().map((notice) => {
        const seconds = prefs[KINDS[notice.kind].seconds];
        return seconds ? <Notice key={notice.id} notice={notice} seconds={seconds} /> : null;
    });
}

function Notice({ notice, seconds }: { notice: SessionNotice; seconds: number }) {
    const { tone, icon, name } = KINDS[notice.kind];
    const label = `${name} · ${notice.text}`;
    return <TimedNotice tone={tone} seconds={seconds} onExpire={() => dismissSessionNotice(notice.id)}
        data-testid={`${notice.kind}-notice`} timerTestId={`${notice.kind}-notice-timer`}>
        <Banner status={tone} role="status" icon={<Icon name={icon} />}
            isDismissable dismissLabel={`${name} 알림 닫기`} onDismiss={() => dismissSessionNotice(notice.id)}
            title={<Button type="button" appearance="link" xstyle={styles.open} title={label}
                onClick={() => { dismissSessionNotice(notice.id); requestOpenSession(notice.projectId, notice.sessionId); }}>
                <span {...stylex.props(styles.text)}>{label}</span>
            </Button>} />
    </TimedNotice>;
}
