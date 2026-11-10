import { useState } from "react";
import { ApiError, api } from "../api/client";
import { useQuery } from "../state/store";

type Entry = { path: string; index: string; worktree: string; kind: string; orig_path?: string };
type Status = { is_repo: boolean; branch?: { head?: string; ahead?: number; behind?: number }; entries?: Entry[]; fingerprint?: string };

/// 프로젝트 Git 변경 패널. 사용자가 본 상태(fingerprint)와 다르면 서버가 stage·commit을 거부한다.
export function GitPanel({ projectId }: { projectId: string }) {
    const status = useQuery<Status>(`git:${projectId}:status`, () => api.get(`/projects/${projectId}/git/status`));
    const [diff, setDiff] = useState<{ path: string; staged: boolean; text: string; hunks?: string[]; fingerprint?: string } | null>(null);
    const [msg, setMsg] = useState("");
    const [err, setErr] = useState<string | null>(null);
    const s = status.data;

    const act = async (f: () => Promise<unknown>) => {
        setErr(null);
        try {
            await f();
        } catch (e) {
            setErr(e instanceof ApiError ? e.message : "Git 작업 실패");
        }
        status.reload();
    };

    if (!s) return <p className="muted">Git 상태 확인 중…</p>;
    if (!s.is_repo) return <p className="muted">Git 저장소가 아닙니다.</p>;
    const entries = s.entries ?? [];
    const staged = entries.filter((e) => e.index !== "." && e.index !== "?");
    const unstaged = entries.filter((e) => e.worktree !== "." || e.index === "?");
    const show = async (path: string, isStaged: boolean) => {
        const h = await api.get<{ hunks: string[]; fingerprint: string }>(`/projects/${projectId}/git/hunks?staged=${isStaged}&path=${encodeURIComponent(path)}`);
        if (h.hunks.length > 0) {
            setDiff({ path, staged: isStaged, text: "", hunks: h.hunks, fingerprint: h.fingerprint });
            return;
        }
        const d = await api.get<{ diff: string }>(`/projects/${projectId}/git/diff?staged=${isStaged}&path=${encodeURIComponent(path)}`);
        setDiff({ path, staged: isStaged, text: d.diff || "(텍스트 diff 없음 — 새 파일이거나 binary)" });
    };
    const hunkAct = (i: number) =>
        void act(async () => {
            await api.post(`/projects/${projectId}/git/stage-hunks`, { path: diff!.path, hunks: [i], unstage: diff!.staged, expected_fingerprint: diff!.fingerprint });
            await show(diff!.path, diff!.staged).catch(() => setDiff(null));
        });
    const remote = (op: "fetch" | "pull" | "push") => void act(() => api.post(`/projects/${projectId}/git/${op}`, {}));
    const row = (e: Entry, isStaged: boolean) => (
        <li key={(isStaged ? "s:" : "w:") + e.path}>
            <code className={`status ${e.kind}`}>{isStaged ? e.index : e.worktree === "." ? e.index : e.worktree}</code>
            <button className="link" onClick={() => void show(e.path, isStaged)}>{e.path}</button>
            <button
                className="ghost small"
                onClick={() => void act(() => api.post(`/projects/${projectId}/git/${isStaged ? "unstage" : "stage"}`, { paths: [e.path], expected_fingerprint: s.fingerprint }))}
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
                <button className="ghost small" onClick={() => remote("fetch")} title="원격 참조만 갱신합니다">가져오기(fetch)</button>
                <button className="ghost small" onClick={() => remote("pull")} title="fast-forward만 허용합니다">당겨오기(pull)</button>
                <button className="ghost small" onClick={() => remote("push")} title="강제 push는 하지 않습니다">올리기(push)</button>
            </div>
            {err && <p className="err" role="alert">{err}</p>}
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
                                <button className="ghost small" onClick={() => hunkAct(i)}>{diff.staged ? "이 부분 내리기" : "이 부분 올리기"}</button>
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
                    void act(async () => {
                        await api.post(`/projects/${projectId}/git/commit`, { message: msg, expected_fingerprint: s.fingerprint });
                        setMsg("");
                    });
                }}
            >
                <textarea value={msg} onChange={(e) => setMsg(e.target.value)} placeholder="커밋 메시지" aria-label="커밋 메시지" rows={2} />
                <button type="submit" disabled={!msg.trim() || staged.length === 0}>커밋</button>
            </form>
        </section>
    );
}
