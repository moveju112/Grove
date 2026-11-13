import { useEffect, useRef, useState } from "react";
import { ApiError, authGeneration, isLoggedIn, newKey, onAuthChange } from "../../api/client";
import { skillsApi, type SessionSkills as Snapshot, type SkillBody, type SkillSelection } from "../../api/skills";
import { SkillsPanel } from "./SkillsPanel";

type Intent = { selection: SkillSelection; selected: boolean; key: string };
type State = {
    owner: number;
    snapshot: Snapshot | null;
    preview: SkillBody | null;
    loading: boolean;
    error: string | null;
    pending: Intent | null;
};
const initial = (): State => ({ owner: authGeneration(), snapshot: null, preview: null, loading: true, error: null, pending: null });

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
    const select = async (intent: Intent) => {
        if (mutation.current) return;
        mutation.current = true;
        const request = begin();
        setState((s) => ({ ...s, pending: intent, loading: true, preview: null, error: null }));
        try {
            await skillsApi.select(sessionId, intent.selection, intent.selected, intent.key, request.signal);
            if (!request.current()) return;
            // 재전송 응답은 저장된 과거 응답일 수 있으므로 항상 현재 서버 상태를 다시 조회한다.
            setState((s) => ({ ...s, pending: null }));
            const snapshot = await skillsApi.list(sessionId, request.signal);
            if (request.current()) setState((s) => ({ ...s, snapshot, loading: false }));
        } catch (e) {
            if (request.current()) {
                const unknown = !(e instanceof ApiError) || e.status === 0 || e.status >= 500;
                setState((s) => ({ ...s, loading: false, pending: unknown ? intent : null,
                    error: e instanceof Error ? e.message : "스킬 선택 결과를 확인하지 못했습니다" }));
            }
        } finally { mutation.current = false; }
    };
    const snapshot = active ? state.snapshot : null;
    return <div className="stack" data-testid="session-skills">
        <button type="button" className="ghost small" disabled={!active || state.loading || Boolean(state.pending)} onClick={() => void reload()}>스킬 새로고침</button>
        {active && state.pending && !state.loading && <div role="alert">
            선택 변경의 결과를 확인하지 못했습니다. 자동으로 다시 변경하지 않습니다.
            <button type="button" onClick={() => void select(state.pending!)}>같은 요청 결과 확인</button>
        </div>}
        {snapshot?.validation_error && <p className="warn" role="alert">
            선택한 스킬을 적용할 수 없습니다: {snapshot.validation_error.message} ({snapshot.validation_error.code}).
            다음 모델 호출은 차단됩니다. 원래 선택을 해제하고 다시 확인하세요.
        </p>}
        <SkillsPanel listing={snapshot?.listing ?? null} selected={snapshot?.selected ?? []}
            preview={active ? state.preview : null} loading={!active || state.loading} busy={!active || Boolean(state.pending)}
            error={active ? state.error : null} onInspect={(selection) => void inspect(selection)}
            onSelect={(selection) => void select({ selection, selected: true, key: newKey() })}
            onDeselect={(selection) => void select({ selection, selected: false, key: newKey() })} />
    </div>;
}

export function SessionSkills({ sessionId }: { sessionId: string }) {
    const [open, setOpen] = useState(false);
    return <details className="draft-note" data-testid="skills-disclosure" onToggle={(event) => setOpen(event.currentTarget.open)}>
        <summary>대화 스킬</summary>
        {open && <ConnectedSkills sessionId={sessionId} />}
    </details>;
}
