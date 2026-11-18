import { Stack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { List, ListItem } from "@astryxdesign/core/List";
import { DetailDialog } from "./ui/Controls";
import { Markdown } from "./Markdown";

export type ResponseContent = {
    text?: string;
    response_parts?: string[];
    tool_calls?: unknown[];
    pending_work?: unknown;
};

const NO_PRIOR: readonly ResponseContent[] = [];

// CLI의 개별 응답 경계만 사용한다. 문장 내용으로 추론이나 답변을 추측하지 않는다.
export function splitResponse(content: ResponseContent) {
    const parts = content.response_parts;
    if (content.tool_calls?.length || content.pending_work) {
        return { progress: (parts?.length ? parts : [content.text ?? ""]).filter((part) => part.trim()), answer: "" };
    }
    return { progress: parts?.slice(0, -1).filter((part) => part.trim()) ?? [],
        answer: parts?.length ? parts.at(-1)! : content.text ?? "" };
}

export function foldResponse(content: ResponseContent, prior: readonly ResponseContent[] = NO_PRIOR) {
    const { progress, answer } = splitResponse(content);
    return {
        progress: [...prior.flatMap((step) => {
            const previous = splitResponse(step);
            return previous.answer.trim() ? [...previous.progress, previous.answer] : previous.progress;
        }), ...progress],
        answer,
    };
}

export function AssistantResponse({ content, prior, live = false, showProgress = true, progressOpen = live }: {
    content: ResponseContent; prior?: readonly ResponseContent[]; live?: boolean; showProgress?: boolean; progressOpen?: boolean;
}) {
    const { progress, answer } = foldResponse(content, prior);
    const prefix = live ? "partial" : "msg";
    return <Stack gap={2} width="100%" maxWidth="100%">
        {showProgress && progress.length > 0 && <DetailDialog key={`progress-${progressOpen}`} data-testid={`${prefix}-progress`}
            label="진행 설명" inline={progressOpen} title="진행 설명">
            <List density="compact" edge="flush" listStyle="decimal" aria-label="진행 설명 순서">
                {progress.map((part, index) => <ListItem key={index} align="first-line" data-testid="progress-step"
                    label={<Markdown text={part} />} />)}
            </List>
        </DetailDialog>}
        {answer && <Stack gap={1} width="100%" maxWidth="100%" data-testid={`${prefix}-answer`}>
            <Text display="block" type="supporting" color="secondary">{live ? "응답 중" : "답변"}</Text>
            <Markdown text={answer} />
        </Stack>}
    </Stack>;
}
