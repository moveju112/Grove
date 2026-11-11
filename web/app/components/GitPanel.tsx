import { useRef, useState } from "react";
import { ApiError, api, newKey } from "../api/client";
import { useQuery } from "../state/store";

type Entry = { path: string; index: string; worktree: string; kind: string; orig_path?: string };
type Status = { is_repo: boolean; branch?: { head?: string; ahead?: number; behind?: number }; entries?: Entry[]; fingerprint?: string };
type GitRequest =
    | { op: "stage" | "unstage"; body: { paths: string[]; expected_fingerprint: string | undefined } }
    | { op: "stage-hunks"; body: { path: string; hunks: number[]; unstage: boolean; expected_fingerprint: string | undefined } }
    | { op: "commit"; body: { message: string; expected_fingerprint: string | undefined } }
    | { op: "fetch" | "pull" | "push"; body: Record<string, never> };
type Attempt = GitRequest & { projectId: string; key: string };
type MutationState = { phase: "idle" } | { phase: "sending" | "unknown"; attempt: Attempt };
const LABEL: Record<GitRequest["op"], string> = {
    stage: "올리기", unstage: "내리기", "stage-hunks": "부분 올리기/내리기", commit: "커밋", fetch: "fetch", pull: "pull", push: "push",
};

/// 프로젝트 Git 변경 패널. 사용자가 본 상태(fingerprint)와 다르면 서버가 stage·commit을 거부한다.
export function GitPanel({ projectId }: { projectId: string }) {
    const status = useQuery<Status>(`git:${projectId}:status`, () => api.get(`/projects/${projectId}/git/status`));
    const [diff, setDiff] = useState<{ path: string; staged: boolean; text: string; hunks?: string[]; fingerprint?: string } | null>(null);
    const [msg, setMsg] = useState("");
    const [err, setErr] = useState<string | null>(null);
    const [mutation, setMutation] = useState<MutationState>({ phase: "idle" });
    const sending = useRef(false);
    const s = status.data;
    const blocked = mutation.phase !== "idle";
    const show = async (path: string, isStaged: boolean) => {
        const h = await api.get<{ hunks: string[]; fingerprint: string }>(`/projects/${projectId}/git/hunks?staged=${isStaged}&path=${encodeURIComponent(path)}`);
        if (h.hunks.length > 0) {
            setDiff({ path, staged: isStaged, text: "", hunks: h.hunks, fingerprint: h.fingerprint });
            return;
        }
        const d = await api.get<{ diff: string }>(`/projects/${projectId}/git/diff?staged=${isStaged}&path=${encodeURIComponent(path)}`);
        setDiff({ path, staged: isStaged, text: d.diff || "(텍스트 diff 없음 — 새 파일이거나 binary)" });
    };

    const mutate = async (a: Attempt) => {
        if (sending.current) return;
        sending.current = true;
        setMutation({ phase: "sending", attempt: a });
        setErr(null);
        try {
            await api.post(`/projects/${a.projectId}/git/${a.op}`, a.body, { key: a.key });
            if (a.op === "commit") setMsg((current) => current === a.body.message ? "" : current);
            if (a.op === "stage-hunks") await show(a.body.path, a.body.unstage).catch(() => setDiff(null));
            setMutation({ phase: "idle" });
        } catch (e) {
            const unknown = !(e instanceof ApiError) || e.status >= 500 || e.status === 408 || e.code === "result_unknown"
                || (e.details as { result_unknown?: boolean } | undefined)?.result_unknown === true;
            setErr(e instanceof ApiError ? e.message : "응답을 받지 못했습니다. 원래 Git 요청의 결과를 확인하세요.");
            setMutation(unknown ? { phase: "unknown", attempt: a } : { phase: "idle" });
        } finally {
            sending.current = false;
            status.reload();
        }
    };
    const start = (request: GitRequest) => {
        if (sending.current || blocked) return;
        void mutate({ ...request, projectId, key: newKey() });
    };
    const progress = mutation.phase === "sending" && <p className="muted small" role="status">Git 요청 처리·결과 확인 중…</p>;
    // 조회가 실패하거나 저장소가 잠시 없어져도 원래 mutation의 결과 확인은 남긴다.
    const recovery = mutation.phase === "unknown" && (
        <div key="git-recovery" className="draft-note warn" role="group" aria-label="Git 결과 재확인" data-testid="git-unsure">
            <p>{LABEL[mutation.attempt.op]} 결과를 확정하지 못했습니다. 자동으로 다시 실행하지 않습니다. 재확인은 현재 입력이 아니라 원래 대상·fingerprint·같은 요청 키를 사용합니다.</p>
            <details>
                <summary>원래 요청 대상</summary>
                <code>프로젝트 {mutation.attempt.projectId}</code>
                {mutation.attempt.op === "commit" && <pre>{mutation.attempt.body.message}</pre>}
                {(mutation.attempt.op === "stage" || mutation.attempt.op === "unstage") && <pre>{mutation.attempt.body.paths.join("\n")}</pre>}
                {mutation.attempt.op === "stage-hunks" && <p>{mutation.attempt.body.path} · 부분 {mutation.attempt.body.hunks.map((i) => i + 1).join(", ")}</p>}
            </details>
            <div className="inline">
                <button onClick={() => void mutate(mutation.attempt)}>같은 Git 요청 확인</button>
                <button className="ghost small" onClick={() => {
                    if (!confirm("Git 상태·index·이력·원격 상태에서 이전 요청의 실제 결과를 확인했나요?\n이전 요청을 완료로 확정하거나 되돌리지 않습니다. 새 요청은 새 키로 실행됩니다.")) return;
                    setMutation({ phase: "idle" });
                    setErr("이전 요청은 결과 불명 기록으로 남습니다. 다음 작업은 실제 Git 상태를 확인한 뒤 시작하세요.");
                }}>상태 확인 후 새 작업 허용</button>
            </div>
        </div>
    );

    if (!s) return <section className="git" data-testid="git-panel">
        {progress}
        {recovery}
        <p className={status.error ? "err" : "muted"} role={status.error ? "alert" : "status"}>
            {status.error instanceof ApiError ? status.error.message : status.error ? "Git 상태 조회 실패" : "Git 상태 확인 중…"}
        </p>
        {!!status.error && <button onClick={() => status.reload()}>상태 다시 확인</button>}
    </section>;
    if (!s.is_repo) return <section className="git" data-testid="git-panel">
        {progress}
        {recovery}
        <p className="muted">Git 저장소가 아닙니다.</p>
        <button onClick={() => status.reload()}>상태 다시 확인</button>
    </section>;
    const entries = s.entries ?? [];
    const staged = entries.filter((e) => e.index !== "." && e.index !== "?");
    const unstaged = entries.filter((e) => e.worktree !== "." || e.index === "?");
    const hunkAct = (i: number) => start({ op: "stage-hunks", body: { path: diff!.path, hunks: [i], unstage: diff!.staged, expected_fingerprint: diff!.fingerprint } });
    const remote = (op: "fetch" | "pull" | "push") => start({ op, body: {} });
    const row = (e: Entry, isStaged: boolean) => (
        <li key={(isStaged ? "s:" : "w:") + e.path}>
            <code className={`status ${e.kind}`}>{isStaged ? e.index : e.worktree === "." ? e.index : e.worktree}</code>
            <button className="link" onClick={() => void show(e.path, isStaged).catch((error) => setErr(error instanceof ApiError ? error.message : "Git diff 조회 실패"))}>{e.path}</button>
            <button
                className="ghost small"
                disabled={blocked}
                onClick={() => start({ op: isStaged ? "unstage" : "stage", body: { paths: [e.path], expected_fingerprint: s.fingerprint } })}
            >
                {isStaged ? "내리기" : "올리기"}
            </button>
        </li>
    );
    return (
        <section className="git" data-testid="git-panel">
            <h2>
                Git · {s.branch?.head} {s.branch?.ahead ? `↑${s.branch.ahead}` : ""} {s.branch?.behind ? `↓${s.branch.behind}` : ""}
                <button className="ghost small" onClick={() => status.reload()}>새로고침</button>
            </h2>
            <div className="inline small">
                <button className="ghost small" disabled={blocked} onClick={() => remote("fetch")} title="원격 참조만 갱신합니다">가져오기(fetch)</button>
                <button className="ghost small" disabled={blocked} onClick={() => remote("pull")} title="fast-forward만 허용합니다">당겨오기(pull)</button>
                <button className="ghost small" disabled={blocked} onClick={() => remote("push")} title="강제 push는 하지 않습니다">올리기(push)</button>
            </div>
            {progress}
            {err && <p className="err" role="alert">{err}</p>}
            {recovery}
            <h3 className="small">커밋할 변경 ({staged.length})</h3>
            <ul className="session-list">{staged.map((e) => row(e, true))}</ul>
            <h3 className="small">작업 트리 변경 ({unstaged.length})</h3>
            <ul className="session-list">{unstaged.map((e) => row(e, false))}</ul>
            {diff && (
                <details open>
                    <summary>{diff.path} {diff.staged ? "(stage됨)" : ""}</summary>
                    {diff.hunks ? (
                        diff.hunks.map((h, i) => (
                            <div key={i} className="hunk" data-testid="hunk">
                                <button className="ghost small" disabled={blocked} onClick={() => hunkAct(i)}>{diff.staged ? "이 부분 내리기" : "이 부분 올리기"}</button>
                                <pre className="diff">{h}</pre>
                            </div>
                        ))
                    ) : (
                        <pre className="diff">{diff.text}</pre>
                    )}
                </details>
            )}
            <form
                className="inline wrap"
                onSubmit={(e) => {
                    e.preventDefault();
                    start({ op: "commit", body: { message: msg, expected_fingerprint: s.fingerprint } });
                }}
            >
                <textarea value={msg} onChange={(e) => setMsg(e.target.value)} placeholder="커밋 메시지" aria-label="커밋 메시지" rows={2} />
                <button type="submit" disabled={blocked || !msg.trim() || staged.length === 0}>커밋</button>
            </form>
        </section>
    );
}
