import { Fragment, useId, useRef, useState } from "react";
import { useCollapsible } from "@astryxdesign/core/Collapsible";
import { Stack, StackItem } from "@astryxdesign/core/Stack";
import { Tab, TabList } from "@astryxdesign/core/TabList";
import { Heading } from "@astryxdesign/core/Heading";
import { List as GroveList, ListItem as GroveListItem } from "@astryxdesign/core/List";
import { Text as GroveText } from "@astryxdesign/core/Text";
import { Button as GroveButton } from "../design/Button";
import { StatusBadge } from "../design/StatusBadge";
import { ApiError, api } from "../api/client";
import type { Project, SearchHit, SearchPage, Session } from "../api/generated";
import { TextInput } from "../design/Fields";
import { historyPage, prefetchHistory } from "../state/historyQuery";
import { requestFocus } from "../state/focus";
import { useQuery } from "../state/store";
import { useDebouncedValue } from "../state/useDebouncedValue";
import { CreationDialog } from "./create/CreationDialog";
import { LoadingBar } from "./LoadingScreen";
import { When } from "./When";
import { Icon, searchGlyph } from "./icons";
import { chatLayout } from "./chat-layout.stylex";
import type { Opener } from "./Workspace";
import { useSessionPin } from "./sidebar/state";

const dayLabel = new Intl.DateTimeFormat("ko-KR", { year: "numeric", month: "long", day: "numeric", weekday: "long" });

// 기록을 둘러보는 동안 열린 탭과 마지막 작업 위치는 그대로 둔다.
export function ProjectHistoryDialog({ project, narrow, open, onClose }: { project: Project; narrow: boolean; open: Opener; onClose: () => void }) {
    const [archived, setArchived] = useState(false);
    const panelId = useId();
    const [query, setQuery] = useState("");
    const q = useDebouncedValue(query.trim(), 250);
    const warmOtherList = () => { if (!query.trim()) prefetchHistory(project.id, !archived); };
    return <CreationDialog label={`${project.name} 기록`} onClose={onClose} width="56em" fullscreen={narrow}>
        <Stack as="header" direction="horizontal" align="center" justify="between" gap={2}>
            {narrow ? <Stack gap={0.5} xstyle={chatLayout.headerTitle}>
                <GroveText color="secondary" type="supporting" maxLines={1}>{project.name}</GroveText>
                <Heading level={1}>대화 기록</Heading>
            </Stack> : <Heading level={2}>{project.name} 기록</Heading>}
            <GroveButton type="button" appearance="icon" aria-label="기록 닫기" onClick={onClose}><Icon name="close" /></GroveButton>
        </Stack>
        <Stack direction={narrow ? "vertical" : "horizontal"} align={narrow ? "stretch" : "center"} gap={2}>
            <StackItem size="fill"><TextInput type="search" size={narrow ? "md" : "sm"} startIcon={searchGlyph}
                label="대화 검색" isLabelHidden placeholder="제목·본문 검색" maxLength={200} value={query} onChange={setQuery} /></StackItem>
            {narrow ? <TabList value={archived ? "archived" : "active"} onChange={(tab) => setArchived(tab === "archived")}
                role="tablist" aria-label="대화 구분" hasDivider>
                <Tab value="active" label="대화" panelId={panelId} onPointerEnter={archived ? warmOtherList : undefined} onFocus={archived ? warmOtherList : undefined} />
                <Tab value="archived" label="보관된 대화" panelId={panelId} onPointerEnter={!archived ? warmOtherList : undefined} onFocus={!archived ? warmOtherList : undefined} />
            </TabList> : <GroveButton type="button" variant="secondary" density="compact" appearance="choice" aria-pressed={archived}
                onPointerEnter={warmOtherList} onFocus={warmOtherList} onPointerDown={warmOtherList} onClick={() => setArchived(!archived)}>
                보관된 대화{archived && <Icon name="close" size={12} />}
            </GroveButton>}
        </Stack>
        <Stack id={panelId} role={narrow ? "tabpanel" : undefined} aria-label={narrow ? (archived ? "보관된 대화" : "대화") : undefined}>
            {q ? <GroveList density="compact" edge="flush" hasDividers aria-label="검색 결과">
                <SearchResultPage offset={0} key={`${project.id}:${archived}`} projectId={project.id} q={q} narrow={narrow} archived={archived} open={open} />
            </GroveList> : <GroveList density="compact" edge="flush" hasDividers>
                <SessionPageList key={String(archived)} projectId={project.id} cursor="" previousDay="" narrow={narrow} archived={archived} open={open} />
            </GroveList>}
        </Stack>
    </CreationDialog>;
}

function SessionPageList(p: { projectId: string; cursor: string; previousDay: string; narrow: boolean; archived: boolean; open: Opener }) {
    const [more, setMore] = useState(false);
    const { key, read } = historyPage(p.projectId, p.archived, p.cursor);
    const page = useQuery(key, read);
    const warmNext = () => { if (page.data?.next_cursor) prefetchHistory(p.projectId, p.archived, page.data.next_cursor); };
    const items = page.data?.items ?? [];
    const today = new Date().toDateString();
    return (
        <>
            {page.loading && <LoadingBar label="기록 불러오는 중…" />}
            {page.error && <GroveListItem label={<GroveText color="error" role="alert">
                {page.error instanceof ApiError ? page.error.message : "대화 기록을 불러오지 못했어요."}
                {" "}<GroveButton type="button" appearance="link" onClick={page.reload}>다시 확인</GroveButton>
            </GroveText>} />}
            {items.map((s, i) => {
                const day = p.narrow ? new Date(s.updated_at).toDateString() : "";
                const showDay = p.narrow && day !== (i ? new Date(items[i - 1]!.updated_at).toDateString() : p.previousDay);
                return <Fragment key={s.id}>
                    {showDay && <GroveListItem label={<GroveText type="supporting" weight="medium" color="secondary">
                        {day === today && "오늘 · "}{dayLabel.format(new Date(s.updated_at))}
                    </GroveText>} />}
                    <HistoryRow session={s} preview={s.preview} narrow={p.narrow}
                        onOpen={() => p.open({ kind: "session", project_id: p.projectId, resource_id: s.id, title: s.title })} />
                </Fragment>;
            })}
            {page.data?.next_cursor && (more
                ? <SessionPageList {...p} cursor={page.data.next_cursor} previousDay={new Date(items[items.length - 1]!.updated_at).toDateString()} />
                : <GroveListItem label={
                    <GroveButton variant="secondary" onPointerEnter={warmNext} onFocus={warmNext} onPointerDown={warmNext} onClick={() => setMore(true)}>
                        더 보기
                    </GroveButton>
                } />
            )}
            {!page.loading && !page.error && p.cursor === "" && page.data?.items.length === 0 && <GroveListItem
                label={<GroveText color="secondary">{p.archived ? "보관된 대화가 없어요." : "아직 대화 기록이 없어요."}</GroveText>} />}
        </>
    );
}

function HistoryRow({ session, preview, narrow, search = false, onOpen }: {
    session: Session; preview: string | null; narrow: boolean; search?: boolean; onOpen: () => void;
}) {
    const button = useRef<HTMLButtonElement>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const previewId = useId();
    const { isOpen, toggle } = useCollapsible({ isCollapsible: { defaultIsOpen: false } });
    const { pinned, toggle: savePin } = useSessionPin({
        session, recent_id: session.recent?.id ?? null, recent_revision: session.recent?.revision ?? null,
    }, session.recent?.pinned ?? false);
    const togglePin = async () => {
        setBusy(true);
        setError("");
        try {
            await savePin();
        } catch (e) {
            setError(e instanceof ApiError ? e.message : "대화 고정 상태를 변경하지 못했어요.");
        } finally {
            setBusy(false);
        }
    };
    const pin = <GroveButton type="button" appearance="icon" density="compact" disabled={busy} aria-pressed={pinned}
        aria-label={pinned ? "상단 고정 해제" : "상단 고정"} title={pinned ? "상단 고정 해제" : "상단 고정"}
        onClick={() => void togglePin()}><Icon name={pinned ? "starFilled" : "star"} size={16} /></GroveButton>;
    const timestamp = <GroveText type="supporting" color="secondary" justify={narrow ? "start" : "end"}
        textWrap="nowrap" hasTabularNumbers data-testid="session-updated">
        <When at={session.updated_at} part={narrow && !search ? "minute" : "datetime"} titlePart="datetime" />
    </GroveText>;
    const badges = (!search || narrow) && <>
        {session.active_turn && (session.active_turn === "awaiting_input"
            ? <StatusBadge status="awaiting_input">답변 대기</StatusBadge>
            : <StatusBadge status="running">실행 중</StatusBadge>)}
        {session.pending_approvals > 0 && <StatusBadge status="awaiting_approval">승인 {session.pending_approvals}</StatusBadge>}
        {session.unreviewed_unknown > 0 && <StatusBadge status="unknown_result">결과 확인 필요</StatusBadge>}
    </>;
    return <GroveListItem data-testid={search ? "search-hit" : undefined} interactiveRef={narrow ? button : undefined}
        label={<Stack direction="horizontal" align="start" gap={2} paddingBlock={2}>
            <Stack width={32} xstyle={chatLayout.turnStatusAction}>
                {preview?.trim() && <GroveButton type="button" appearance="icon" aria-label={`${session.title} 미리보기 ${isOpen ? "접기" : "펼치기"}`}
                    aria-expanded={isOpen} aria-controls={isOpen ? previewId : undefined} onClick={toggle}>
                    <Icon name={isOpen ? "chevronDown" : "chevronRight"} size={16} />
                </GroveButton>}
            </Stack>
            <StackItem size="fill">
                <Stack gap={2}>
                    <Stack direction={narrow ? "vertical" : "horizontal"} align={narrow ? "start" : "center"} gap={narrow ? 1 : 2} minHeight={32}>
                        <GroveButton ref={button} appearance="link" xstyle={chatLayout.historyTitle} onClick={onOpen}>
                            <GroveText type={narrow ? "large" : "body"} weight="semibold" color="inherit"
                                maxLines={narrow ? 2 : 1} hasTruncateTooltip={false} xstyle={chatLayout.historyText}>
                                {!search && session.unread && <GroveText type="supporting" color="secondary" aria-label="읽지 않음" data-testid="session-unread">● </GroveText>}
                                {session.title}
                            </GroveText>
                        </GroveButton>
                        {!narrow && badges}
                        <Stack direction="horizontal" align="center" gap={2} wrap={narrow ? "wrap" : "nowrap"}
                            xstyle={!narrow && chatLayout.turnErrorRetry}>
                            {timestamp}{narrow && badges}{pin}
                        </Stack>
                    </Stack>
                    {preview && isOpen && <Stack id={previewId} paddingInlineStart={3} xstyle={chatLayout.historyPreview}>
                        <GroveText type="body" color="secondary" xstyle={chatLayout.historyText}>{preview}</GroveText>
                    </Stack>}
                    {error && <GroveText color="error" role="alert">{error}</GroveText>}
                </Stack>
            </StackItem>
        </Stack>} />;
}

const SEARCH_PAGE = 30;

// 제목과 본문을 함께 찾고, 본문에서 찾았으면 그 메시지로 이동한다.
type SearchProps = { projectId: string; q: string; narrow: boolean; archived: boolean; open: Opener; offset: number };

function SearchMore(p: SearchProps) {
    const [expanded, setExpanded] = useState(false);
    return expanded ? <SearchResultPage {...p} />
        : <GroveListItem label={<GroveButton variant="secondary" onClick={() => setExpanded(true)}>더 보기</GroveButton>} />;
}

function SearchResultPage(p: SearchProps) {
    const qs = new URLSearchParams({ q: p.q, body: "true", pinned_first: "true", project_id: p.projectId, limit: String(SEARCH_PAGE), offset: String(p.offset) });
    if (p.archived) qs.set("status", "archived");
    const page = useQuery<SearchPage>(`search:${p.projectId}:history:${qs}`, () => api.getContract("SearchPage", `/sessions/search?${qs}`),
        { keepPreviousData: true, scope: `search:${p.projectId}:${p.archived}:${p.offset}` });
    const next = p.offset + SEARCH_PAGE;
    const go = (hit: SearchHit) => {
        if (hit.match_seq != null) requestFocus(hit.session.id, hit.match_seq);
        p.open({ kind: "session", project_id: p.projectId, resource_id: hit.session.id, title: hit.session.title });
    };
    return (
        <>
            {page.loading && <LoadingBar label="검색 중…" />}
            {page.error && <GroveListItem label={<GroveText color="error" role="alert">
                {page.error instanceof ApiError ? page.error.message : "검색 결과를 불러오지 못했어요."}
                {" "}<GroveButton type="button" appearance="link" onClick={page.reload}>다시 확인</GroveButton>
            </GroveText>} />}
            {(!page.error || !page.isPreviousData) && (page.data?.items ?? []).map((hit) => (
                <HistoryRow key={hit.session.id} session={hit.session} preview={hit.snippet ?? hit.session.preview}
                    narrow={p.narrow} search onOpen={() => go(hit)} />
            ))}
            {!page.isPreviousData && page.data && page.data.total > next && <SearchMore key={p.q} {...p} offset={next} />}
            {!page.loading && !page.error && p.offset === 0 && page.data?.total === 0 && <GroveListItem
                label={<GroveText color="secondary">검색 결과가 없어요.</GroveText>} />}
        </>
    );
}
