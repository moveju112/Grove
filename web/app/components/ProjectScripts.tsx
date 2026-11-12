import { useEffect, useRef, useState } from "react";
import { ApiError, api, authGeneration, isLoggedIn, newKey } from "../api/client";
import { useCapability } from "../state/capabilities";
import { useQuery } from "../state/store";
import { confirmRun, forgetRun, newRun, pendingRuns, subscribeScriptRuns, type Execution, type ProjectScript, type RunAttempt, type ScriptListing } from "../state/projectScripts";
import type { Opener } from "./Workspace";

type Editor = { id?: string; revision?: number; name: string; command: string };
type EditAttempt = { method: "post" | "put" | "del"; path: string; body?: object; key: string };
type Review = { script: ProjectScript; execution: Execution; projectName: string; actorId: string };

export function ProjectScripts({ projectId, projectName, open }: { projectId: string; projectName: string; open: Opener }) {
    const supported = useCapability("project_scripts_v1");
    const list = useQuery<ScriptListing>(supported === false ? null : `scripts:${projectId}`, () => api.get(`/projects/${projectId}/scripts`));
    const [editor, setEditor] = useState<Editor | null>(null);
    const [editAttempt, setEditAttempt] = useState<EditAttempt | null>(null);
    const [review, setReview] = useState<Review | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const working = useRef(false);
    const alive = useRef(true);
    const [owner] = useState(authGeneration);
    const active = () => owner === authGeneration() && isLoggedIn();
    const [pending, setPending] = useState<ReturnType<typeof pendingRuns>>([]);
    const refresh = () => {
        try { setPending(pendingRuns(localStorage, projectId)); }
        catch { setError("이 기기의 실행 요청 사본을 읽지 못했습니다. 새 실행 전에 저장 공간을 확인하세요."); }
    };
    useEffect(() => {
        alive.current = true;
        refresh();
        const unsubscribe = subscribeScriptRuns(refresh);
        const storage = () => refresh();
        window.addEventListener("storage", storage);
        return () => { alive.current = false; unsubscribe(); window.removeEventListener("storage", storage); };
    }, [projectId]); // eslint-disable-line react-hooks/exhaustive-deps

    const edit = async (attempt: EditAttempt) => {
        if (working.current) return;
        working.current = true;
        setBusy(true); setError(null); setEditAttempt(attempt);
        try {
            const options = { key: attempt.key, requires: ["project_scripts_v1"] };
            if (attempt.method === "del") await api.del(attempt.path, options);
            else await api[attempt.method](attempt.path, attempt.body, options);
            if (!alive.current || !active()) return;
            setEditor(null); setEditAttempt(null);
        } catch (error) {
            if (!alive.current || !active()) return;
            setError(error instanceof Error ? error.message : "script 저장 실패");
            if (error instanceof ApiError && error.status < 500 && !error.retryable && error.code !== "result_unknown") setEditAttempt(null);
        } finally {
            working.current = false;
            if (alive.current && active()) { setBusy(false); list.reload(); }
        }
    };
    const run = async (attempt: RunAttempt) => {
        if (working.current) return;
        working.current = true;
        setReview(null); setBusy(true); setError(null);
        try {
            const result = await confirmRun(localStorage, attempt, active);
            if (alive.current && active()) open({ kind: "session", project_id: projectId, resource_id: result.sessionId, title: `Script · ${attempt.script.name}` });
        } catch (error) {
            if (!alive.current || !active()) return;
            setError(error instanceof Error ? error.message : "응답을 받지 못했습니다. 원래 요청의 결과를 확인하세요.");
            if (error instanceof ApiError && error.status < 500 && !error.retryable && !["result_unknown", "actor_changed"].includes(error.code)) {
                forgetRun(localStorage, `grove.script.run.${projectId}.${attempt.taskKey}`);
            }
        } finally {
            working.current = false;
            if (alive.current && active()) { setBusy(false); refresh(); list.reload(); }
        }
    };
    const latest = async () => {
        try {
            const current = await api.get<ScriptListing>(`/projects/${projectId}/scripts`);
            if (!alive.current || !active()) return;
            const script = current.scripts.find((script) => script.id === editor?.id);
            if (!script) { setError("최신 목록에 이 script가 없습니다. 입력은 보존했습니다."); return; }
            setEditor({ ...script }); setError(null); list.reload();
        } catch (error) { if (alive.current && active()) setError(error instanceof Error ? error.message : "다시 읽기 실패"); }
    };
    if (supported === false) return null;
    const locked = busy || editAttempt !== null;
    return <details className="project-scripts" data-testid="project-scripts">
        <summary>프로젝트 script · {list.data?.scripts.length ?? 0}</summary>
        <p className="muted small">등록만으로 실행하지 않습니다. 실행 전 프로젝트·작업 경로·셸·명령을 확인하세요. 비밀정보는 명령에 넣지 마세요.</p>
        {Boolean(list.error) && <p className="err" role="alert">script 목록을 읽지 못했습니다. <button onClick={list.reload}>다시 읽기</button></p>}
        {error && <p className="err" role="alert">{error}</p>}
        <ul className="session-list">
            {(list.data?.scripts ?? []).map((script) => <li key={script.id} data-testid="script-row">
                <strong>{script.name}</strong><span className="muted small">revision {script.revision}</span><code>{script.command}</code>
                <button className="ghost small" disabled={locked || editor !== null || !list.data?.execution} onClick={() =>
                    setReview({ script: { ...script }, execution: { ...list.data!.execution! }, projectName, actorId: list.data!.owner })}>실행 확인</button>
                <button className="ghost small" disabled={locked} onClick={() => { setEditor({ ...script }); setError(null); }}>편집</button>
                <button className="ghost small" disabled={locked} onClick={() => {
                    if (confirm(`script “${script.name}” 정의만 삭제할까요? 이미 실행한 작업은 취소하지 않습니다.`))
                        void edit({ method: "del", path: `/projects/${projectId}/scripts/${script.id}?expected_revision=${script.revision}`, key: newKey() });
                }}>삭제</button>
            </li>)}
        </ul>
        {!list.data?.execution && list.data && <p className="warn small">프로젝트를 사용할 수 없어 실행할 수 없습니다. 정의는 편집할 수 있습니다.</p>}
        <button className="ghost small" disabled={locked || editor !== null} onClick={() => setEditor({ name: "", command: "" })}>script 추가</button>
        {editor && <form className="stack" onSubmit={(event) => {
            event.preventDefault();
            void edit({ method: editor.id ? "put" : "post", path: `/projects/${projectId}/scripts${editor.id ? `/${editor.id}` : ""}`,
                body: { name: editor.name, command: editor.command, ...(editor.id ? { expected_revision: editor.revision } : {}) }, key: newKey() });
        }}>
            <label>script 이름<input aria-label="script 이름" required disabled={locked} value={editor.name} onChange={(event) => setEditor({ ...editor, name: event.target.value })} /></label>
            <label>script 명령<textarea aria-label="script 명령" required rows={3} disabled={locked} value={editor.command} onChange={(event) => setEditor({ ...editor, command: event.target.value })} /></label>
            <div className="inline">
                <button type="submit" disabled={locked}>script 저장</button>
                <button type="button" className="ghost" disabled={locked} onClick={() => setEditor(null)}>편집 취소</button>
                {editor.id && <button type="button" className="ghost" disabled={locked} onClick={() => void latest()}>최신 값으로 편집</button>}
            </div>
        </form>}
        {editAttempt && !busy && <div className="inline">
            <button onClick={() => void edit(editAttempt)}>같은 저장 요청 결과 확인</button>
            <button className="ghost" onClick={() => { setEditAttempt(null); list.reload(); }}>서버 값 확인 후 닫기</button>
        </div>}
        {pending.map((row) => <div key={row.key} data-testid="script-run-pending">
            {row.attempt ? <>
                <p>미확인 실행: {row.attempt.script.name} · revision {row.attempt.script.revision}</p>
                <pre>{row.attempt.script.command}</pre>
                <button disabled={locked || editor !== null || !list.data || row.attempt.actorId !== list.data.owner} onClick={() => void run(row.attempt!)}>원래 실행 요청 결과 확인</button>
                {list.data && row.attempt.actorId !== list.data.owner && <p className="warn small">다른 인증의 실행 사본입니다. 원래 인증으로 결과를 확인하세요.</p>}
                {row.attempt.sessionId && <button className="ghost" onClick={() => open({ kind: "session", project_id: projectId, resource_id: row.attempt!.sessionId!, title: `Script · ${row.attempt!.script.name}` })}>작업 대화 열기</button>}
            </> : <p className="warn">실행 사본 형식이 손상됐습니다. 자동 실행하지 않습니다. 프로젝트의 작업 대화를 확인하세요.</p>}
            <button className="ghost small" disabled={busy} onClick={() => {
                if (confirm("기기의 요청 사본만 지웁니다. 서버 작업을 취소하거나 기록을 지우지 않습니다. 계속할까요?")) forgetRun(localStorage, row.key);
            }}>요청 사본만 지우기</button>
        </div>)}
        {review && <RunReview review={review} onClose={() => setReview(null)} onConfirm={() => void run(newRun(review.projectName, review.actorId, review.script, review.execution))} />}
    </details>;
}

function RunReview({ review, onClose, onConfirm }: { review: Review; onClose: () => void; onConfirm: () => void }) {
    const dialog = useRef<HTMLDialogElement>(null);
    useEffect(() => { dialog.current!.showModal(); }, []);
    return <dialog ref={dialog} className="dialog script-dialog" aria-label="script 실행 확인" onCancel={(event) => { event.preventDefault(); onClose(); }}>
        <h2>{review.script.name} 실행 확인</h2>
        <p>프로젝트: <strong>{review.projectName}</strong></p>
        <code>작업 경로: {review.execution.root}</code><code>셸: {review.execution.shell}</code>
        <pre>{review.script.command}</pre>
        <p className="muted small">revision {review.script.revision}의 명령을 새 작업 대화에서 한 번 접수합니다. 셸 명령은 프로젝트 밖의 파일에도 영향을 줄 수 있습니다.</p>
        <div className="inline"><button onClick={onConfirm}>이 명령 실행</button><button className="ghost" autoFocus onClick={onClose}>취소</button></div>
    </dialog>;
}
