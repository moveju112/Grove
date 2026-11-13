import { useRef, useState } from "react";
import { ApiError, api, newKey } from "../../api/client";
import { hookPath, hookUpdate, type Hook, type HookDefinition, type HookListing } from "../../api/hooks";
import { useQuery } from "../../state/store";
import { ServerActionButton } from "../pwa/ServerActionButton";

type Attempt = { method: "post" | "put" | "del"; path: string; body?: unknown; key: string };
type Mutation = { phase: "idle" } | { phase: "sending" | "unknown"; attempt: Attempt };
const empty: HookDefinition = { name: "", event: "", matcher: "*", command: "", enabled: false };

// 범위 변경은 별도 인스턴스로 mount하여 이전 범위의 draft·revision을 가져오지 않는다.
export function HooksSettings({ projectId, projectName }: { projectId?: string; projectName?: string }) {
    const [scope, setScope] = useState<"global" | "project">("global");
    const [blocked, setBlocked] = useState(false);
    return <div className="stack" data-testid="hooks-settings">
        <label>hook 범위 <select aria-label="hook 범위" disabled={blocked} value={scope} onChange={(e) => setScope(e.target.value as "global" | "project")}>
            <option value="global">전역</option>
            {projectId && <option value="project">프로젝트 · {projectName ?? projectId}</option>}
        </select></label>
        <HooksEditor key={`${scope}:${projectId ?? ""}`} projectId={scope === "project" ? projectId : undefined} onBlocked={setBlocked} />
    </div>;
}

function HooksEditor({ projectId, onBlocked }: { projectId?: string; onBlocked: (blocked: boolean) => void }) {
    const query = useQuery<HookListing>(`hooks:${projectId ?? "global"}`, () => api.get(hookPath(projectId)));
    const [editing, setEditing] = useState<Hook | null>(null);
    const [deleting, setDeleting] = useState<Hook | null>(null);
    const [draft, setDraft] = useState<HookDefinition>(empty);
    const [replaceCommand, setReplaceCommand] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [mutation, setMutation] = useState<Mutation>({ phase: "idle" });
    const sending = useRef(false);
    const blocked = mutation.phase !== "idle";
    const reset = () => { setEditing(null); setDeleting(null); setDraft(empty); setReplaceCommand(false); };
    const mutate = async (attempt: Attempt) => {
        if (sending.current) return;
        sending.current = true;
        onBlocked(true);
        setMutation({ phase: "sending", attempt });
        setError(null);
        try {
            if (attempt.method === "del") await api.del(attempt.path, { key: attempt.key });
            else await api[attempt.method](attempt.path, attempt.body, { key: attempt.key });
            setMutation({ phase: "idle" });
            onBlocked(false);
            reset();
        } catch (e) {
            const unknown = !(e instanceof ApiError) || e.status >= 500 || e.status === 408
                || e.code === "result_unknown"
                || (e.details as { result_unknown?: boolean } | undefined)?.result_unknown === true;
            setMutation(unknown ? { phase: "unknown", attempt } : { phase: "idle" });
            onBlocked(unknown);
            // 서버 오류는 입력 원문을 반사하지 않는 표준 메시지만 제공한다.
            setError(e instanceof ApiError ? e.message : "hook 저장 결과를 확인할 수 없습니다");
        } finally {
            sending.current = false;
            query.reload();
        }
    };
    const edit = (hook: Hook) => {
        setEditing(hook); setDeleting(null); setError(null); setReplaceCommand(false);
        setDraft({ name: hook.name, event: hook.event, matcher: hook.matcher, enabled: hook.enabled, command: "" });
    };
    const current = query.data?.hooks.find((h) => h.id === editing?.id);
    const event = draft.event || query.data?.events[0] || "";
    return <div className="stack" data-testid="hooks-panel">
        <p className="muted">아직 실행되지 않음 · 활성화는 설정만 저장합니다. hook 실행 기능은 제공하지 않습니다.</p>
        <p className="muted small">matcher는 glob 문법입니다. *는 모든 대상, ?는 한 글자입니다. 정규식·셸 명령이 아닙니다.</p>
        {query.loading && <p role="status">hook 목록 불러오는 중</p>}
        {!!query.error && <p role="alert">{query.error instanceof Error ? query.error.message : "hook 조회 실패"}</p>}
        {error && <p role="alert">{error}</p>}
        {mutation.phase === "unknown" && <div role="status">
            저장 결과 불명 · 범위를 바꾸거나 새로 저장하기 전에 같은 요청을 확인하세요.
            <ServerActionButton onClick={() => void mutate(mutation.attempt)}>같은 hook 요청 확인</ServerActionButton>
        </div>}
        {query.data?.hooks.map((hook) => <article className="setting" key={hook.id} data-testid="hook-row">
            <strong>{hook.name}</strong>
            <p>{hook.event} · matcher <code>{hook.matcher}</code> · {hook.enabled ? "활성 설정" : "비활성 설정"} · revision {hook.revision}</p>
            <p>아직 실행되지 않음</p>
            <pre>{hook.command}</pre>
            {hook.command_redacted && <p className="muted">비밀값 징후가 있어 명령 전체를 가렸습니다.</p>}
            <button disabled={blocked || !!deleting} onClick={() => edit(hook)}>hook 편집</button>
            <ServerActionButton disabled={blocked || !!editing || !!deleting} onClick={() => void mutate({
                method: "put", path: hookPath(projectId, hook.id), key: newKey(),
                body: hookUpdate(hook, { ...hook, enabled: !hook.enabled }, false),
            })}>{hook.enabled ? "hook 비활성화" : "hook 활성화"}</ServerActionButton>
            <button disabled={blocked || !!editing || !!deleting} onClick={() => setDeleting(hook)}>hook 삭제 확인</button>
        </article>)}
        {query.data?.hooks.length === 0 && <p>저장한 hook이 없습니다.</p>}
        {deleting && <div role="group" aria-label="hook 삭제">
            <p>“{deleting.name}” 설정을 삭제할까요?</p>
            <ServerActionButton disabled={blocked} onClick={() => void mutate({
                method: "del", path: hookPath(projectId, deleting.id, deleting.revision), key: newKey(),
            })}>이 hook 삭제</ServerActionButton>
            <button disabled={blocked} onClick={() => setDeleting(null)}>hook 삭제 취소</button>
        </div>}
        <form onSubmit={(e) => {
            e.preventDefault();
            const definition = { ...draft, event };
            void mutate({
                method: editing ? "put" : "post", path: hookPath(projectId, editing?.id), key: newKey(),
                body: editing ? hookUpdate(editing, definition, replaceCommand) : definition,
            });
        }}>
            <fieldset disabled={blocked || !!deleting || !query.data || !!query.error}>
                <legend>{editing ? "hook 수정" : "hook 추가"}</legend>
                <label>hook 이름<input aria-label="hook 이름" required value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} /></label>
                <label>hook 이벤트<select aria-label="hook 이벤트" value={event} onChange={(e) => setDraft({ ...draft, event: e.target.value })}>
                    {query.data?.events.map((value) => <option key={value}>{value}</option>)}
                </select></label>
                <label>hook matcher<input aria-label="hook matcher" required value={draft.matcher} onChange={(e) => setDraft({ ...draft, matcher: e.target.value })} /></label>
                {editing && <label><input type="checkbox" checked={replaceCommand} onChange={(e) => setReplaceCommand(e.target.checked)} />명령 교체</label>}
                <label>hook 명령<textarea aria-label="hook 명령" autoComplete="off" spellCheck={false}
                    disabled={!!editing && !replaceCommand} required={!editing || replaceCommand} value={draft.command}
                    placeholder={editing ? "비워 두면 저장된 원문 유지" : "저장만 하며 실행하지 않습니다"}
                    onChange={(e) => setDraft({ ...draft, command: e.target.value })} /></label>
                <label><input type="checkbox" checked={draft.enabled} onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })} />hook 활성 설정 (실행 안 됨)</label>
                {editing && <p>revision {editing.revision} 기준으로 수정합니다.</p>}
                {editing && current?.revision !== editing.revision && <p role="status">
                    다른 요청으로 바뀌었습니다. 입력을 보존했으니 최신 설정을 확인하세요.
                    {current && <button type="button" onClick={() => edit(current)}>최신 hook 설정 사용</button>}
                </p>}
                <ServerActionButton type="submit">hook 설정 저장</ServerActionButton>
                {editing && <button type="button" onClick={reset}>hook 편집 취소</button>}
            </fieldset>
        </form>
    </div>;
}
