import { useRef, useState } from "react";
import { ApiError, api, newKey } from "../api/client";
import { useQuery } from "../state/store";

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
    return <div className="stack" data-testid="memories-panel">
        <p className="muted small">다음 요청부터 모델에 전달됩니다. 비밀정보는 넣지 마세요.</p>
        <p className="muted small">삭제해도 과거 모델 요청·대화 사본·백업을 소급 삭제하지 않습니다.</p>
        {!!query.error && <p className="err" role="alert">{query.error instanceof Error ? query.error.message : "기억 조회 실패"}</p>}
        <ul>
            {(query.data?.items ?? []).map((memory) => <li key={memory.id} data-testid="memory-row">
                <p className="small">적용: {scopeName(memory.project_id)} · 출처: 사용자 직접 입력{memory.source_session_id ? ` · 대화 ${memory.source_session_id}` : ""}</p>
                <div className="text">{memory.body}</div>
                <button type="button" className="ghost small" disabled={blocked || !!deleting || !!editing || !!body} onClick={() => { setEditing(memory); setBody(memory.body); setError(null); }}>기억 수정</button>
                <button type="button" className="ghost small" disabled={blocked || !!deleting || !!editing || !!body} onClick={() => { setDeleting(memory); setError(null); }}>기억 삭제 확인</button>
            </li>)}
        </ul>
        {deleting ? <div role="group" aria-label="기억 삭제 확인">
            <p>삭제 대상: {scopeName(deleting.project_id)} · revision {deleting.revision}</p>
            <div className="text">{deleting.body}</div>
            <button type="button" disabled={blocked} onClick={() => void mutate({
                method: "post", path: `/memories/${deleting.id}/delete`, key: newKey(),
                body: { expected_revision: deleting.revision, confirmed: true },
            })}>이 기억 삭제</button>
            <button type="button" className="ghost" disabled={blocked} onClick={() => setDeleting(null)}>삭제 취소</button>
        </div> : <form className="stack" onSubmit={(event) => { event.preventDefault(); submit(); }}>
            {editing ? <p className="small">수정 대상: {scopeName(editing.project_id)} · revision {editing.revision}</p>
                : <label>기억 적용 범위<select aria-label="기억 적용 범위" value={scope} disabled={blocked} onChange={(e) => setScope(e.target.value)}>
                    <option value="global">전역(모든 프로젝트)</option>
                    {projectId && <option value="project">프로젝트 “{projectName ?? projectId}”</option>}
                </select></label>}
            <label>확인한 기억 내용<textarea rows={3} aria-label="확인한 기억 내용" value={body} disabled={blocked} onChange={(e) => setBody(e.target.value)} /></label>
            <div className="inline">
                <button type="submit" disabled={blocked || !body.trim()}>확인하고 기억 저장</button>
                {editing && <button type="button" className="ghost" disabled={blocked} onClick={() => { setEditing(null); setBody(""); }}>수정 취소</button>}
                {editing && current && current.revision !== editing.revision && <button type="button" className="ghost" disabled={blocked}
                    onClick={() => { setEditing(current); setBody(current.body); setError(null); }}>최신 기억 사용</button>}
            </div>
            {editing && current && current.revision !== editing.revision && <p className="warn" role="status">다른 기기에서 먼저 바뀌었습니다. 내 초안·기존 revision을 보존했습니다.</p>}
        </form>}
        {mutation.phase === "sending" && <p role="status">기억 요청 처리·결과 확인 중…</p>}
        {mutation.phase === "unknown" && <div role="group" aria-label="기억 결과 재확인">
            <p className="warn">결과 불명입니다. 자동으로 새 요청을 보내지 않습니다. 원래 내용·범위·revision·같은 키로만 확인합니다.</p>
            <button type="button" onClick={() => void mutate(mutation.attempt)}>같은 기억 요청 확인</button>
        </div>}
        {error && <p className="err" role="alert">{error}</p>}
    </div>;
}
