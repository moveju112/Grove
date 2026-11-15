import { Stack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { contentStyles } from "../design/content.stylex";
import type { Prefs } from "../state/device";
import { DetailDialog } from "./ui/Controls";
import { Markdown } from "./Markdown";

export type ResponseContent = {
    text?: string;
    response_parts?: string[];
    reasoning?: string | null;
    reasoning_chars?: number;
    tool_calls?: unknown[];
    pending_work?: unknown;
};

// CLI의 개별 응답 경계만 사용한다. 문장 내용으로 추론이나 답변을 추측하지 않는다.
export function splitResponse(content: ResponseContent) {
    const parts = content.response_parts;
    if (content.tool_calls?.length || content.pending_work) return { progress: content.text ?? "", answer: "" };
    return parts?.length ? { progress: parts.slice(0, -1).join("\n\n"), answer: parts.at(-1)! }
        : { progress: "", answer: content.text ?? "" };
}

export function AssistantResponse({ content, mode, live = false, answered = false }: {
    content: ResponseContent; mode: Prefs["reasoning"]; live?: boolean; answered?: boolean;
}) {
    const { progress, answer } = splitResponse(content);
    const inline = mode === "expanded" || !(answered || answer.trim());
    const reasoning = content.reasoning;
    const count = content.reasoning_chars ?? [...(reasoning ?? "")].length;
    const prefix = live ? "partial" : "msg";
    return <Stack gap={2} width="100%" maxWidth="100%">
        {mode !== "hidden" && reasoning && <DetailDialog key={`reasoning-${inline}`} data-testid={`${prefix}-reasoning`}
            label="추론" inline={inline} title={`추론 · ${count}자${count > [...reasoning].length ? " (앞부분만 표시)" : ""}`}>
            <Text as="div" display="block" type="supporting" color="secondary" xstyle={contentStyles.plainText}>{reasoning}</Text>
        </DetailDialog>}
        {mode !== "hidden" && progress && <DetailDialog key={`progress-${inline}`} data-testid={`${prefix}-progress`}
            label="진행 설명" inline={inline} title="진행 설명">
            <Markdown text={progress} />
        </DetailDialog>}
        {answer && <Stack gap={1} width="100%" maxWidth="100%" data-testid={`${prefix}-answer`}>
            <Text display="block" type="supporting" color="secondary">{live ? "응답 중" : "답변"}</Text>
            {live ? <Text as="div" display="block" type="inherit" color="inherit" xstyle={contentStyles.plainText}>{answer}</Text>
                : <Markdown text={answer} />}
        </Stack>}
    </Stack>;
}
