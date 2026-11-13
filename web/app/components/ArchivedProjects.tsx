import { useState } from "react";
import { api } from "../api/client";
import type { Project } from "../api/generated";
import { invalidate, useQuery } from "../state/store";
import { ServerActionButton } from "./pwa/ServerActionButton";

type Recovery = { kind: "recoverable"; action: "unarchive" | "unarchive_relink"; message?: string } | { kind: "unavailable"; message: string };

/// 보관된 프로젝트 목록과 복원(PROJECT-009). 보관은 목록에서만 빼므로 복원도 보관 표시만 되돌린다.
/// 원래 폴더가 없으면 검사 결과로 먼저 알리고, 복원 뒤 프로젝트 화면의 "새 경로로 다시 연결"을 쓴다.
export function ArchivedProjects() {
    const q = useQuery<Project[]>("projects:archived", () => api.get("/projects?archived=true"));
    const rows = q.data ?? [];
    return <div className="stack" role="group" aria-label="보관된 프로젝트">
        {q.data && rows.length === 0 && <p className="muted small">보관된 프로젝트가 없습니다.</p>}
        {rows.map((p) => <ArchivedRow key={`${p.id}:${p.revision}`} project={p} />)}
    </div>;
}

function ArchivedRow({ project }: { project: Project }) {
    const [state, setState] = useState<Recovery | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const run = async (fn: () => Promise<unknown>, fallback: string) => {
        setBusy(true);
        setError(null);
        try { await fn(); } catch (e) { setError(e instanceof Error ? e.message : fallback); } finally { setBusy(false); }
    };
    return <div className="row" data-testid="archived-project">
        <span>{project.icon} {project.name}</span>
        {!state && <button type="button" className="ghost small" disabled={busy}
            onClick={() => void run(async () => setState(await api.get<Recovery>(`/projects/${project.id}/recovery`)), "복원 검사 실패")}>복원 검사</button>}
        {state?.kind === "recoverable" && <>
            {state.action === "unarchive_relink" && <span className="warn small" role="status">{state.message}</span>}
            <ServerActionButton type="button" className="small" disabled={busy}
                onClick={() => void run(async () => {
                    await api.post(`/projects/${project.id}/restore`, { expected_revision: project.revision });
                    invalidate("projects");
                }, "복원 실패")}>복원</ServerActionButton>
        </>}
        {state?.kind === "unavailable" && <span className="warn small" role="status">{state.message}</span>}
        {error && <span className="err small" role="alert">{error}</span>}
    </div>;
}
