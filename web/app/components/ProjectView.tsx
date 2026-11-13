import { useState } from "react";
import { When } from "./When";
import { ApiError, api } from "../api/client";
import type { Project, Session, SessionPage } from "../api/generated";
import { useAutoOpen } from "../state/autoOpen";
import { useQuery } from "../state/store";
import { Composer, type SendOptions } from "./Composer";
import { GitPanel } from "./GitPanel";
import { SchedulesPanel } from "./SchedulesPanel";
import { TrashPanel } from "./TrashPanel";
import { WorktreesPanel } from "./WorktreesPanel";
import { ProjectScripts } from "./ProjectScripts";
import type { Opener } from "./Workspace";
import { ServerActionButton } from "./pwa/ServerActionButton";

/// 프로젝트 이름·아이콘 변경(PROJECT-002). revision 충돌이면 최신 값을 다시 불러와 알린다.
function ProjectIdentity({ p, reload }: { p: Project; reload: () => void }) {
    const [edit, setEdit] = useState(false);
    const [name, setName] = useState(p.name);
    const [icon, setIcon] = useState(p.icon ?? "");
    const [err, setErr] = useState<string | null>(null);
    if (!edit) {
        return (
            <button
                className="ghost small"
                onClick={() => {
                    setName(p.name);
                    setIcon(p.icon ?? "");
                    setErr(null);
                    setEdit(true);
                }}
            >
                이름·아이콘
            </button>
        );
    }
    const save = async () => {
        setErr(null);
        try {
            await api.patch(`/projects/${p.id}`, { expected_revision: p.revision, name: name.trim(), icon: icon.trim() || null });
            setEdit(false);
            reload();
        } catch (e) {
            if (e instanceof ApiError && e.code === "revision_conflict") reload();
            setErr(e instanceof ApiError ? e.message : "저장하지 못했습니다");
        }
    };
    return (
        <form
            className="inline"
            aria-label="프로젝트 이름·아이콘"
            onSubmit={(e) => {
                e.preventDefault();
                void save();
            }}
        >
            <input aria-label="아이콘" value={icon} onChange={(e) => setIcon(e.target.value)} placeholder="예: 🌱" size={4} />
            <input aria-label="프로젝트 이름" value={name} onChange={(e) => setName(e.target.value)} required />
            <ServerActionButton className="small" type="submit">저장</ServerActionButton>
            <button className="ghost small" type="button" onClick={() => setEdit(false)}>취소</button>
            {err && <span className="err" role="alert">{err}</span>}
        </form>
    );
}

/// 프로젝트 = 단일 작업공간. 중간 생성 단계 없이 입력창에서 바로 새 대화를 시작한다.
export function ProjectView({ tabId, projectId, open }: { tabId: string; projectId: string; open: Opener }) {
    const [q, setQ] = useState("");
    const [archived, setArchived] = useState(false);
    const [pages, setPages] = useState<string[]>([""]);
    const project = useQuery<Project>(`project:${projectId}`, () => api.get(`/projects/${projectId}`));

    // 단계마다 key를 파생해, 결과를 모르는 실패 뒤 다시 보내도 대화가 두 개 생기거나 두 번 실행되지 않는다.
    const start = async (text: string, o: SendOptions, key: string, _follow?: unknown, attachments: string[] = []) => {
        const title = text.trim().split("\n")[0]!.slice(0, 60);
        const s = await api.post<Session>(`/projects/${projectId}/sessions`, { title }, { key: `${key}:session` });
        if (o.mode === "save") await api.post(`/sessions/${s.id}/messages`, { text, attachments }, { key: `${key}:send` });
        else await api.post(`/sessions/${s.id}/turns`, { text, attachments, profile_id: o.profileId, agent_id: o.agentId, tools: o.tools, effort: o.effort ?? "auto" }, { key: `${key}:send` });
        open({ kind: "session", project_id: projectId, resource_id: s.id, title: s.title });
    };

    const composer = <Composer projectId={projectId} resourceKey={`project:${projectId}`} copyId={tabId} onSend={start}
        disabled={project.error ? "프로젝트를 확인할 수 없습니다" : !project.data ? "프로젝트 확인 중…" : !project.data.available ? "프로젝트 경로 없음" : null} />;
    if (project.error) return <div className="project-view">
        <h1>프로젝트를 열 수 없습니다</h1>
        <p className="err" role="alert">{project.error instanceof ApiError ? project.error.message : "프로젝트 정보를 불러오지 못했습니다."}</p>
        <p className="muted small">저장된 프로젝트 ID를 유지합니다. 다른 프로젝트로 바꾸거나 작업을 자동으로 시작하지 않습니다.</p>
        <button className="ghost small" onClick={project.reload}>프로젝트 다시 확인</button>
        {composer}
    </div>;

    return (
        <div className="project-view">
            <header className="view-head">
                <h1>
                    {project.data?.icon && <span className="project-icon" aria-hidden>{project.data.icon} </span>}
                    {project.data?.name ?? "프로젝트"}
                </h1>
                {project.data && <ProjectIdentity p={project.data} reload={project.reload} />}
                <code className="muted small">{project.data?.root_path}</code>
                <button className="ghost small" onClick={() => open({ kind: "file", project_id: projectId, title: `파일 · ${project.data?.name ?? ""}` })}>
                    파일
                </button>
                <button className="ghost small" onClick={() => open({ kind: "settings", project_id: projectId, resource_id: "settings", title: `설정 · ${project.data?.name ?? ""}` })}>
                    프로젝트 설정
                </button>
                {project.data && !project.data.available && (
                    <div className="err" role="alert" data-testid="project-missing">
                        프로젝트 경로에 접근할 수 없습니다(폴더 이동·삭제·권한 변경). 실행 요청은 거절됩니다. 대화 기록은 남아 있습니다.{" "}
                        <ServerActionButton
                            className="small"
                            onClick={() => {
                                const r = prompt("폴더를 옮겼다면 새 경로를 입력하세요(서버 기준 절대 경로)", project.data!.root_path);
                                if (!r) return;
                                api.patch(`/projects/${projectId}`, { expected_revision: project.data!.revision, root_path: r })
                                    .then(() => project.reload())
                                    .catch((e: Error) => alert(`다시 연결하지 못했습니다: ${e.message}`));
                            }}
                        >
                            새 경로로 다시 연결
                        </ServerActionButton>
                    </div>
                )}
            </header>
            {composer}
            <details className="git-wrap">
                <summary>변경 사항(Git)</summary>
                <GitPanel projectId={projectId} />
            </details>
            <TerminalList projectId={projectId} open={open} />
            <ProjectScripts projectId={projectId} projectName={project.data?.name ?? projectId} open={open} />
            <SchedulesPanel projectId={projectId} open={open} />
            <WorktreesPanel key={`worktrees:${projectId}`} projectId={projectId} />
            <TrashPanel key={`trash:${projectId}`} projectId={projectId} />

            <div className="list-tools">
                <input type="search" placeholder="대화 검색" value={q} onChange={(e) => { setQ(e.target.value); setPages([""]); }} aria-label="대화 검색" />
                <label className="check">
                    <input type="checkbox" checked={archived} onChange={(e) => { setArchived(e.target.checked); setPages([""]); }} /> 보관됨
                </label>
            </div>
            <ul className="session-list">
                {pages.map((cursor, i) => (
                    <SessionPageList key={cursor + i} projectId={projectId} cursor={cursor} q={q} archived={archived} open={open} onMore={(c) => setPages((p) => (p.includes(c) ? p : [...p, c]))} last={i === pages.length - 1} />
                ))}
            </ul>
        </div>
    );
}

type TerminalRow = { id: string; name: string; status: "running" | "exited" | "lost"; exit_code: number | null };

/// 프로젝트 터미널 목록·새 터미널. 끝난 터미널은 화면 보기·기록 삭제만 할 수 있다.
function TerminalList({ projectId, open }: { projectId: string; open: Opener }) {
    const list = useQuery<{ terminals: TerminalRow[] }>(`terminals:${projectId}`, () => api.get(`/projects/${projectId}/terminals`));
    const [err, setErr] = useState<string | null>(null);
    const openTerm = (t: TerminalRow) => {
        open({ kind: "terminal", project_id: projectId, resource_id: t.id, title: t.name });
        void api.post("/recent/touch", { kind: "terminal", project_id: projectId, resource_id: t.id, title: t.name }).catch(() => undefined);
    };
    const create = async () => {
        setErr(null);
        try {
            const t = await api.post<TerminalRow>(`/projects/${projectId}/terminals`, { name: "터미널" });
            openTerm(t);
        } catch (e) {
            setErr(e instanceof ApiError ? e.message : "터미널을 열지 못했습니다");
        }
        list.reload();
    };
    const terms = list.data?.terminals ?? [];
    // 실행 중인 터미널이 생기면 열고, 모두 끝나도 사용자가 연 목록을 닫지 않는다.
    const details = useAutoOpen(terms.some((t) => t.status === "running"));
    return (
        <details className="terminals" data-testid="terminal-list" {...details}>
            <summary>터미널 {terms.length > 0 ? `· ${terms.length}` : ""}</summary>
            <button className="ghost small" onClick={() => void create()}>새 터미널</button>
            {err && <p className="err" role="alert">{err}</p>}
            <ul className="session-list">
                {terms.map((t) => (
                    <li key={t.id}>
                        <button className="link" onClick={() => openTerm(t)}>{t.name}</button>
                        <span className={`status ${t.status}`}>{t.status === "running" ? "실행 중" : t.status === "lost" ? "재시작으로 종료" : `종료(${t.exit_code ?? "?"})`}</span>
                        {t.status !== "running" && (
                            <ServerActionButton className="ghost small" onClick={() => void api.del(`/terminals/${t.id}`).then(list.reload)}>기록 삭제</ServerActionButton>
                        )}
                    </li>
                ))}
            </ul>
        </details>
    );
}

function SessionPageList(p: { projectId: string; cursor: string; q: string; archived: boolean; open: Opener; onMore: (c: string) => void; last: boolean }) {
    const qs = new URLSearchParams({ limit: "30", q: p.q, archived: String(p.archived) });
    if (p.cursor) qs.set("cursor", p.cursor);
    const page = useQuery<SessionPage>(`sessions:${p.projectId}:${qs}`, () => api.get(`/projects/${p.projectId}/sessions?${qs}`));
    return (
        <>
            {(page.data?.items ?? []).map((s) => (
                <li key={s.id}>
                    <button className="link" onClick={() => p.open({ kind: "session", project_id: p.projectId, resource_id: s.id, title: s.title })}>
                        {s.unread && <span className="dot" aria-label="읽지 않음" data-testid="session-unread" />}
                        {s.title}
                    </button>
                    {s.preview && <span className="muted small preview">{s.preview}</span>}
                    {s.active_turn === "awaiting_input" ? (
                        <span className="status awaiting_input">답변 대기</span>
                    ) : (
                        s.active_turn && <span className="status running">실행 중</span>
                    )}
                    {s.pending_approvals > 0 && <span className="status awaiting_approval">승인 {s.pending_approvals}</span>}
                    {s.unreviewed_unknown > 0 && <span className="status unknown_result">결과 확인 필요</span>}
                    <span className="muted small" data-testid="session-updated"><When at={s.updated_at} /></span>
                </li>
            ))}
            {p.last && page.data?.next_cursor && (
                <li>
                    <button className="ghost" onClick={() => p.onMore(page.data!.next_cursor!)}>
                        더 보기
                    </button>
                </li>
            )}
            {p.cursor === "" && page.data?.items.length === 0 && <li className="muted">대화가 없습니다.</li>}
        </>
    );
}
