import { Stack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { List, ListItem } from "@astryxdesign/core/List";
import { DetailDialog } from "./ui/Controls";
import { Markdown } from "./Markdown";
import { When } from "./When";

export type ResponseContent = {
    text?: string;
    response_parts?: string[];
    response_part_times?: (string | null)[];
    response_steers?: [followupId: string, partsBefore: number][];
    tool_calls?: unknown[];
    pending_work?: unknown;
};

const NO_PRIOR: readonly ResponseContent[] = [];

// CLI의 개별 응답 경계만 사용한다. 문장 내용으로 추론이나 답변을 추측하지 않는다.
export function splitResponse(content: ResponseContent) {
    const { progress, answer } = responseEntries(content);
    return { progress: progress.map((part) => part.text), answer: answer?.text ?? "" };
}

function responseEntries(content: ResponseContent) {
    const parts = content.response_parts;
    const entries = (parts?.length ? parts : [content.text ?? ""]).map((text, i) => ({ text, at: content.response_part_times?.[i] }));
    const answer = content.tool_calls?.length || content.pending_work ? undefined : entries.pop();
    return { progress: entries.filter((part) => part.text.trim()), answer };
}

export function foldResponseEntries(content: ResponseContent, prior: readonly ResponseContent[] = NO_PRIOR) {
    const { progress, answer } = responseEntries(content);
    return {
        progress: [...prior.flatMap((step) => {
            const previous = responseEntries(step);
            return previous.answer?.text.trim() ? [...previous.progress, previous.answer] : previous.progress;
        }), ...progress],
        answer: answer?.text ?? "",
    };
}

export function foldResponse(content: ResponseContent, prior: readonly ResponseContent[] = NO_PRIOR) {
    const { progress, answer } = foldResponseEntries(content, prior);
    return { progress: progress.map((part) => part.text), answer };
}

export function AssistantResponse({ content, prior, live = false, showProgress = true, progressOpen = live, progressActive = live, progressStart = 1 }: {
    content: ResponseContent; prior?: readonly ResponseContent[]; live?: boolean; showProgress?: boolean; progressOpen?: boolean; progressActive?: boolean; progressStart?: number;
}) {
    const { progress, answer } = foldResponseEntries(content, prior);
    const prefix = live ? "partial" : "msg";
    return <Stack gap={2} width="100%" maxWidth="100%">
        {showProgress && progress.length > 0 && <DetailDialog key={`progress-${progressOpen}`} data-testid={`${prefix}-progress`}
            label="진행 설명" inline={progressOpen} title="진행 설명">
            <List density="compact" edge="flush" listStyle="decimal" start={progressStart} aria-label="진행 설명 순서">
                {progress.map(({ text, at }, index) => <ListItem key={index} align="first-line" data-testid="progress-step"
                    label={<Markdown text={text} />} endContent={!progressActive && at && <Text type="supporting" color="secondary">
                        <When at={at} absolute part="time" titlePart="datetime" />
                    </Text>} />)}
            </List>
        </DetailDialog>}
        {answer && <Stack gap={1} width="100%" maxWidth="100%" data-testid={`${prefix}-answer`}>
            <Text display="block" type="supporting" color="secondary">{live ? "응답 중" : "답변"}</Text>
            <Markdown text={answer} />
        </Stack>}
    </Stack>;
}
