import { Banner } from "@astryxdesign/core/Banner";
import * as stylex from "@stylexjs/stylex";
import { Button } from "../design/Button";
import { TimedNotice } from "../design/TimedNotice";
import { requestOpenSession } from "../state/attention";
import { dismissQuestionNotice, useQuestionNotices, type QuestionNotice as Notice } from "../state/questionNotices";
import { Icon } from "./icons";

const styles = stylex.create({
    open: { color: "inherit", minWidth: 0, maxWidth: "100%" },
    text: { display: "block", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
});

export function QuestionNotices() {
    return useQuestionNotices().map((notice) => <QuestionNotice key={notice.id} notice={notice} />);
}

function QuestionNotice({ notice }: { notice: Notice }) {
    const label = `질문 · ${notice.text}`;
    return <TimedNotice tone="warning" onExpire={() => dismissQuestionNotice(notice.id)}
        data-testid="question-notice" timerTestId="question-notice-timer">
        <Banner status="warning" role="status" icon={<Icon name="help" />}
            isDismissable dismissLabel="질문 알림 닫기" onDismiss={() => dismissQuestionNotice(notice.id)}
            title={<Button type="button" appearance="link" xstyle={styles.open} title={label}
                onClick={() => { dismissQuestionNotice(notice.id); requestOpenSession(notice.projectId, notice.sessionId); }}>
                <span {...stylex.props(styles.text)}>{label}</span>
            </Button>} />
    </TimedNotice>;
}
