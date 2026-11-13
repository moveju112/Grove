import { api } from "../../api/client";
import type { Project, Session } from "../../api/generated";
import type { Layout } from "../../state/layout";
import { useQuery } from "../../state/store";
import type { Opener } from "../Workspace";
import { hostAddress, navigationContext, projectTarget, resourceLabel, sessionTarget } from "./context";
import "./navigation.css";

export type NavigationContextProps = {
    layout?: Layout;
    projects: Project[];
    host: string;
    open: Opener;
    onBrowseProjects: () => void;
    sidebarOpen: boolean;
};

export function NavigationContext({ layout, projects, host, open, onBrowseProjects, sidebarOpen }: NavigationContextProps) {
    const selected = navigationContext(layout, projects);
    const session = useQuery<Session>(selected.sessionId ? `session:${selected.sessionId}` : null,
        () => api.get(`/sessions/${selected.sessionId}`));
    const context = navigationContext(layout, projects, session.data);
    const parentProject = projectTarget(context);
    const parentSession = sessionTarget(context);
    const address = hostAddress(host);
    const projectName = context.project?.name ?? `프로젝트 ${context.projectId}`;
    const projectLabel = `프로젝트: ${projectName} (${context.projectId})`;
    const sessionName = context.session?.title ?? `세션 ${context.sessionId}`;
    const sessionLabel = `세션: ${sessionName} (${context.sessionId})${session.error ? " · 조회 실패" : ""}`;
    const tab = context.tab;
    const projectCurrent = tab?.kind === "project";
    const sessionCurrent = tab?.kind === "session";
    return <nav className="navigation-context" aria-label="현재 위치" data-testid="navigation-context"
        data-project-id={context.projectId} data-session-id={context.sessionId}>
        <ol>
            <li className="navigation-host">
                <span aria-label={`현재 호스트: ${address}`} title={`현재 호스트: ${address}`}>{address}</span>
            </li>
            <li className="navigation-browse">
                <span className="navigation-separator" aria-hidden="true">/</span>
                <button type="button" className="ghost" onClick={onBrowseProjects}
                    aria-label="프로젝트 탐색" aria-expanded={sidebarOpen} title="사이드바에서 프로젝트 탐색">프로젝트</button>
            </li>
            {parentProject && <li className={`navigation-project ${projectCurrent ? "navigation-current" : ""}`}>
                <span className="navigation-separator" aria-hidden="true">/</span>
                {projectCurrent
                    ? <span aria-current="page" aria-label={projectLabel} title={projectLabel}>{projectName}</span>
                    : <button type="button" className="ghost" aria-label={`${projectLabel} 대화 목록으로`}
                        title={`${projectLabel} 대화 목록으로`} onClick={() => open(parentProject)}>{projectName}</button>}
            </li>}
            {parentSession && <li className={`navigation-session ${sessionCurrent ? "navigation-current" : ""}`}>
                <span className="navigation-separator" aria-hidden="true">/</span>
                {sessionCurrent
                    ? <span aria-current="page" aria-label={sessionLabel} title={sessionLabel}>세션 · {sessionName}{session.error ? " · 조회 실패" : ""}</span>
                    : <button type="button" className="ghost" aria-label={`${sessionLabel} 열기`} title={sessionLabel}
                        onClick={() => open(parentSession)}>세션 · {sessionName}</button>}
            </li>}
            {!projectCurrent && !sessionCurrent && <li className="navigation-current">
                <span className="navigation-separator" aria-hidden="true">/</span>
                <span aria-current="page" title={tab ? resourceLabel(tab) : undefined}>
                    {tab ? resourceLabel(tab) : layout ? "빈 영역" : "배치 불러오는 중…"}
                </span>
            </li>}
        </ol>
        {context.panes > 1 && <span className="navigation-pane" aria-label={`현재 영역 ${context.pane}, 전체 ${context.panes}개`}>
            영역 {context.pane}/{context.panes}
        </span>}
    </nav>;
}
