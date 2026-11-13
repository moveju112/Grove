import { useContext, useEffect, useRef } from "react";
import { api } from "../../api/client";
import type { Session } from "../../api/generated";
import { Composer, type SendOptions } from "../Composer";
import type { Opener } from "../Workspace";
import { CreationFocus } from "./CreationEntry";

// 모든 진입점은 이 입력창으로 이어진다. 진입·초점 이동만으로는 자원을 만들지 않는다.
export function ProjectComposer({ projectId, tabId, open, disabled }: {
    projectId: string; tabId: string; open: Opener; disabled: string | null;
}) {
    const focus = useContext(CreationFocus);
    const ref = useRef<HTMLDivElement>(null);
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
        const s = await api.post<Session>(`/projects/${projectId}/sessions`, { title }, { key: `${key}:session` });
        if (o.mode === "save") await api.post(`/sessions/${s.id}/messages`, { text, attachments }, { key: `${key}:send` });
        else await api.post(`/sessions/${s.id}/turns`, { text, attachments, profile_id: o.profileId, agent_id: o.agentId, tools: o.tools, effort: o.effort ?? "auto" }, { key: `${key}:send` });
        open({ kind: "session", project_id: projectId, resource_id: s.id, title: s.title });
    };
    return <div ref={ref} style={{ display: "contents" }}>
        <Composer projectId={projectId} resourceKey={`project:${projectId}`} copyId={tabId} onSend={start} disabled={disabled} />
    </div>;
}
