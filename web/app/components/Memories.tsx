import { useRef, useState } from "react";
import { ApiError, api, newKey } from "../api/client";
import { useQuery } from "../state/store";
import { TextArea } from "../design/Fields";
import { Select } from "../design/Select";
import { Button } from "../design/Button";
import { Stack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { List, ListItem } from "@astryxdesign/core/List";
import { SentenceText } from "./HelpTip";

type Memory = {
    id: string; project_id: string | null; body: string; revision: number;
    source: "direct_user"; source_session_id: string | null; updated_at: string;
};
type Attempt = { method: "post" | "put"; path: string; body: Record<string, unknown>; key: string };
type Mutation = { phase: "idle" } | { phase: "sending" | "unknown"; attempt: Attempt };

export function Memories({ projectId, projectName, sessionId }: { projectId?: string; projectName?: string; sessionId?: string }) {
    const query = useQuery<{ items: Memory[] }>(`memories:${projectId ?? "global"}`, () =>
        api.get(`/memories${projectId ? `?project_id=${projectId}` : ""}`));
    const [scope, setScope] = useState(projectId ? "project" : "global");
    const [body, setBody] = useState("");
    const [editing, setEditing] = useState<Memory | null>(null);
    const [deleting, setDeleting] = useState<Memory | null>(null);
    const [mutation, setMutation] = useState<Mutation>({ phase: "idle" });
    const [error, setError] = useState<string | null>(null);
    const sending = useRef(false);
    const blocked = mutation.phase !== "idle";
    const scopeName = (id: string | null) => id ? `프로젝트 “${projectName ?? id}”` : "전역(모든 프로젝트)";
    const current = query.data?.items.find((m) => m.id === editing?.id);
    const mutate = async (attempt: Attempt) => {
        if (sending.current) return;
        sending.current = true;
        setMutation({ phase: "sending", attempt });
        setError(null);
        try {
            await api[attempt.method](attempt.path, attempt.body, { key: attempt.key, requires: ["user_memories_v1"] });
            setMutation({ phase: "idle" });
            setBody("");
            setEditing(null);
            setDeleting(null);
        } catch (error) {
            const unknown = !(error instanceof ApiError) || error.status >= 500 || error.status === 408
                || (error.details as { result_unknown?: boolean } | undefined)?.result_unknown === true;
            setMutation(unknown ? { phase: "unknown", attempt } : { phase: "idle" });
            setError(error instanceof Error ? error.message : "기억 요청 결과를 확인하지 못했습니다");
        } finally {
            sending.current = false;
            query.reload();
        }
    };
    const submit = () => {
        if (blocked || deleting) return;
        void mutate({
            method: editing ? "put" : "post",
            path: editing ? `/memories/${editing.id}` : "/memories", key: newKey(),
            body: editing ? { body, expected_revision: editing.revision, confirmed: true }
                : { body, project_id: scope === "project" ? projectId : null, source_session_id: sessionId ?? null, confirmed: true },
        });
    };
    return <Stack gap={2} data-testid="memories-panel">
        <Text as="p" display="block" type="supporting" color="secondary">다음 요청부터 모델에 전달되니 비밀정보는 넣지 마세요.</Text>
        <Text as="p" display="block" type="supporting" color="secondary">삭제해도 과거 모델 요청·대화 사본·백업을 소급 삭제하지 않습니다.</Text>
        {!!query.error && <Text as="p" display="block" type="inherit" color="error" role="alert">{query.error instanceof Error ? query.error.message : "기억 조회 실패"}</Text>}
        <List density="compact" edge="flush">
            {(query.data?.items ?? []).map((memory) => <ListItem key={memory.id} data-testid="memory-row" label={<Stack gap={2}>
                <Text as="p" display="block" type="supporting" color="inherit">적용: {scopeName(memory.project_id)} · 출처: 사용자 직접 입력{memory.source_session_id ? ` · 대화 ${memory.source_session_id}` : ""}</Text>
                <Text as="div" display="block" type="inherit" color="inherit">{memory.body}</Text>
                <Stack direction="horizontal" wrap="wrap" gap={2}>
                    <Button type="button" variant="secondary" density="compact" disabled={blocked || !!deleting || !!editing || !!body} onClick={() => { setEditing(memory); setBody(memory.body); setError(null); }}>기억 수정</Button>
                    <Button type="button" variant="secondary" density="compact" disabled={blocked || !!deleting || !!editing || !!body} onClick={() => { setDeleting(memory); setError(null); }}>기억 삭제 확인</Button>
                </Stack>
            </Stack>} />)}
        </List>
        {deleting ? <Stack gap={2} role="group" aria-label="기억 삭제 확인">
            <Text as="p" display="block" type="inherit" color="inherit">삭제 대상: {scopeName(deleting.project_id)} · revision {deleting.revision}</Text>
            <Text as="div" display="block" type="inherit" color="inherit">{deleting.body}</Text>
            <Button type="button" disabled={blocked} onClick={() => void mutate({
                method: "post", path: `/memories/${deleting.id}/delete`, key: newKey(),
                body: { expected_revision: deleting.revision, confirmed: true },
            })}>이 기억 삭제</Button>
            <Button type="button" variant="secondary" disabled={blocked} onClick={() => setDeleting(null)}>삭제 취소</Button>
        </Stack> : <Stack as="form" gap={2} onSubmit={(event) => { event.preventDefault(); submit(); }}>
            {editing ? <Text as="p" display="block" type="supporting" color="inherit">수정 대상: {scopeName(editing.project_id)} · revision {editing.revision}</Text>
                : <Select label="기억 적용 범위" value={scope} disabled={blocked} onChange={setScope}
                    options={[{ value: "global", label: "전역(모든 프로젝트)" },
                        ...(projectId ? [{ value: "project", label: `프로젝트 “${projectName ?? projectId}”` }] : [])]} />}
            <TextArea rows={3} label="확인한 기억 내용" value={body} isDisabled={blocked} onChange={setBody} />
            <Stack direction="horizontal" wrap="wrap" gap={2}>
                <Button type="submit" disabled={blocked || !body.trim()}>확인하고 기억 저장</Button>
                {editing && <Button type="button" variant="secondary" disabled={blocked} onClick={() => { setEditing(null); setBody(""); }}>수정 취소</Button>}
                {editing && current && current.revision !== editing.revision && <Button type="button" variant="secondary" disabled={blocked}
                    onClick={() => { setEditing(current); setBody(current.body); setError(null); }}>최신 기억 사용</Button>}
            </Stack>
            {editing && current && current.revision !== editing.revision && <Text as="p" display="block" type="inherit" color="warning" role="status"><SentenceText text="다른 기기에서 먼저 바뀌었습니다. 내 초안·기존 revision을 보존했습니다." /></Text>}
        </Stack>}
        {mutation.phase === "sending" && <Text as="p" display="block" type="inherit" color="inherit" role="status">기억 요청 처리·결과 확인 중…</Text>}
        {mutation.phase === "unknown" && <Stack gap={2} role="group" aria-label="기억 결과 재확인">
            <Text as="p" display="block" type="inherit" color="warning"><SentenceText text="결과 불명입니다. 자동으로 새 요청을 보내지 않습니다. 원래 내용·범위·revision·같은 키로만 확인합니다." /></Text>
            <Button type="button" onClick={() => void mutate(mutation.attempt)}>같은 기억 요청 확인</Button>
        </Stack>}
        {error && <Text as="p" display="block" type="inherit" color="error" role="alert">{error}</Text>}
    </Stack>;
}
