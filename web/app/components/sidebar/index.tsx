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
import "./sidebar.css";

export function StatusIcon({ status }: { status: string }) {
    const value = STATUS[status] ?? STATUS.unknown!;
    // Text는 native title을 받지 않는다. 상태 기호의 hover 설명은 이 의미 있는 경계에 유지한다.
    return <span className={`sidebar-status sidebar-status-${status}`} data-testid="sidebar-status" title={value.label}>
        <GroveText type="inherit" color="inherit" aria-hidden="true">{value.icon}</GroveText> <GroveText type="inherit" color="inherit" className="sidebar-status-label">{value.label}</GroveText>
    </span>;
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
    return <li className="sidebar-session" data-testid="sidebar-session" data-session={s.id}>
        <GroveButton type="button" className="link sidebar-session-open" onClick={() => open(target)} title={s.preview ?? s.title}>
            <GroveText type="inherit" color="inherit" className="sidebar-session-title">{item.pinned && <GroveText type="inherit" color="inherit" aria-label="고정됨">★ </GroveText>}{s.title}</GroveText>
            <StatusIcon status={item.status} />
            {s.unread && <GroveText type="inherit" color="inherit" className="sidebar-unread">● 읽지 않음</GroveText>}
        </GroveButton>
        <ActionMenu className="sidebar-session-actions" label={`${s.title} 도구`}>
            <div role="toolbar" aria-label={`${s.title} 도구`} className="sidebar-toolbar" onKeyDown={toolbarKeys}>
            <GroveButton type="button" className="ghost small pin-toggle" disabled={busy} aria-pressed={item.pinned}
                aria-label={item.pinned ? "세션 고정 해제" : "세션 고정"} title={item.pinned ? "고정 해제" : "고정"}
                onClick={() => void run(() => pinSession(item, !item.pinned))}>
                {item.pinned ? "★" : "☆"}
            </GroveButton>
            <GroveButton type="button" className="ghost small" disabled={busy || !s.unread} aria-label="읽음 표시" title="읽음 표시"
                onClick={() => void run(() => markSessionRead(item))}>✓</GroveButton>
            {!narrow && <>
                <GroveButton type="button" className="ghost small" aria-label="세션 오른쪽에 열기" onClick={() => open(target, "right")}>⇥</GroveButton>
                <GroveButton type="button" className="ghost small" aria-label="세션 아래에 열기" onClick={() => open(target, "down")}>⤓</GroveButton>
            </>}
            </div>
        </ActionMenu>
        {error && <GroveText as="p" display="block" type="supporting" color="error" role="alert">{error}</GroveText>}
    </li>;
}

/// children은 Workspace의 기존 프로젝트 메뉴·라벨·분할 열기다. 최근 탭의 렌더링은 바꾸지 않는다.
export function SidebarProject({ project, children, open, narrow, onCreate }: {
    project: Project; children: ReactNode; open: Opener; narrow: boolean; onCreate: () => void;
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
    const projectMode = project.workspace_mode === "project";
    const spaces = useWorkspaces(project.id, projectMode);
    const groups = projectMode ? groupByWorkspace(data?.items ?? [], spaces) : [];
    return <section className="sidebar-project" aria-label={`${project.name} 탐색`} data-testid="sidebar-project" data-project-id={project.id}>
        {children}
        <div className="sidebar-project-summary">
            {status && <StatusIcon status={status} />}
            {unread > 0 && <GroveText type="inherit" color="inherit" className="sidebar-unread" aria-label={`읽지 않은 세션 ${unread}개`}>● 읽지 않음 {unread}</GroveText>}
            {!project.available && <GroveText type="inherit" color="warning">프로젝트 경로 없음</GroveText>}
        </div>
        {/* 프로젝트 행 오른쪽의 작은 도구. 이름은 접근성 이름으로 두고 화면에는 기호만 보인다. */}
        <ActionMenu className="sidebar-project-tools" label={`${project.name} 대화 도구`} trigger={<>
                {unreadOnly && <span className="dot" aria-label="읽지 않음 필터 적용 중" />}
                {data && <GroveText hasTabularNumbers type="inherit" color="inherit" className="sidebar-count">{data.total}</GroveText>}<GroveText type="inherit" color="inherit" aria-hidden="true">⌄</GroveText>
            </>}>
        <div className="sidebar-toolbar" role="toolbar" aria-label={`${project.name} 도구`} onKeyDown={toolbarKeys}>
            <GroveButton type="button" className="ghost small" disabled={!project.available} onClick={onCreate} aria-label="새 대화" title="새 대화">+</GroveButton>
            <GroveButton type="button" className="ghost small sidebar-expand" aria-expanded={expanded} aria-controls={listId}
                aria-label={`대화 ${expanded ? "접기" : "펼치기"}${data ? ` (${data.total})` : ""}`} title={expanded ? "대화 접기" : "대화 펼치기"}
                onClick={() => setExpanded((v) => !v)}>
                {data && <GroveText hasTabularNumbers type="inherit" color="inherit" className="sidebar-count">{data.total}</GroveText>}<GroveText type="inherit" color="inherit" aria-hidden="true">{expanded ? "▾" : "▸"}</GroveText>
            </GroveButton>
            <GroveButton type="button" className="ghost small" aria-pressed={unreadOnly} aria-label="읽지 않음만" title="읽지 않음만"
                onClick={() => { setUnreadOnly((v) => !v); setOffset(0); }}>●</GroveButton>
            <GroveButton type="button" className="ghost small" onClick={page.reload} aria-label="목록 새로고침" title="목록 새로고침">↻</GroveButton>
        </div>
        </ActionMenu>
        {Boolean(page.error) && <GroveText as="p" display="block" type="supporting" color="error" role="alert">대화 목록을 불러오지 못했습니다. 목록 새로고침으로 다시 시도하세요.</GroveText>}
        {!data && page.loading && <GroveText as="p" display="block" type="supporting" color="secondary" role="status">대화 불러오는 중…</GroveText>}
        <div id={listId} hidden={!expanded}>
            {projectMode ? (
                // 프로젝트 모드: 프로젝트 → 워크스페이스 → 대화. 프로젝트 폴더가 기본 워크스페이스다.
                groups.map((g) => (
                    <section key={g.id ?? "root"} className="sidebar-workspace" aria-label={`워크스페이스 ${g.name}`} data-testid="sidebar-workspace" data-worktree={g.id ?? ""}>
                        <Heading level={3} color="inherit" className="sidebar-workspace-name">{g.name}</Heading>
                        <ul className="sidebar-sessions">
                            {g.items.map((item) => <SessionRow key={item.session.id} item={item} open={open} narrow={narrow} />)}
                        </ul>
                    </section>
                ))
            ) : (
                // 단일 모드: 프로젝트 → 대화
                <ul className="sidebar-sessions">
                    {data?.items.map((item) => <SessionRow key={item.session.id} item={item} open={open} narrow={narrow} />)}
                </ul>
            )}
            {data?.items.length === 0 && unreadOnly && <GroveText as="p" display="block" type="supporting" color="secondary">읽지 않은 대화가 없습니다.</GroveText>}
            <div className="sidebar-toolbar" role="group" aria-label="대화 페이지">
                {offset > 0 && <GroveButton type="button" className="ghost small" onClick={() => setOffset(Math.max(0, offset - 30))}>이전 대화</GroveButton>}
                {data?.next_offset != null && <GroveButton type="button" className="ghost small" onClick={() => setOffset(data.next_offset!)}>다음 대화</GroveButton>}
            </div>
        </div>
    </section>;
}
