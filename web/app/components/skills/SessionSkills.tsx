import { useEffect, useRef, useState } from "react";
import { ApiError, authGeneration, isLoggedIn, newKey, onAuthChange } from "../../api/client";
import { skillsApi, type SessionSkills as Snapshot, type SkillBody, type SkillMutation, type SkillSelection } from "../../api/skills";
import { SkillsPanel } from "./SkillsPanel";
import { SkillEditor, type SkillDraft } from "./SkillEditor";

type Intent = { kind: "select"; selection: SkillSelection; selected: boolean; key: string }
    | { kind: "manage"; body: SkillMutation; key: string };
type State = {
    owner: number;
    snapshot: Snapshot | null;
    preview: SkillBody | null;
    draft: SkillDraft | null;
    loading: boolean;
    error: string | null;
    pending: Intent | null;
};
const initial = (): State => ({ owner: authGeneration(), snapshot: null, preview: null, draft: null, loading: true, error: null, pending: null });

export function uncertainSkillResult(e: unknown): boolean {
    return !(e instanceof ApiError) || e.status === 0 || e.status >= 500 || e.code === "result_unknown"
        || e.code === "request_timeout" || e.code === "cancelled";
}

// session/project가 바뀌면 Composer의 key로 재생성한다. 응답 순서와 인증 epoch도 별도로 확인한다.
function ConnectedSkills({ sessionId }: { sessionId: string }) {
    const [state, setState] = useState(initial);
    const sequence = useRef(0);
    const controller = useRef<AbortController | null>(null);
    const mutation = useRef(false);
    const active = state.owner === authGeneration() && isLoggedIn();
    const begin = () => {
        controller.current?.abort();
        controller.current = new AbortController();
        const ticket = ++sequence.current;
        const owner = authGeneration();
        return { signal: controller.current.signal, current: () => ticket === sequence.current && owner === authGeneration() && isLoggedIn() };
    };
    const reload = async () => {
        if (mutation.current) return;
        const request = begin();
        // 초안·pending·저장된 선택은 그대로 두고 현재 파일/상태만 관측한다.
        setState((s) => ({ ...s, loading: true, preview: null, error: null }));
        try {
            const snapshot = await skillsApi.list(sessionId, request.signal);
            if (request.current()) setState((s) => ({ ...s, owner: authGeneration(), snapshot, loading: false }));
        } catch (e) {
            if (request.current()) setState((s) => ({ ...s, loading: false, error: e instanceof Error ? e.message : "스킬 조회 실패" }));
        }
    };
    useEffect(() => {
        const owner = authGeneration();
        void reload();
        const unsubscribe = onAuthChange(() => {
            if (owner === authGeneration() && isLoggedIn()) return;
            ++sequence.current;
            controller.current?.abort();
            setState(initial());
        });
        return () => { unsubscribe(); ++sequence.current; controller.current?.abort(); };
    }, [sessionId]); // eslint-disable-line react-hooks/exhaustive-deps

    const inspect = async (selection: SkillSelection) => {
        if (mutation.current) return;
        const request = begin();
        setState((s) => ({ ...s, loading: true, preview: null, error: null }));
        try {
            const preview = await skillsApi.inspect(sessionId, selection, request.signal);
            if (request.current()) setState((s) => ({ ...s, preview, loading: false }));
        } catch (e) {
            if (request.current()) setState((s) => ({ ...s, loading: false, error: e instanceof Error ? e.message : "스킬 본문 조회 실패" }));
        }
    };
    const change = async (intent: Intent) => {
        if (mutation.current) return;
        mutation.current = true;
        const request = begin();
        setState((s) => ({ ...s, pending: intent, loading: true, preview: null, error: null }));
        try {
            if (intent.kind === "select") {
                await skillsApi.select(sessionId, intent.selection, intent.selected, intent.key, request.signal);
            } else {
                await skillsApi.manage(sessionId, intent.body, intent.key, request.signal);
            }
            if (!request.current()) return;
            // replay는 과거 응답일 수 있다. 성공 뒤 현재 catalog를 별도로 읽는다.
            setState((s) => ({ ...s, pending: null, draft: intent.kind === "manage" && intent.body.op !== "set_enabled" ? null : s.draft }));
            const snapshot = await skillsApi.list(sessionId, request.signal);
            if (request.current()) setState((s) => ({ ...s, snapshot, loading: false }));
        } catch (e) {
            if (request.current()) setState((s) => ({ ...s, loading: false, pending: uncertainSkillResult(e) ? intent : null,
                error: e instanceof Error ? e.message : "스킬 변경 결과를 확인하지 못했습니다" }));
        } finally { mutation.current = false; }
    };
    const snapshot = active ? state.snapshot : null;
    const busy = !active || state.loading || Boolean(state.pending);
    return <div className="stack" data-testid="session-skills">
        <div className="inline">
            <button type="button" className="ghost small" disabled={!active || state.loading} onClick={() => void reload()}>스킬 새로고침</button>
            <button type="button" className="ghost small" disabled={busy || Boolean(state.draft)}
                onClick={() => setState((s) => ({ ...s, draft: { kind: "add", scope: "project", name: "", text: "" } }))}>Grove 스킬 추가</button>
        </div>
        {active && state.pending && !state.loading && <div role="alert">
            변경 결과를 확인하지 못했습니다. 자동으로 다시 변경하지 않습니다.
            <button type="button" onClick={() => void change(state.pending!)}>같은 요청 결과 확인</button>
            <p>스킬 새로고침으로 현재 상태를 관측할 수 있습니다. 결과 불명 receipt는 재실행되지 않습니다.</p>
            <button type="button" onClick={() => setState((s) => ({ ...s, pending: null, error: null, snapshot: null, preview: null }))}>
                불명 요청 닫기 · 다시 조회 필요
            </button>
        </div>}
        {snapshot?.validation_error && <p className="warn" role="alert">
            선택한 스킬을 적용할 수 없습니다: {snapshot.validation_error.message} ({snapshot.validation_error.code}).
            다음 모델 호출은 차단됩니다. 원래 선택을 해제하고 다시 확인하세요.
        </p>}
        {active && state.draft && <SkillEditor draft={state.draft} busy={busy || !snapshot}
            onChange={(draft) => setState((s) => ({ ...s, draft }))}
            onCancel={() => setState((s) => ({ ...s, draft: null }))}
            onSubmit={(body) => void change({ kind: "manage", body, key: newKey() })} />}
        <SkillsPanel listing={snapshot?.listing ?? null} selected={snapshot?.selected ?? []}
            preview={active ? state.preview : null} loading={!active || state.loading} busy={!active || Boolean(state.pending)}
            error={active ? state.error : null} onInspect={(selection) => void inspect(selection)}
            onSelect={(selection) => void change({ kind: "select", selection, selected: true, key: newKey() })}
            onDeselect={(selection) => void change({ kind: "select", selection, selected: false, key: newKey() })}
            onEdit={(body) => setState((s) => s.draft ? s : ({ ...s, draft: { kind: "save", selection: body.selection, text: body.text } }))}
            onSetEnabled={(selection, enabled) => void change({ kind: "manage", body: { op: "set_enabled", selection, enabled }, key: newKey() })} />
    </div>;
}

export function SessionSkills({ sessionId }: { sessionId: string }) {
    const [open, setOpen] = useState(false);
    return <details className="draft-note" data-testid="skills-disclosure" onToggle={(event) => setOpen(event.currentTarget.open)}>
        <summary>대화 스킬</summary>
        {open && <ConnectedSkills sessionId={sessionId} />}
    </details>;
}
