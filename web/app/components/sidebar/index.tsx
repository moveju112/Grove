import { useId, useState, type KeyboardEvent, type ReactNode } from "react";
import { ApiError, api } from "../../api/client";
import type { Project } from "../../api/generated";
import { useQuery } from "../../state/store";
import type { Opener } from "../Workspace";
import { markSessionRead, pinSession, projectStatus, STATUS, type SidebarPage, type SidebarSession } from "./state";
import "./sidebar.css";

export function StatusIcon({ status }: { status: string }) {
    const value = STATUS[status] ?? STATUS.unknown;
    return <span className={`sidebar-status sidebar-status-${status}`} data-testid="sidebar-status">
        <span aria-hidden="true">{value.icon}</span> <span>{value.label}</span>
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
    buttons[next].focus();
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
        <button type="button" className="link sidebar-session-open" onClick={() => open(target)} title={s.preview ?? s.title}>
            <span className="sidebar-session-title">{item.pinned && <span aria-label="고정됨">★ </span>}{s.title}</span>
            <StatusIcon status={item.status} />
            {s.unread && <span className="sidebar-unread">● 읽지 않음</span>}
        </button>
        <div role="toolbar" aria-label={`${s.title} 도구`} className="sidebar-toolbar" onKeyDown={toolbarKeys}>
            <button type="button" className="ghost small" disabled={busy} aria-pressed={item.pinned}
                aria-label={item.pinned ? "세션 고정 해제" : "세션 고정"} onClick={() => void run(() => pinSession(item, !item.pinned))}>
                {item.pinned ? "★ 고정 해제" : "☆ 고정"}
            </button>
            <button type="button" className="ghost small" disabled={busy || !s.unread}
                onClick={() => void run(() => markSessionRead(item))}>읽음 표시</button>
            {!narrow && <>
                <button type="button" className="ghost small" aria-label="세션 오른쪽에 열기" onClick={() => open(target, "right")}>⇥</button>
                <button type="button" className="ghost small" aria-label="세션 아래에 열기" onClick={() => open(target, "down")}>⤓</button>
            </>}
        </div>
        {error && <p className="err small" role="alert">{error}</p>}
    </li>;
}

/// children은 Workspace의 기존 프로젝트 메뉴·라벨·분할 열기다. 최근 탭의 렌더링은 바꾸지 않는다.
export function SidebarProject({ project, children, open, narrow }: {
    project: Project; children: ReactNode; open: Opener; narrow: boolean;
}) {
    const [expanded, setExpanded] = useState(true);
    const [unreadOnly, setUnreadOnly] = useState(false);
    const [offset, setOffset] = useState(0);
    const listId = useId();
    const query = new URLSearchParams({ offset: String(offset), limit: "30", unread_only: String(unreadOnly) });
    // 기존 recent:* invalidation을 재사용해 메시지·턴·도구·읽음·핀 변경과 resync를 모두 받는다.
    const page = useQuery<SidebarPage>(`recent:sidebar:${project.id}:${query}`, () => api.get(`/projects/${project.id}/sidebar?${query}`));
    const data = page.data;
    const unread = data?.unread ?? 0;
    const status = data ? projectStatus(data.statuses) : null;
    return <section className="sidebar-project" aria-label={`${project.name} 탐색`} data-testid="sidebar-project" data-project-id={project.id}>
        {children}
        <div className="sidebar-project-summary">
            {status && <StatusIcon status={status} />}
            {unread > 0 && <span className="sidebar-unread" aria-label={`읽지 않은 세션 ${unread}개`}>● 읽지 않음 {unread}</span>}
            {!project.available && <span className="warn">프로젝트 경로 없음</span>}
        </div>
        <div className="sidebar-toolbar" role="toolbar" aria-label={`${project.name} 도구`} onKeyDown={toolbarKeys}>
            <button type="button" className="ghost small" aria-expanded={expanded} aria-controls={listId}
                onClick={() => setExpanded((v) => !v)}>대화 {expanded ? "접기" : "펼치기"}{data ? ` (${data.total})` : ""}</button>
            <button type="button" className="ghost small" aria-pressed={unreadOnly}
                onClick={() => { setUnreadOnly((v) => !v); setOffset(0); }}>읽지 않음만</button>
            <button type="button" className="ghost small" onClick={page.reload}>목록 새로고침</button>
        </div>
        {Boolean(page.error) && <p className="err small" role="alert">대화 목록을 불러오지 못했습니다. 목록 새로고침으로 다시 시도하세요.</p>}
        {!data && page.loading && <p className="muted small" role="status">대화 불러오는 중…</p>}
        <div id={listId} hidden={!expanded}>
            <ul className="sidebar-sessions">
                {data?.items.map((item) => <SessionRow key={item.session.id} item={item} open={open} narrow={narrow} />)}
            </ul>
            {data?.items.length === 0 && <p className="muted small">{unreadOnly ? "읽지 않은 대화가 없습니다." : "이 페이지에 대화가 없습니다."}</p>}
            <div className="sidebar-toolbar" role="group" aria-label="대화 페이지">
                {offset > 0 && <button type="button" className="ghost small" onClick={() => setOffset(Math.max(0, offset - 30))}>이전 대화</button>}
                {data?.next_offset != null && <button type="button" className="ghost small" onClick={() => setOffset(data.next_offset!)}>다음 대화</button>}
            </div>
        </div>
    </section>;
}
