import { Grid } from "@astryxdesign/core/Grid";
import { chatLayout } from "../chat-layout.stylex";
import { Select } from "../../design/Select";
import { useEffect, useRef, useState } from "react";
import { ApiError, api } from "../../api/client";
import type { Session } from "../../api/generated";
import { Composer, type SendOptions } from "../Composer";
import { modelOptionCapabilities } from "../../state/sendOptions";
import type { Opener } from "../Workspace";
import { useWorkspaceMode, useWorkspaces } from "../../state/workspaces";

// 모든 진입점은 이 입력창으로 이어진다. 진입·초점 이동만으로는 자원을 만들지 않는다.
// 연결 차단 사유는 상단 연결 토스트가 알린다. 전송 직전 guard(beforeMutation)만 받는다.
export function ProjectComposer({ projectId, tabId, open, disabled, beforeMutation, focusVersion = 0 }: {
    projectId: string; tabId: string; open: Opener; disabled: string | null;
    beforeMutation?: () => void;
    focusVersion?: number;
}) {
    const ref = useRef<HTMLDivElement>(null);
    // 프로젝트 모드에서만 새 대화의 워크스페이스를 고른다. 단일 모드는 항상 프로젝트 폴더다.
    const projectMode = useWorkspaceMode(projectId) === "project";
    const spaces = useWorkspaces(projectId, projectMode);
    const [workspace, setWorkspace] = useState("");
    const target = projectMode && spaces.some((w) => w.id === workspace) ? workspace : "";
    useEffect(() => {
        if (!focusVersion || disabled) return;
        const focusInput = () => {
            const node = ref.current;
            if (!node || node.closest("[hidden], [inert]")) return;
            if (node.closest('[data-testid="pane"]')?.getAttribute("data-focused") === "false") {
                document.removeEventListener("close", focusInput, true);
                return;
            }
            const input = node.querySelector("textarea");
            input?.focus();
            if (input === document.activeElement) document.removeEventListener("close", focusInput, true);
        };
        // Drawer는 퇴장이 끝날 때 modal 잠금을 해제한다. 그 전의 focus 요청은 브라우저가 무시한다.
        document.addEventListener("close", focusInput, true);
        const frame = requestAnimationFrame(focusInput);
        return () => {
            cancelAnimationFrame(frame);
            document.removeEventListener("close", focusInput, true);
        };
    }, [focusVersion, tabId, disabled]);

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
        else await api.post(`/sessions/${s.id}/turns`, { text, attachments, profile_id: o.profileId, model: o.model, agent_id: o.agentId, tools: o.tools, effort: o.effort ?? "auto", service_tier: o.serviceTier, native_command: o.nativeCommand }, { key: `${key}:send`, requires: modelOptionCapabilities(o) });
        open({ kind: "session", project_id: projectId, resource_id: s.id, title: s.title });
    };
    return <Grid ref={ref} gap={1} xstyle={chatLayout.surface} data-testid="compose-surface">
        {projectMode && spaces.length > 0 && (
            <Select label="새 대화 워크스페이스" hideLabel placement="above" value={target} onChange={setWorkspace}
                options={[{ value: "", label: "워크스페이스: 프로젝트 폴더" },
                    ...spaces.map((w) => ({ value: w.id, label: `워크스페이스: ${w.name}` }))]} />
        )}
        <Composer projectId={projectId} resourceKey={`project:${projectId}`} copyId={tabId} onSend={start} disabled={disabled} worktreeId={target || undefined} />
    </Grid>;
}
