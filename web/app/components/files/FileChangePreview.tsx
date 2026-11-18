import { useEffect } from "react";
import { Stack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { ApiError, api } from "../../api/client";
import { useQuery } from "../../state/store";
import type { FileContent } from "../../state/fileWatch";
import { Button } from "../../design/Button";
import { CodeBlock } from "../../design/CodeBlock";
import { LoadingBar } from "../LoadingScreen";
import { addedFileDiff } from "./addedFileDiff";

type Preview = { notice?: string; patches: { label: string; text: string }[] };

// 기존 인증 Git 조회·파일 API만 사용한다. 클릭으로 stage·저장 같은 변경은 하지 않는다.
async function readChanges(projectId: string, path: string): Promise<Preview> {
    const base = `/projects/${projectId}`;
    const status = await api.get<{ is_repo: boolean; entries?: { path: string; kind: string }[] }>(`${base}/git/status`);
    if (!status.is_repo) return { notice: "Git 저장소가 아니어서 변경점을 비교할 수 없어요.", patches: [] };
    const entry = status.entries?.find((entry) => entry.path === path);
    if (entry?.kind === "untracked") {
        const content = await api.get<FileContent>(`${base}/files/content?path=${encodeURIComponent(path)}`);
        if (content.text === null) return { notice: content.reason === "too_large" ? "파일이 커서 변경점을 표시할 수 없어요." : "텍스트가 아닌 새 파일이에요.", patches: [] };
        return { patches: [{ label: "새 파일", text: addedFileDiff(path, content.text) }] };
    }
    const patches = await Promise.all([false, true].map(async (staged) => {
        const result = await api.get<{ diff: string }>(`${base}/git/diff?staged=${staged}&path=${encodeURIComponent(path)}`);
        return { label: staged ? "커밋할 변경" : "작업 트리 변경", text: result.diff };
    }));
    return { patches: patches.filter((patch) => patch.text), ...(patches.every((patch) => !patch.text) ? { notice: "현재 Git 변경점이 없어요." } : {}) };
}

export function FileChangePreview({ projectId, path, onOpen }: { projectId: string; path: string; onOpen: () => void }) {
    const query = useQuery<Preview>(`git:${projectId}:file-link:${path}`, () => readChanges(projectId, path));
    // 다시 누르면 외부 CLI가 바꾼 최신 파일도 확인한다. cache는 닫았다 열어도 유지한다.
    useEffect(() => { if (query.data) query.reload(); }, [projectId, path]); // eslint-disable-line react-hooks/exhaustive-deps
    return <Stack gap={2} maxWidth="100%" data-testid="file-change-preview">
        <Stack direction="horizontal" gap={2}>
            <Button variant="secondary" density="compact" onClick={onOpen}>파일 열기</Button>
            <Button variant="secondary" density="compact" disabled={query.loading} onClick={query.reload}>새로고침</Button>
        </Stack>
        {(query.loading || (!query.data && !query.error)) && <LoadingBar label="변경점 불러오는 중…" />}
        {!!query.error && <Text as="p" color="error" role="alert">{query.error instanceof ApiError ? query.error.message : "변경점을 불러오지 못했어요."}</Text>}
        {query.data?.notice && <Text as="p" color="secondary">{query.data.notice}</Text>}
        {query.data?.patches.map((patch) => <CodeBlock key={patch.label} title={patch.label} code={patch.text}
            data-testid="file-diff" language="plaintext" isDiff isWrapped={false} maxHeight="60dvh" />)}
    </Stack>;
}
