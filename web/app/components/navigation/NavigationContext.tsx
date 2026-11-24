import { HintText } from "../../design/HintText";
import { VisuallyHidden } from "@astryxdesign/core/VisuallyHidden";
import { Stack } from "@astryxdesign/core/Stack";
import { Text as GroveText } from "@astryxdesign/core/Text";
import { Button as GroveButton } from "../../design/Button";
import { api } from "../../api/client";
import type { Project, Session } from "../../api/generated";
import type { Layout } from "../../state/layout";
import { useQuery } from "../../state/store";
import type { Opener } from "../Workspace";
import { Icon } from "../icons";
import { navigationContext, projectTarget, resourceLabel } from "./context";
import { navigationStyles } from "./navigation.stylex";

export type NavigationContextProps = {
    layout?: Layout;
    projects: Project[];
    splitProject?: Project;
    open: Opener;
    onBrowseProjects: () => void;
    sidebarOpen: boolean;
};

export function NavigationContext({ layout, projects, splitProject, open, onBrowseProjects, sidebarOpen }: NavigationContextProps) {
    const selected = navigationContext(layout, projects);
    const session = useQuery<Session>(selected.sessionId ? `session:${selected.sessionId}` : null,
        () => api.get(`/sessions/${selected.sessionId}`));
    const tabContext = navigationContext(layout, projects, session.data);
    // 빈 탭 영역도 포커스된 프로젝트 분할에 속한다.
    const context = splitProject ? { ...tabContext, projectId: splitProject.id, project: splitProject } : tabContext;
    const parentProject = projectTarget(context);
    const projectName = context.project?.name ?? `프로젝트 ${context.projectId}`;
    const projectLabel = `프로젝트: ${projectName} (${context.projectId})`;
    const sessionName = context.session?.title ?? `세션 ${context.sessionId}`;
    const sessionLabel = `세션: ${sessionName} (${context.sessionId})${session.error ? " · 조회 실패" : ""}`;
    const tab = context.tab;
    const projectCurrent = tab?.kind === "project";
    const sessionCurrent = tab?.kind === "session";
    const browseProjects = <GroveButton type="button" appearance="link" onClick={onBrowseProjects}
        aria-label="프로젝트 탐색" aria-expanded={sidebarOpen}>Grove</GroveButton>;
    return <Stack as="nav" direction="horizontal" align="center" gap={splitProject ? 1 : 0} xstyle={navigationStyles.root}
        aria-label="현재 위치" data-testid="navigation-context"
        data-project-id={context.projectId} data-session-id={context.sessionId}>
        {splitProject && <>{browseProjects}<Icon name="chevronRight" size={12} /><Icon name="folder" size={14} /></>}
        {parentProject ? projectCurrent
            ? <HintText type="inherit" color="inherit" maxLines={1} xstyle={navigationStyles.project}
                aria-current="page" aria-label={projectLabel} hint={projectLabel}>{projectName}</HintText>
            : <GroveButton type="button" appearance="link" xstyle={navigationStyles.project}
            aria-label={`${projectLabel} 프로젝트 화면으로`}
            title={`${projectLabel} 프로젝트 화면으로`} onClick={() => open(parentProject)}>
            <HintText type="inherit" color="inherit" maxLines={1} hint={projectLabel}>{projectName}</HintText>
        </GroveButton> : browseProjects}
        {!projectCurrent && <VisuallyHidden>
            <GroveText as="span" aria-current="page" aria-label={sessionCurrent ? sessionLabel : undefined}>
                {sessionCurrent ? `세션 · ${sessionName}${session.error ? " · 조회 실패" : ""}`
                    : tab ? resourceLabel(tab) : layout ? "빈 영역" : "배치 불러오는 중…"}
            </GroveText>
        </VisuallyHidden>}
    </Stack>;
}
