import { Text as GroveText } from "@astryxdesign/core/Text";
import { Button as GroveButton } from "../../design/Button";
import { useRef, useState } from "react";
import { DetailDialog } from "../ui/Controls";
import { BooleanSelect } from "../BooleanSelect";
import { TextInput, TextArea } from "../../design/Fields";
import { ApiError, api, newKey } from "../../api/client";
import { hookPath, hookUpdate, type Hook, type HookDefinition, type HookListing } from "../../api/hooks";
import { useQuery } from "../../state/store";
import { HookExecutions } from "./HookExecutions";
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
        <GroveText as="p" display="block" type="inherit" color="secondary">저장·활성화와 별도로 각 실행 요청에서 승인하세요.</GroveText>
        <GroveText as="p" display="block" type="inherit" color="inherit" className="scope">실행 지원: {query.data?.supported_events?.join(", ") || "없음"}</GroveText>
        <GroveText as="p" display="block" type="supporting" color="secondary">연결이 종료돼도 취소되지 않으니 실행 요청에서 취소·결과를 확인하세요.</GroveText>
        <DetailDialog label="Hook 이벤트·패턴 도움말" title="이벤트·패턴 도움말">
        <GroveText as="p" display="block" type="inherit" color="inherit">matcher: glob · *는 모든 대상, ?는 한 글자</GroveText>
        <GroveText as="p" display="block" type="supporting" color="secondary">PostToolUse는 도구 이름, 다른 지원 이벤트는 대화 ID에 matcher를 적용합니다.
            SessionStart는 직접 대화 생성, UserPromptSubmit은 직접 턴·메시지 접수, Stop은 Grove 턴 종료에 연결됩니다.
            분기·자식/봇 세션 생성, followup/steer 접수와 모델 내부 도구 이벤트는 미연결입니다.</GroveText>
        </DetailDialog>
        {query.loading && <GroveText as="p" display="block" type="inherit" color="inherit" role="status">hook 목록 불러오는 중</GroveText>}
        {!!query.error && <GroveText as="p" display="block" type="inherit" color="inherit" role="alert">{query.error instanceof Error ? query.error.message : "hook 조회 실패"}</GroveText>}
        {error && <GroveText as="p" display="block" type="inherit" color="inherit" role="alert">{error}</GroveText>}
        {mutation.phase === "unknown" && <div role="status">
            저장 결과 불명 · 범위를 바꾸거나 새로 저장하기 전에 같은 요청을 확인하세요.
            <ServerActionButton onClick={() => void mutate(mutation.attempt)}>같은 hook 요청 확인</ServerActionButton>
        </div>}
        {query.data?.hooks.map((hook) => <article className="setting" key={hook.id} data-testid="hook-row">
            <strong>{hook.name}</strong>
            <GroveText as="p" display="block" type="inherit" color="inherit">{hook.event} · matcher <code>{hook.matcher}</code> · {hook.enabled ? "활성 설정" : "비활성 설정"} · revision {hook.revision}</GroveText>
            <GroveText as="p" display="block" type="inherit" color="inherit">{hook.execution_state === "approval_required" ? "이벤트 발생 후 개별 승인 필요" : "아직 실행되지 않음 · 미지원 이벤트 또는 플랫폼"}</GroveText>
            <pre>{hook.command}</pre>
            {hook.command_redacted && <GroveText as="p" display="block" type="inherit" color="secondary">비밀값 징후가 있어 명령 전체를 가렸습니다.</GroveText>}
            <GroveButton disabled={blocked || !!deleting} onClick={() => edit(hook)}>hook 편집</GroveButton>
            <ServerActionButton disabled={blocked || !!editing || !!deleting} onClick={() => void mutate({
                method: "put", path: hookPath(projectId, hook.id), key: newKey(),
                body: hookUpdate(hook, { ...hook, enabled: !hook.enabled }, false),
            })}>{hook.enabled ? "hook 비활성화" : "hook 활성화"}</ServerActionButton>
            <GroveButton disabled={blocked || !!editing || !!deleting} onClick={() => setDeleting(hook)}>hook 삭제 확인</GroveButton>
        </article>)}
        {query.data?.hooks.length === 0 && <GroveText as="p" display="block" type="inherit" color="inherit">저장한 hook이 없습니다.</GroveText>}
        {deleting && <div role="group" aria-label="hook 삭제">
            <GroveText as="p" display="block" type="inherit" color="inherit">“{deleting.name}” 설정을 삭제할까요?</GroveText>
            <ServerActionButton disabled={blocked} onClick={() => void mutate({
                method: "del", path: hookPath(projectId, deleting.id, deleting.revision), key: newKey(),
            })}>이 hook 삭제</ServerActionButton>
            <GroveButton disabled={blocked} onClick={() => setDeleting(null)}>hook 삭제 취소</GroveButton>
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
                <TextInput label="hook 이름" isRequired value={draft.name} onChange={(value) => setDraft({ ...draft, name: value })} />
                <label>hook 이벤트<select aria-label="hook 이벤트" value={event} onChange={(e) => setDraft({ ...draft, event: e.target.value })}>
                    {query.data?.events.map((value) => <option key={value}>{value}</option>)}
                </select></label>
                <TextInput label="hook matcher (glob)" aria-label="hook matcher" isRequired value={draft.matcher} onChange={(value) => setDraft({ ...draft, matcher: value })} />
                {editing && <BooleanSelect label="명령 교체" value={replaceCommand} onChange={setReplaceCommand}
                    disabled={blocked || !!deleting || !query.data || !!query.error} />}
                <TextArea label="hook 명령" autoComplete="off" hasSpellCheck={false}
                    isDisabled={!!editing && !replaceCommand} isRequired={!editing || replaceCommand} value={draft.command}
                    placeholder={editing ? "비워 두면 저장된 원문 유지" : "이벤트 발생 후 승인한 계획만 실행합니다"}
                    onChange={(value) => setDraft({ ...draft, command: value })} />
                <BooleanSelect label="hook 활성 설정 (별도 승인 필요)" value={draft.enabled} onChange={(value) => setDraft({ ...draft, enabled: value })}
                    disabled={blocked || !!deleting || !query.data || !!query.error} />
                {editing && <GroveText as="p" display="block" type="inherit" color="inherit">revision {editing.revision} 기준으로 수정합니다.</GroveText>}
                {editing && current?.revision !== editing.revision && <GroveText as="p" display="block" type="inherit" color="inherit" role="status">
                    설정이 변경됐으니 보존된 입력과 최신 값을 비교하세요.
                    {current && <GroveButton type="button" onClick={() => edit(current)}>최신 hook 설정 사용</GroveButton>}
                </GroveText>}
                <ServerActionButton type="submit">hook 설정 저장</ServerActionButton>
                {editing && <GroveButton type="button" onClick={reset}>hook 편집 취소</GroveButton>}
            </fieldset>
        </form>
        <HookExecutions projectId={projectId} />
    </div>;
}
