import { useEffect, useRef, useState } from "react";
import { ApiError, api, authGeneration, isLoggedIn, newKey } from "../api/client";
import { useCapability } from "../state/capabilities";
import { useQuery } from "../state/store";
import { confirmRun, forgetRun, newRun, pendingRuns, subscribeScriptRuns, type Execution, type ProjectScript, type RunAttempt, type ScriptListing } from "../state/projectScripts";
import type { Opener } from "./Workspace";
import { ServerActionButton } from "./pwa/ServerActionButton";
import { Panel } from "./ui/Controls";

type Editor = { id?: string; revision?: number; name: string; command: string };
type EditAttempt = { method: "post" | "put" | "del"; path: string; body?: object; key: string };
type Review = { script: ProjectScript; execution: Execution; projectName: string; actorId: string; setup?: { worktreeId: string | null; target: string } };
type SetupTarget = {
    worktree_id: string | null; name: string; path: string; fingerprint: string | null; attempts: number;
    status: string; task_id: string | null; session_id: string | null; exit_code: number | null; ended_at: string | null;
};
type SetupStatus = { script: ProjectScript | null; targets: SetupTarget[] };
const SETUP_LABEL: Record<string, string> = {
    not_run: "미실행", running: "실행 중", completed: "성공", failed: "실패", timeout: "시간 초과", cancelled: "취소됨", unknown: "결과 불명",
};

export function ProjectScripts({ projectId, projectName, open }: { projectId: string; projectName: string; open: Opener }) {
    const supported = useCapability("project_scripts_v1");
    const list = useQuery<ScriptListing>(supported === false ? null : `scripts:${projectId}`, () => api.get(`/projects/${projectId}/scripts`));
    const setup = useQuery<SetupStatus>(supported === false ? null : `setup:${projectId}`, () => api.get(`/projects/${projectId}/setup`));
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
            if (alive.current && active()) { setBusy(false); refresh(); list.reload(); setup.reload(); }
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
    // 초기 설정 script 지정·해제(PROJECT-010). 지정만으로는 실행하지 않는다.
    const designate = async (scriptId: string | null) => {
        if (working.current) return;
        working.current = true;
        setBusy(true); setError(null);
        try {
            const project = await api.get<{ revision: number }>(`/projects/${projectId}`);
            await api.patch(`/projects/${projectId}`, { expected_revision: project.revision, setup_script_id: scriptId });
        } catch (error) {
            if (alive.current && active()) setError(error instanceof Error ? error.message : "초기 설정 지정 실패");
        } finally {
            working.current = false;
            if (alive.current && active()) { setBusy(false); setup.reload(); }
        }
    };
    if (supported === false) return null;
    const locked = busy || editAttempt !== null;
    const setupId = setup.data?.script?.id ?? null;
    return <Panel className="project-scripts" data-testid="project-scripts" title={`스크립트 · ${list.data?.scripts.length ?? 0}`}>
        <p className="warn small">명령에 비밀정보를 넣지 마세요.</p>
        {Boolean(list.error) && <p className="err" role="alert">script 목록을 읽지 못했습니다. <button onClick={list.reload}>다시 읽기</button></p>}
        {error && <p className="err" role="alert">{error}</p>}
        <ul className="session-list">
            {(list.data?.scripts ?? []).map((script) => <li key={script.id} data-testid="script-row">
                <strong>{script.name}</strong><span className="muted small">revision {script.revision}</span><code>{script.command}</code>
                <button className="ghost small" disabled={locked || editor !== null || !list.data?.execution} onClick={() =>
                    setReview({ script: { ...script }, execution: { ...list.data!.execution! }, projectName, actorId: list.data!.owner })}>실행 확인</button>
                <ServerActionButton className="ghost small" disabled={locked} aria-pressed={setupId === script.id}
                    onClick={() => void designate(setupId === script.id ? null : script.id)}>
                    {setupId === script.id ? "초기 설정 지정 해제" : "초기 설정으로 지정"}
                </ServerActionButton>
                <button className="ghost small" disabled={locked} onClick={() => { setEditor({ ...script }); setError(null); }}>편집</button>
                <ServerActionButton className="ghost small" disabled={locked} onClick={() => {
                    if (confirm(`script “${script.name}” 정의만 삭제할까요? 이미 실행한 작업은 취소하지 않습니다.`))
                        void edit({ method: "del", path: `/projects/${projectId}/scripts/${script.id}?expected_revision=${script.revision}`, key: newKey() });
                }}>삭제</ServerActionButton>
            </li>)}
        </ul>
        {!list.data?.execution && list.data && <p className="warn small">프로젝트를 사용할 수 없어 실행할 수 없습니다. 정의는 편집할 수 있습니다.</p>}
        <div role="group" aria-label="초기 설정" data-testid="project-setup">
            <h3 className="small">초기 설정 {setup.data?.script ? <>· <strong>{setup.data.script.name}</strong></> : <span className="muted">· 지정 안 함</span>}</h3>
            {setup.data?.script && <ul className="session-list">
                {setup.data.targets.map((t) => <li key={t.worktree_id ?? "root"} data-testid="setup-target" data-status={t.status}>
                    <span>{t.name}</span>
                    <span className={t.status === "completed" ? "muted small" : t.status === "not_run" || t.status === "running" ? "small" : "warn small"}>
                        {SETUP_LABEL[t.status] ?? t.status}{t.exit_code != null && t.status !== "completed" ? ` (종료 코드 ${t.exit_code})` : ""}{t.attempts > 0 ? ` · 시도 ${t.attempts}회` : ""}
                    </span>
                    {t.session_id && <button className="ghost small" onClick={() => open({ kind: "session", project_id: projectId, resource_id: t.session_id!, title: `초기 설정 · ${t.name}` })}>로그</button>}
                    <button className="ghost small" disabled={locked || editor !== null || !t.fingerprint || !list.data?.execution || t.status === "running"}
                        onClick={() => setReview({
                            script: { ...setup.data!.script! }, execution: { root: t.path, shell: list.data!.execution!.shell, fingerprint: t.fingerprint! },
                            projectName, actorId: list.data!.owner, setup: { worktreeId: t.worktree_id, target: t.name },
                        })}>{t.status === "not_run" ? "실행 확인" : "다시 실행 확인"}</button>
                </li>)}
            </ul>}
        </div>
        <button className="ghost small" disabled={locked || editor !== null} onClick={() => setEditor({ name: "", command: "" })}>script 추가</button>
        {editor && <form className="stack" onSubmit={(event) => {
            event.preventDefault();
            void edit({ method: editor.id ? "put" : "post", path: `/projects/${projectId}/scripts${editor.id ? `/${editor.id}` : ""}`,
                body: { name: editor.name, command: editor.command, ...(editor.id ? { expected_revision: editor.revision } : {}) }, key: newKey() });
        }}>
            <label>script 이름<input aria-label="script 이름" required disabled={locked} value={editor.name} onChange={(event) => setEditor({ ...editor, name: event.target.value })} /></label>
            <label>script 명령<textarea aria-label="script 명령" required rows={3} disabled={locked} value={editor.command} onChange={(event) => setEditor({ ...editor, command: event.target.value })} /></label>
            <div className="inline">
                <ServerActionButton type="submit" disabled={locked}>script 저장</ServerActionButton>
                <button type="button" className="ghost" disabled={locked} onClick={() => setEditor(null)}>편집 취소</button>
                {editor.id && <button type="button" className="ghost" disabled={locked} onClick={() => void latest()}>최신 값으로 편집</button>}
            </div>
        </form>}
        {editAttempt && !busy && <div className="inline">
            <ServerActionButton onClick={() => void edit(editAttempt)}>같은 저장 요청 결과 확인</ServerActionButton>
            <button className="ghost" onClick={() => { setEditAttempt(null); list.reload(); }}>서버 값 확인 후 닫기</button>
        </div>}
        {pending.map((row) => <div key={row.key} data-testid="script-run-pending">
            {row.attempt ? <>
                <p>미확인 실행: {row.attempt.script.name} · revision {row.attempt.script.revision}</p>
                <pre>{row.attempt.script.command}</pre>
                <ServerActionButton disabled={locked || editor !== null || !list.data || row.attempt.actorId !== list.data.owner} onClick={() => void run(row.attempt!)}>원래 실행 요청 결과 확인</ServerActionButton>
                {list.data && row.attempt.actorId !== list.data.owner && <p className="warn small">다른 인증의 실행 사본입니다. 원래 인증으로 결과를 확인하세요.</p>}
                {row.attempt.sessionId && <button className="ghost" onClick={() => open({ kind: "session", project_id: projectId, resource_id: row.attempt!.sessionId!, title: `Script · ${row.attempt!.script.name}` })}>작업 대화 열기</button>}
            </> : <p className="warn">실행 사본 형식이 손상됐습니다. 자동 실행하지 않습니다. 프로젝트의 작업 대화를 확인하세요.</p>}
            <button className="ghost small" disabled={busy} onClick={() => {
                if (confirm("기기의 요청 사본만 지웁니다. 서버 작업을 취소하거나 기록을 지우지 않습니다. 계속할까요?")) forgetRun(localStorage, row.key);
            }}>요청 사본만 지우기</button>
        </div>)}
        {review && <RunReview review={review} onClose={() => setReview(null)} onConfirm={() => void run(newRun(review.projectName, review.actorId, review.script, review.execution,
            review.setup ? { worktreeId: review.setup.worktreeId } : undefined))} />}
    </Panel>;
}

function RunReview({ review, onClose, onConfirm }: { review: Review; onClose: () => void; onConfirm: () => void }) {
    const dialog = useRef<HTMLDialogElement>(null);
    useEffect(() => { dialog.current!.showModal(); }, []);
    return <dialog ref={dialog} className="dialog script-dialog" aria-label="script 실행 확인" onCancel={(event) => { event.preventDefault(); onClose(); }}>
        <h2>{review.script.name} {review.setup ? "초기 설정 " : ""}실행 확인</h2>
        <p>프로젝트: <strong>{review.projectName}</strong>{review.setup && <> · 위치: <strong>{review.setup.target}</strong></>}</p>
        <code>작업 경로: {review.execution.root}</code><code>셸: {review.execution.shell}</code>
        <pre>{review.script.command}</pre>
        <p className="muted small">revision {review.script.revision}의 명령을 새 작업 대화에서 한 번 접수합니다. 셸 명령은 프로젝트 밖의 파일에도 영향을 줄 수 있습니다.</p>
        <div className="inline"><ServerActionButton onClick={onConfirm}>이 명령 실행</ServerActionButton><button className="ghost" autoFocus onClick={onClose}>취소</button></div>
    </dialog>;
}
