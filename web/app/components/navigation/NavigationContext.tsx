import { HintText } from "../../design/HintText";
import { Breadcrumbs, BreadcrumbItem } from "@astryxdesign/core/Breadcrumbs";
import { Stack } from "@astryxdesign/core/Stack";
import { Text as GroveText } from "@astryxdesign/core/Text";
import { Button as GroveButton } from "../../design/Button";
import { api } from "../../api/client";
import type { Project, Session } from "../../api/generated";
import type { Layout } from "../../state/layout";
import { useQuery } from "../../state/store";
import type { Opener } from "../Workspace";
import { hostAddress, navigationContext, projectTarget, resourceLabel, sessionTarget } from "./context";
import { navigationStyles } from "./navigation.stylex";

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
    return <Stack direction="horizontal" align="center" gap={1} xstyle={navigationStyles.root}>
        <Breadcrumbs label="현재 위치" variant="supporting" xstyle={navigationStyles.trail} data-testid="navigation-context"
            data-project-id={context.projectId} data-session-id={context.sessionId}
            separator={<GroveText color="secondary" aria-hidden="true">/</GroveText>}>
            <BreadcrumbItem xstyle={navigationStyles.host} isCurrent={false}>
                <HintText aria-label={`현재 호스트: ${address}`} hint={`현재 호스트: ${address}`}>{address}</HintText>
            </BreadcrumbItem>
            <BreadcrumbItem xstyle={navigationStyles.browse} isCurrent={false}>
                <GroveButton type="button" appearance="link" onClick={onBrowseProjects}
                    aria-label="프로젝트 탐색" aria-expanded={sidebarOpen} title="사이드바에서 프로젝트 탐색">프로젝트</GroveButton>
            </BreadcrumbItem>
            {parentProject && <BreadcrumbItem xstyle={[navigationStyles.item, projectCurrent && navigationStyles.current, projectCurrent && navigationStyles.duplicate]} isCurrent={false}>
                {projectCurrent
                    ? <HintText display="block" maxLines={1} xstyle={navigationStyles.duplicate} aria-current="page" aria-label={projectLabel} hint={projectLabel}>{projectName}</HintText>
                    : <GroveButton type="button" appearance="link" aria-label={`${projectLabel} 대화 목록으로`}
                        title={`${projectLabel} 대화 목록으로`} onClick={() => open(parentProject)}><GroveText type="inherit" color="inherit" maxLines={1}>{projectName}</GroveText></GroveButton>}
            </BreadcrumbItem>}
            {parentSession && <BreadcrumbItem xstyle={[navigationStyles.item, sessionCurrent && navigationStyles.current, sessionCurrent && navigationStyles.duplicate]} isCurrent={false}>
                {sessionCurrent
                    ? <HintText display="block" maxLines={1} xstyle={navigationStyles.duplicate} aria-current="page" aria-label={sessionLabel} hint={sessionLabel}>세션 · {sessionName}{session.error ? " · 조회 실패" : ""}</HintText>
                    : <GroveButton type="button" appearance="link" aria-label={`${sessionLabel} 열기`} title={sessionLabel}
                        onClick={() => open(parentSession)}><GroveText type="inherit" color="inherit" maxLines={1}>세션 · {sessionName}</GroveText></GroveButton>}
            </BreadcrumbItem>}
            {!projectCurrent && !sessionCurrent && <BreadcrumbItem xstyle={navigationStyles.current} isCurrent={false}>
                <HintText display="block" aria-current="page" hint={tab ? resourceLabel(tab) : undefined}>
                    {tab ? resourceLabel(tab) : layout ? "빈 영역" : "배치 불러오는 중…"}
                </HintText>
            </BreadcrumbItem>}
        </Breadcrumbs>
        {context.panes > 1 && <GroveText type="supporting" color="secondary" xstyle={navigationStyles.pane} aria-label={`현재 영역 ${context.pane}, 전체 ${context.panes}개`}>
            영역 {context.pane}/{context.panes}
        </GroveText>}
    </Stack>;
}
