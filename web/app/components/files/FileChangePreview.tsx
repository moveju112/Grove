import { Stack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { ApiError, api } from "../../api/client";
import type { FileContent } from "../../api/generated";
import { useQuery } from "../../state/store";
import { CodeBlock } from "../../design/CodeBlock";
import { LoadingBar } from "../LoadingScreen";
import { addedFileDiff } from "./addedFileDiff";

export function FileChangePreview({ projectId, path, untracked, fingerprint, content }: {
    projectId: string; path: string; untracked: boolean; fingerprint?: string; content?: FileContent;
}) {
    const query = useQuery(untracked ? null : `git:${projectId}:preview-diff:${path}:${fingerprint}`, () =>
        Promise.all([false, true].map(async staged => {
            const result = await api.get<{ diff: string }>(`/projects/${projectId}/git/diff?staged=${staged}&path=${encodeURIComponent(path)}`);
            return { label: staged ? "커밋할 변경" : "작업 트리 변경", text: result.diff };
        })));
    if (!untracked && query.error) return <Text color="error" role="alert">{query.error instanceof ApiError ? query.error.message : "변경점을 읽지 못했어요."}</Text>;
    if (untracked && content?.text == null) return <Text color="secondary">새 파일의 변경점을 표시할 수 없어요.</Text>;
    const patches = untracked ? [{ label: "새 파일", text: addedFileDiff(path, content!.text!) }] : query.data?.filter(p => p.text);
    if (!patches) return <LoadingBar label="변경점 불러오는 중…" />;
    if (!patches.length) return <Text color="secondary">표시할 변경 내용이 없어요.</Text>;
    return <Stack gap={2}>{patches.map(patch => <CodeBlock key={patch.label} title={patch.label} code={patch.text}
        data-testid="file-diff" language="plaintext" isDiff isWrapped={false} maxHeight="60dvh" />)}</Stack>;
}
