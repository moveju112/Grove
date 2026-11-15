import { Stack as GroveStack } from "@astryxdesign/core/Stack";
import { Text as GroveText } from "@astryxdesign/core/Text";
import { Heading as GroveHeading } from "@astryxdesign/core/Heading";
import { Button as GroveButton } from "../design/Button";
import { useEffect, useRef, useState } from "react";
import { DetailDialog, Panel } from "./ui/Controls";
import { ApiError, api, newKey } from "../api/client";
import { useQuery } from "../state/store";
import { GitConfirmation } from "./git/GitConfirmation";
import { confirmationBody, type ConfirmGitBody, type GitReview, type ReviewAction, type Stash } from "./git/types";
import { ServerActionButton } from "./pwa/ServerActionButton";
import { GitContextOverview } from "./git-context/GitContextOverview";
import { HelpTip } from "./HelpTip";
import { TextInput, TextArea } from "../design/Fields";

type Entry = { path: string; index: string; worktree: string; kind: string; orig_path?: string };
type Status = { is_repo: boolean; branch?: { head?: string; oid?: string; ahead?: number; behind?: number }; entries?: Entry[]; fingerprint?: string };
type GitRequest =
    | { op: "stage" | "unstage"; body: { paths: string[]; expected_fingerprint: string | undefined } }
    | { op: "stage-hunks"; body: { path: string; hunks: number[]; unstage: boolean; expected_fingerprint: string | undefined } }
    | { op: "commit"; body: { message: string; expected_fingerprint: string | undefined } }
    | { op: "stash-save"; body: { message: string; expected_fingerprint: string | undefined } }
    | { op: "confirm"; body: ConfirmGitBody }
    | { op: "fetch" | "pull" | "push"; body: Record<string, never> };
type Attempt = GitRequest & { projectId: string; key: string };
type MutationState = { phase: "idle" } | { phase: "sending" | "unknown"; attempt: Attempt };
const LABEL: Record<GitRequest["op"], string> = {
    stage: "올리기", unstage: "내리기", "stage-hunks": "부분 올리기/내리기", commit: "커밋", fetch: "fetch", pull: "pull", push: "push",
    "stash-save": "stash 저장", confirm: "확인한 Git 작업",
};

/// 프로젝트 Git 변경 패널. 사용자가 본 상태(fingerprint)와 다르면 서버가 stage·commit을 거부한다.
export function GitPanel({ projectId }: { projectId: string }) {
    const status = useQuery<Status>(`git:${projectId}:status`, () => api.get(`/projects/${projectId}/git/status`));
    const stashes = useQuery<{ stashes: Stash[] }>(`git:${projectId}:stashes`, () => api.get(`/projects/${projectId}/git/stashes`));
    const [diff, setDiff] = useState<{ path: string; staged: boolean; text: string; hunks?: string[]; fingerprint?: string } | null>(null);
    const [msg, setMsg] = useState("");
    const [stashMessage, setStashMessage] = useState("");
    const [review, setReview] = useState<{ phase: "loading"; projectId: string } | { phase: "ready"; projectId: string; data: GitReview } | null>(null);
    const [err, setErr] = useState<string | null>(null);
    const [mutation, setMutation] = useState<MutationState>({ phase: "idle" });
    const sending = useRef(false);
    const reviewing = useRef(false);
    const currentProject = useRef(projectId);
    currentProject.current = projectId;
    useEffect(() => { setReview(null); }, [projectId]);
    const s = status.data;
    const blocked = mutation.phase !== "idle" || review !== null;
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
            if (a.op === "stash-save") setStashMessage((current) => current === a.body.message ? "" : current);
            if (a.op === "confirm" || a.op === "stash-save") setDiff(null);
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
            stashes.reload();
        }
    };
    const start = (request: GitRequest) => {
        if (sending.current || reviewing.current || blocked) return;
        void mutate({ ...request, projectId, key: newKey() });
    };
    const prepare = async (action: ReviewAction) => {
        if (blocked || sending.current || reviewing.current) return;
        reviewing.current = true;
        setReview({ phase: "loading", projectId });
        setErr(null);
        try {
            const data = await api.post<GitReview>(`/projects/${projectId}/git/review`, action);
            if (currentProject.current === projectId) setReview({ phase: "ready", projectId, data });
            else setReview(null);
        } catch (error) {
            setReview(null);
            setErr(error instanceof ApiError ? error.message : "Git 확인 정보 조회 실패");
        } finally {
            reviewing.current = false;
        }
    };
    const progress = mutation.phase === "sending" && <GroveText as="p" display="block" type="supporting" color="secondary" role="status">Git 요청 처리·결과 확인 중…</GroveText>;
    // 조회가 실패하거나 저장소가 잠시 없어져도 원래 mutation의 결과 확인은 남긴다.
    const recovery = mutation.phase === "unknown" && (
        <div key="git-recovery" className="draft-note warn" role="group" aria-label="Git 결과 재확인" data-testid="git-unsure">
            <GroveText as="p" display="block" type="inherit" color="inherit">{LABEL[mutation.attempt.op]} 결과를 확정하지 못했습니다. 자동으로 다시 실행하지 않습니다. 재확인은 현재 입력이 아니라 원래 대상·fingerprint·같은 요청 키를 사용합니다.</GroveText>
            <DetailDialog label="원래 Git 요청 대상" title="원래 요청 대상">
                <code>프로젝트 {mutation.attempt.projectId}</code>
                {mutation.attempt.op === "commit" && <pre>{mutation.attempt.body.message}</pre>}
                {(mutation.attempt.op === "stage" || mutation.attempt.op === "unstage") && <pre>{mutation.attempt.body.paths.join("\n")}</pre>}
                {mutation.attempt.op === "stage-hunks" && <GroveText as="p" display="block" type="inherit" color="inherit">{mutation.attempt.body.path} · 부분 {mutation.attempt.body.hunks.map((i) => i + 1).join(", ")}</GroveText>}
                {(mutation.attempt.op === "confirm" || mutation.attempt.op === "stash-save") && <pre>{JSON.stringify(mutation.attempt.body, null, 2)}</pre>}
            </DetailDialog>
            <GroveStack direction="horizontal" align="center" className="inline">
                <ServerActionButton onClick={() => void mutate(mutation.attempt)}>같은 Git 요청 확인</ServerActionButton>
                <GroveButton className="ghost small" onClick={() => {
                    if (!confirm("Git 상태·index·이력·원격 상태에서 이전 요청의 실제 결과를 확인했나요?\n이전 요청을 완료로 확정하거나 되돌리지 않습니다. 새 요청은 새 키로 실행됩니다.")) return;
                    setMutation({ phase: "idle" });
                    setErr("이전 요청은 결과 불명 기록으로 남습니다. 다음 작업은 실제 Git 상태를 확인한 뒤 시작하세요.");
                }}>상태 확인 후 새 작업 허용</GroveButton>
            </GroveStack>
        </div>
    );

    if (!s) return <section className="git" data-testid="git-panel">
        <GitContextOverview projectId={projectId} refreshSignal={s} />
        {progress}
        {recovery}
        <GroveText as="p" display="block" type="inherit" color={status.error ? "error" : "secondary"} role={status.error ? "alert" : "status"}>
            {status.error instanceof ApiError ? status.error.message : status.error ? "Git 상태 조회 실패" : "Git 상태 확인 중…"}
        </GroveText>
        {!!status.error && <GroveButton onClick={() => status.reload()}>상태 다시 확인</GroveButton>}
    </section>;
    if (!s.is_repo) return <section className="git" data-testid="git-panel">
        <GitContextOverview projectId={projectId} refreshSignal={s} />
        {progress}
        {recovery}
        <GroveButton onClick={() => status.reload()}>상태 다시 확인</GroveButton>
    </section>;
    const entries = s.entries ?? [];
    const staged = entries.filter((e) => e.index !== "." && e.index !== "?");
    const unstaged = entries.filter((e) => e.worktree !== "." || e.index === "?");
    const hunkAct = (i: number) => start({ op: "stage-hunks", body: { path: diff!.path, hunks: [i], unstage: diff!.staged, expected_fingerprint: diff!.fingerprint } });
    const remote = (op: "fetch" | "pull" | "push") => start({ op, body: {} });
    const row = (e: Entry, isStaged: boolean) => (
        <li key={(isStaged ? "s:" : "w:") + e.path}>
            <code className={`status ${e.kind}`}>{isStaged ? e.index : e.worktree === "." ? e.index : e.worktree}</code>
            <GroveButton className="link" onClick={() => void show(e.path, isStaged).catch((error) => setErr(error instanceof ApiError ? error.message : "Git diff 조회 실패"))}>{e.path}</GroveButton>
            <ServerActionButton
                className="ghost small"
                disabled={blocked}
                onClick={() => start({ op: isStaged ? "unstage" : "stage", body: { paths: [e.path], expected_fingerprint: s.fingerprint } })}
            >
                {isStaged ? "내리기" : "올리기"}
            </ServerActionButton>
            {e.kind !== "untracked" && <ServerActionButton className="ghost small" disabled={blocked}
                onClick={() => void prepare({ operation: "discard", paths: [e.path] })}>변경 버리기</ServerActionButton>}
        </li>
    );
    return (
        <section className="git" data-testid="git-panel">
            <GitContextOverview projectId={projectId} head={s.branch?.oid} refreshSignal={s} />
            <GroveHeading level={2} color="inherit">
                Git · {s.branch?.head} {s.branch?.ahead ? `↑${s.branch.ahead}` : ""} {s.branch?.behind ? `↓${s.branch.behind}` : ""}
                <GroveButton className="ghost small" onClick={() => { status.reload(); stashes.reload(); }}>새로고침</GroveButton>
            </GroveHeading>
            <div className="inline small">
                <ServerActionButton className="ghost small" disabled={blocked} onClick={() => remote("fetch")} title="원격 참조만 갱신합니다">가져오기(fetch)</ServerActionButton>
                <ServerActionButton className="ghost small" disabled={blocked} onClick={() => remote("pull")} title="fast-forward만 허용합니다">당겨오기(pull)</ServerActionButton>
                <ServerActionButton className="ghost small" disabled={blocked} onClick={() => remote("push")} title="강제 push는 하지 않습니다">올리기(push)</ServerActionButton>
            </div>
            {progress}
            {err && <GroveText as="p" display="block" type="inherit" color="error" role="alert">{err}</GroveText>}
            {recovery}
            {review?.phase === "loading" && <GroveText as="p" display="block" type="inherit" color="inherit" role="status">Git 확인 정보 조회 중…</GroveText>}
            {review?.phase === "ready" && review.projectId === projectId && <GitConfirmation
                projectId={projectId} review={review.data} onCancel={() => setReview(null)}
                onConfirm={() => {
                    if (sending.current) return;
                    setReview(null);
                    void mutate({ op: "confirm", body: confirmationBody(review.data), projectId: review.projectId, key: newKey() });
                }} />}
            <GroveHeading level={3} color="inherit" className="small inline">stash <HelpTip label="stash 저장 도움말">
                tracked 파일의 index·작업 트리 변경만 저장하며 untracked·ignored 파일은 그대로 둡니다.
            </HelpTip></GroveHeading>
            <GroveStack direction="horizontal" align="center" wrap="wrap" className="inline wrap">
                <TextInput label="stash 메시지" isLabelHidden placeholder="stash 메시지" value={stashMessage} onChange={setStashMessage} />
                <ServerActionButton disabled={blocked || !s.fingerprint || !entries.some((e) => e.kind !== "untracked")}
                    onClick={() => start({ op: "stash-save", body: { message: stashMessage, expected_fingerprint: s.fingerprint } })}>stash 저장</ServerActionButton>
            </GroveStack>
            {stashes.error ? <GroveText as="p" display="block" type="inherit" color="error" role="alert">stash 목록 조회 실패</GroveText> : !stashes.data ? <GroveText as="p" display="block" type="inherit" color="inherit" role="status">stash 목록 조회 중…</GroveText> :
                <ul>{stashes.data.stashes.map((stash) => <li key={`${stash.reference}:${stash.oid}`}>
                    <code>{stash.reference}</code> {stash.subject}
                    <ServerActionButton className="ghost small" disabled={blocked} onClick={() => void prepare({ operation: "stash_pop", stash_oid: stash.oid })}>stash pop</ServerActionButton>
                </li>)}</ul>}
            <GroveHeading level={3} color="inherit" className="small">커밋할 변경 ({staged.length})</GroveHeading>
            <ul className="session-list">{staged.map((e) => row(e, true))}</ul>
            <GroveHeading level={3} color="inherit" className="small">작업 트리 변경 ({unstaged.length})</GroveHeading>
            <ul className="session-list">{unstaged.map((e) => row(e, false))}</ul>
            {diff && (
                <Panel title={<>{diff.path} {diff.staged ? "(stage됨)" : ""}</>}>
                    {diff.hunks ? (
                        diff.hunks.map((h, i) => (
                            <div key={i} className="hunk" data-testid="hunk">
                                <ServerActionButton className="ghost small" disabled={blocked} onClick={() => hunkAct(i)}>{diff.staged ? "이 부분 내리기" : "이 부분 올리기"}</ServerActionButton>
                                <pre className="diff">{h}</pre>
                            </div>
                        ))
                    ) : (
                        <pre className="diff">{diff.text}</pre>
                    )}
                </Panel>
            )}
            <form
                className="inline wrap"
                onSubmit={(e) => {
                    e.preventDefault();
                    start({ op: "commit", body: { message: msg, expected_fingerprint: s.fingerprint } });
                }}
            >
                <TextArea value={msg} onChange={setMsg} placeholder="커밋 메시지" label="커밋 메시지" isLabelHidden rows={2} />
                <ServerActionButton type="submit" disabled={blocked || !msg.trim() || staged.length === 0}>커밋</ServerActionButton>
            </form>
        </section>
    );
}
