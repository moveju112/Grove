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
import { navigationContext, projectTarget, resourceLabel } from "./context";
import { navigationStyles } from "./navigation.stylex";

export type NavigationContextProps = {
    layout?: Layout;
    projects: Project[];
    open: Opener;
    onBrowseProjects: () => void;
    sidebarOpen: boolean;
};

export function NavigationContext({ layout, projects, open, onBrowseProjects, sidebarOpen }: NavigationContextProps) {
    const selected = navigationContext(layout, projects);
    const session = useQuery<Session>(selected.sessionId ? `session:${selected.sessionId}` : null,
        () => api.get(`/sessions/${selected.sessionId}`));
    const context = navigationContext(layout, projects, session.data);
    const parentProject = projectTarget(context);
    const projectName = context.project?.name ?? `프로젝트 ${context.projectId}`;
    const projectLabel = `프로젝트: ${projectName} (${context.projectId})`;
    const sessionName = context.session?.title ?? `세션 ${context.sessionId}`;
    const sessionLabel = `세션: ${sessionName} (${context.sessionId})${session.error ? " · 조회 실패" : ""}`;
    const tab = context.tab;
    const projectCurrent = tab?.kind === "project";
    const sessionCurrent = tab?.kind === "session";
    return <Stack as="nav" direction="horizontal" align="center" gap={0} xstyle={navigationStyles.root}
        aria-label="현재 위치" data-testid="navigation-context"
        data-project-id={context.projectId} data-session-id={context.sessionId}>
        {parentProject ? projectCurrent
            ? <HintText type="inherit" color="inherit" maxLines={1} xstyle={navigationStyles.project}
                aria-current="page" aria-label={projectLabel} hint={projectLabel}>{projectName}</HintText>
            : <GroveButton type="button" appearance="link" xstyle={navigationStyles.project}
            aria-label={`${projectLabel} 대화 목록으로`}
            title={`${projectLabel} 대화 목록으로`} onClick={() => open(parentProject)}>
            <HintText type="inherit" color="inherit" maxLines={1} hint={projectLabel}>{projectName}</HintText>
        </GroveButton> : <GroveButton type="button" appearance="link" onClick={onBrowseProjects}
            aria-label="프로젝트 탐색" aria-expanded={sidebarOpen}>Grove</GroveButton>}
        {!projectCurrent && <VisuallyHidden>
            <GroveText as="span" aria-current="page" aria-label={sessionCurrent ? sessionLabel : undefined}>
                {sessionCurrent ? `세션 · ${sessionName}${session.error ? " · 조회 실패" : ""}`
                    : tab ? resourceLabel(tab) : layout ? "빈 영역" : "배치 불러오는 중…"}
            </GroveText>
        </VisuallyHidden>}
    </Stack>;
}
