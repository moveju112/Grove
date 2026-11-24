import { useEffect, useId, useState, type ReactNode } from "react";
import * as stylex from "@stylexjs/stylex";
import { Stack } from "@astryxdesign/core/Stack";
import { Heading } from "@astryxdesign/core/Heading";
import { Tab, TabList } from "@astryxdesign/core/TabList";
import { Text } from "@astryxdesign/core/Text";
import { ApiError, api } from "../../api/client";
import type { FileContent, GitEntry } from "../../api/generated";
import { useQuery } from "../../state/store";
import { Button } from "../../design/Button";
import { contentStyles } from "../../design/content.stylex";
import { Icon } from "../icons";
import { LoadingBar } from "../LoadingScreen";
import { CreationDialog } from "../create/CreationDialog";
import { FileChangePreview } from "./FileChangePreview";

type Props = { projectId: string; path: string; onOpen: () => void; onClose: () => void; renderMarkdown: (text: string) => ReactNode };

export function FilePreviewDialog({ projectId, path, onOpen, onClose, renderMarkdown }: Props) {
    const [tab, setTab] = useState("body");
    const panelId = useId();
    const base = `/projects/${projectId}`;
    const file = useQuery(`files:${projectId}:preview:${path}`, () =>
        api.get<FileContent>(`${base}/files/content?path=${encodeURIComponent(path)}`));
    const status = useQuery(`git:${projectId}:preview-status`, () =>
        api.get<{ is_repo: boolean; entries?: GitEntry[]; fingerprint?: string }>(`${base}/git/status`));
    useEffect(() => {
        if (file.data || file.error) file.reload();
        if (status.data || status.error) status.reload();
    }, [projectId, path]); // eslint-disable-line react-hooks/exhaustive-deps
    const entry = status.data?.is_repo && !status.error ? status.data.entries?.find(e => e.path === path || e.orig_path === path) : undefined;
    const showChanges = !!entry && tab === "changes";
    const content = file.error ? undefined : file.data;
    const missing = file.error instanceof ApiError && file.error.code === "not_found";
    let body: ReactNode;
    if (file.error) {
        body = <Text role="alert" color={missing ? "secondary" : "error"}>{missing ? "이 경로에서 파일을 찾을 수 없어요."
            : file.error instanceof ApiError ? file.error.message : "파일을 읽지 못했어요."}</Text>;
    } else if (!content) {
        body = <LoadingBar label="파일 여는 중…" />;
    } else if (content.text === null || content.text === "") {
        body = <Text color="secondary">{content.text === "" ? "빈 파일이에요." : content.reason === "too_large"
            ? "파일이 커서 본문을 표시할 수 없어요." : "텍스트로 표시할 수 없는 파일이에요."}</Text>;
    } else {
        body = /\.(md|markdown)$/i.test(path) ? renderMarkdown(content.text)
            : <pre {...stylex.props(contentStyles.plainText)}>{content.text}</pre>;
    }
    return <CreationDialog label={`${path} 미리보기`} onClose={onClose} width="64em">
        <Stack as="header" direction="horizontal" align="center" gap={2}>
            <Icon name="file" />
            <Stack gap={0} xstyle={contentStyles.previewTitle}>
                <Heading level={2}>{path.split("/").pop()}</Heading>
                <Text type="supporting" color="secondary">{path}</Text>
            </Stack>
            {content && <Button variant="secondary" density="compact" disabled={file.loading} onClick={onOpen}>편집기에서 열기</Button>}
            <Button appearance="icon" aria-label="닫기" onClick={onClose}><Icon name="close" /></Button>
        </Stack>
        {entry && <TabList value={showChanges ? "changes" : "body"} onChange={setTab} role="tablist" aria-label="파일 보기" hasDivider>
            <Tab value="body" label="본문" panelId={panelId} /><Tab value="changes" label="변경점" panelId={panelId} />
        </TabList>}
        <Stack id={panelId} role={entry ? "tabpanel" : undefined} aria-label={showChanges ? "변경점" : "본문"}
            gap={3} padding={4} xstyle={[contentStyles.previewBody, !!content?.text && contentStyles.previewDocument]}>
            {showChanges ? <FileChangePreview projectId={projectId} path={entry.path} untracked={entry.kind === "untracked"}
                fingerprint={status.data?.fingerprint} content={content} /> : body}
            {!!status.error && <Text type="supporting" color="error" role="alert">변경점을 확인하지 못했어요.</Text>}
        </Stack>
    </CreationDialog>;
}
