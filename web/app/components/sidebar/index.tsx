import { HintText } from "../../design/HintText";
import { Icon } from "../icons";
import { List, ListItem } from "@astryxdesign/core/List";
import { Stack as GroveStack, StackItem } from "@astryxdesign/core/Stack";
import { VisuallyHidden } from "@astryxdesign/core/VisuallyHidden";
import { StatusDot } from "@astryxdesign/core/StatusDot";
import { Heading } from "@astryxdesign/core/Heading";
import { Text as GroveText } from "@astryxdesign/core/Text";
import { Button as GroveButton } from "../../design/Button";
import { useId, useState, type KeyboardEvent, type ReactNode } from "react";
import { ActionMenu } from "../ui/Controls";
import { ApiError, api } from "../../api/client";
import type { Project } from "../../api/generated";
import { useQuery } from "../../state/store";
import type { Opener } from "../Workspace";
import { useWorkspaces } from "../../state/workspaces";
import { groupByWorkspace, markSessionRead, pinSession, projectStatus, STATUS, type SidebarPage, type SidebarSession } from "./state";

export function StatusIcon({ status }: { status: string }) {
    const value = STATUS[status] ?? STATUS.unknown!;
    const quiet = status === "idle" || status === "completed" || status === "cancelled";
    return <HintText type="supporting" color={status === "failed" ? "error" : status === "unknown_result" || status === "interrupted" ? "warning" : "secondary"}
        data-testid="sidebar-status" hint={value.label}>
        <GroveText type="inherit" color="inherit" aria-hidden="true">{value.icon}</GroveText>{" "}
        {quiet ? <VisuallyHidden>{value.label}</VisuallyHidden> : <GroveText type="inherit" color="inherit">{value.label}</GroveText>}
    </HintText>;
}

// Tab으로도 모든 버튼을 사용할 수 있고 toolbar 안에서는 방향키로 빠르게 이동한다.
export function toolbarKeys(event: KeyboardEvent<HTMLElement>) {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
    const index = buttons.indexOf(event.target as HTMLButtonElement);
    if (index < 0 || buttons.length === 0) return;
    event.preventDefault();
    const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1
        : (index + (event.key === "ArrowRight" ? 1 : -1) + buttons.length) % buttons.length;
    buttons[next]!.focus();
}

export function SessionRow({ item, open, narrow }: { item: SidebarSession; open: Opener; narrow: boolean }) {
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const s = item.session;
    const target = { kind: "session" as const, project_id: s.project_id, resource_id: s.id, title: s.title };
    const run = async (action: () => Promise<void>) => {
        setBusy(true);
        setError(null);
        try { await action(); }
        catch (e) { setError(e instanceof ApiError ? e.message : "변경 결과를 확인하지 못했습니다. 목록을 새로고침해 확인하세요."); }
        finally { setBusy(false); }
    };
    return <ListItem data-testid="sidebar-session" data-session={s.id} label={<>
        <GroveButton type="button" appearance="navigation" data-testid="sidebar-session-open" onClick={() => open(target)} title={s.preview ?? s.title}>
            <StackItem as="span" size="fill"><GroveText type="inherit" color="inherit" maxLines={1} hasTruncateTooltip={false} data-testid="sidebar-session-title">{item.pinned && <GroveText type="inherit" color="inherit" aria-label="고정됨">★ </GroveText>}{s.title}</GroveText></StackItem>
            <StatusIcon status={item.status} />
            {s.unread && <GroveText type="supporting" color="secondary" weight="semibold" data-testid="sidebar-unread">● 읽지 않음</GroveText>}
        </GroveButton>
        {error && <GroveText as="p" display="block" type="supporting" color="error" role="alert">{error}</GroveText>}
    </>} endContent={<ActionMenu label={`${s.title} 도구`} data-testid="sidebar-session-actions">
            <GroveStack gap={1} role="toolbar" aria-label={`${s.title} 도구`} onKeyDown={toolbarKeys}>
            <GroveButton type="button" appearance="navigation" disabled={busy} aria-pressed={item.pinned}
                aria-label={item.pinned ? "세션 고정 해제" : "세션 고정"} title={item.pinned ? "고정 해제" : "고정"}
                onClick={() => void run(() => pinSession(item, !item.pinned))}>
                <Icon name="pin" />{item.pinned ? "고정 해제" : "고정"}
            </GroveButton>
            <GroveButton type="button" appearance="navigation" disabled={busy || !s.unread} aria-label="읽음 표시" title="읽음 표시"
                onClick={() => void run(() => markSessionRead(item))}><Icon name="check" />읽음 표시</GroveButton>
            {!narrow && <>
                <GroveButton type="button" appearance="navigation" aria-label="세션 오른쪽에 열기" onClick={() => open(target, "right")}><Icon name="panel" />오른쪽에 열기</GroveButton>
                <GroveButton type="button" appearance="navigation" aria-label="세션 아래에 열기" onClick={() => open(target, "down")}><Icon name="panelBottom" />아래에 열기</GroveButton>
            </>}
            </GroveStack>
        </ActionMenu>} />;
}

/// children은 Workspace의 기존 프로젝트 메뉴·라벨·분할 열기다. 최근 탭의 렌더링은 바꾸지 않는다.
export function SidebarProject({ project, children, open, narrow }: {
    project: Project; children: ReactNode; open: Opener; narrow: boolean;
}) {
    if (project.workspace_mode !== "project") {
        return <GroveStack as="section" gap={0} aria-label={`${project.name} 탐색`} data-testid="sidebar-project" data-project-id={project.id}>
            {children}
        </GroveStack>;
    }
    return <ProjectWorkspaceTree project={project} open={open} narrow={narrow}>{children}</ProjectWorkspaceTree>;
}

function ProjectWorkspaceTree({ project, children, open, narrow }: {
    project: Project; children: ReactNode; open: Opener; narrow: boolean;
}) {
    const [expanded, setExpanded] = useState(true);
    const [unreadOnly, setUnreadOnly] = useState(false);
    const [offset, setOffset] = useState(0);
    const listId = useId();
    const query = new URLSearchParams({ offset: String(offset), limit: "30", unread_only: String(unreadOnly) });
    // 기존 recent:* invalidation을 재사용해 메시지·턴·도구·읽음·핀 변경과 resync를 모두 받는다.
    const page = useQuery<SidebarPage>(`recent:sidebar:${project.id}:${query}`, () => api.get(`/projects/${project.id}/sidebar?${query}`),
        { keepPreviousData: true, scope: `sidebar:${project.id}` });
    const data = page.data;
    const unread = data?.unread ?? 0;
    const status = data ? projectStatus(data.statuses) : null;
    const spaces = useWorkspaces(project.id, true);
    const groups = groupByWorkspace(data?.items ?? [], spaces);
    return <GroveStack as="section" gap={0} aria-label={`${project.name} 탐색`} data-testid="sidebar-project" data-project-id={project.id}>
        <GroveStack direction="horizontal" align="center" gap={0}>
        <StackItem size="fill">{children}</StackItem>
        {/* 프로젝트 행 오른쪽의 작은 도구. 이름은 접근성 이름으로 두고 화면에는 기호만 보인다. */}
        <ActionMenu data-testid="sidebar-project-tools" label={`${project.name} 대화 도구`} trigger={<>
                {unreadOnly && <StatusDot variant="accent" label="읽지 않음 필터 적용 중" />}
                {data && <GroveText hasTabularNumbers type="supporting" color="secondary">{data.total}</GroveText>}<GroveText type="inherit" color="inherit" aria-hidden="true">⌄</GroveText>
            </>}>
        <GroveStack gap={1} role="toolbar" aria-label={`${project.name} 도구`} onKeyDown={toolbarKeys}>
            <GroveButton type="button" appearance="navigation" aria-expanded={expanded} aria-controls={listId}
                aria-label={`대화 ${expanded ? "접기" : "펼치기"}${data ? ` (${data.total})` : ""}`} title={expanded ? "대화 접기" : "대화 펼치기"}
                onClick={() => setExpanded((v) => !v)}>
                <Icon name="chevronRight" />대화 {expanded ? "접기" : "펼치기"}{data && <GroveText hasTabularNumbers type="supporting" color="secondary">({data.total})</GroveText>}
            </GroveButton>
            <GroveButton type="button" appearance="navigation" aria-pressed={unreadOnly} aria-label="읽지 않음만" title="읽지 않음만"
                onClick={() => { setUnreadOnly((v) => !v); setOffset(0); }}><Icon name="bell" />읽지 않음만</GroveButton>
            <GroveButton type="button" appearance="navigation" onClick={page.reload} aria-label="목록 새로고침" title="목록 새로고침"><Icon name="restore" />목록 새로고침</GroveButton>
        </GroveStack>
        </ActionMenu>
        </GroveStack>
        {(unread > 0 || !project.available || (status && !["idle", "completed", "cancelled"].includes(status))) && <GroveStack direction="horizontal" align="center" wrap="wrap" paddingInline={2} gap={1} data-testid="sidebar-project-summary">
            {status && <StatusIcon status={status} />}
            {unread > 0 && <GroveText type="supporting" color="secondary" weight="semibold" aria-label={`읽지 않은 세션 ${unread}개`}>● 읽지 않음 {unread}</GroveText>}
            {!project.available && <GroveText type="supporting" color="warning">프로젝트 경로 없음</GroveText>}
        </GroveStack>}
        {Boolean(page.error) && <GroveText as="p" display="block" type="supporting" color="error" role="alert">대화 목록을 불러오지 못했습니다. 목록 새로고침으로 다시 시도하세요.</GroveText>}
        {!data && page.loading && <GroveText as="p" display="block" type="supporting" color="secondary" role="status">대화 불러오는 중…</GroveText>}
        <GroveStack gap={0} paddingInlineStart={3} id={listId} hidden={!expanded}>
            {/* 프로젝트 모드: 프로젝트 → 워크스페이스 → 대화. */}
            {groups.map((g) => (
                    <GroveStack as="section" gap={0} paddingInlineStart={2} key={g.id ?? "root"} aria-label={`워크스페이스 ${g.name}`} data-testid="sidebar-workspace" data-worktree={g.id ?? ""}>
                        <Heading level={3} type="navigation" color="secondary">{g.name}</Heading>
                        <List density="compact" edge="flush">
                            {g.items.map((item) => <SessionRow key={item.session.id} item={item} open={open} narrow={narrow} />)}
                        </List>
                    </GroveStack>
                ))}
            {data?.items.length === 0 && unreadOnly && <GroveText as="p" display="block" type="supporting" color="secondary">읽지 않은 대화가 없습니다.</GroveText>}
            <GroveStack gap={1} direction="horizontal" align="center" wrap="wrap" role="group" aria-label="대화 페이지">
                {offset > 0 && <GroveButton type="button" variant="secondary" density="compact" onClick={() => setOffset(Math.max(0, offset - 30))}>이전 대화</GroveButton>}
                {data?.next_offset != null && <GroveButton type="button" variant="secondary" density="compact" onClick={() => setOffset(data.next_offset!)}>다음 대화</GroveButton>}
            </GroveStack>
        </GroveStack>
    </GroveStack>;
}
