import { useContext, useEffect, useRef, useState } from "react";
import { ApiError, api } from "../../api/client";
import type { Session } from "../../api/generated";
import { Composer, type SendOptions } from "../Composer";
import { modelOptionCapabilities } from "../../state/sendOptions";
import type { Opener } from "../Workspace";
import { useWorkspaceMode, useWorkspaces } from "../../state/workspaces";
import { CreationFocus } from "./CreationEntry";

// 모든 진입점은 이 입력창으로 이어진다. 진입·초점 이동만으로는 자원을 만들지 않는다.
// 연결 차단 사유는 상단 연결 토스트가 알린다. 전송 직전 guard(beforeMutation)만 받는다.
export function ProjectComposer({ projectId, tabId, open, disabled, beforeMutation }: {
    projectId: string; tabId: string; open: Opener; disabled: string | null;
    beforeMutation?: () => void;
}) {
    const focus = useContext(CreationFocus);
    const ref = useRef<HTMLDivElement>(null);
    // 프로젝트 모드에서만 새 대화의 워크스페이스를 고른다. 단일 모드는 항상 프로젝트 폴더다.
    const projectMode = useWorkspaceMode(projectId) === "project";
    const spaces = useWorkspaces(projectId, projectMode);
    const [workspace, setWorkspace] = useState("");
    const target = projectMode && spaces.some((w) => w.id === workspace) ? workspace : "";
    useEffect(() => {
        if (!focus || focus.tabId !== tabId || disabled) return;
        const frame = requestAnimationFrame(() => {
            const node = ref.current;
            if (!node || node.closest("[hidden], [inert]")) return;
            if (node.closest("[data-layout-mode]")?.getAttribute("data-layout-mode") !== (focus.narrow ? "narrow" : "wide")) return;
            node.querySelector("textarea")?.focus();
        });
        return () => cancelAnimationFrame(frame);
    }, [focus, tabId, disabled]);

    // Composer가 보관한 전송 키를 단계별로 파생한다. 재확인은 생성·전송 모두 같은 키를 쓴다.
    const start = async (text: string, o: SendOptions, key: string, _follow?: unknown, attachments: string[] = []) => {
        const title = text.trim().split("\n")[0]!.slice(0, 60);
        beforeMutation?.();
        const s = await api.post<Session>(`/projects/${projectId}/sessions`, { title, ...(target ? { worktree_id: target } : {}) }, { key: `${key}:session` });
        try {
            beforeMutation?.();
        } catch (error) {
            // 생성은 이미 접수됐다. 전송 전 차단이어도 전체 요청의 원래 단계별 키를 보존한다.
            if (!(error instanceof ApiError)) throw error;
            throw new ApiError(error.status, error.code, `${error.message} 대화 생성은 접수됐으므로 원래 요청 결과를 확인하세요.`,
                true, { result_unknown: true, idempotency_key: key });
        }
        if (o.mode === "save") await api.post(`/sessions/${s.id}/messages`, { text, attachments }, { key: `${key}:send` });
        else await api.post(`/sessions/${s.id}/turns`, { text, attachments, profile_id: o.profileId, model: o.model, agent_id: o.agentId, tools: o.tools, effort: o.effort ?? "auto", service_tier: o.serviceTier }, { key: `${key}:send`, requires: modelOptionCapabilities(o) });
        open({ kind: "session", project_id: projectId, resource_id: s.id, title: s.title });
    };
    return <div ref={ref} className="project-compose compose-surface">
        {projectMode && spaces.length > 0 && (
            <select aria-label="새 대화 워크스페이스" value={target} onChange={(e) => setWorkspace(e.target.value)}>
                <option value="">워크스페이스: 프로젝트 폴더</option>
                {spaces.map((w) => <option key={w.id} value={w.id}>워크스페이스: {w.name}</option>)}
            </select>
        )}
        <Composer projectId={projectId} resourceKey={`project:${projectId}`} copyId={tabId} onSend={start} disabled={disabled} />
    </div>;
}
