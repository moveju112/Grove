import { useState } from "react";
import { Stack } from "@astryxdesign/core/Stack";
import { Heading } from "@astryxdesign/core/Heading";
import { List as GroveList, ListItem as GroveListItem } from "@astryxdesign/core/List";
import { Text as GroveText } from "@astryxdesign/core/Text";
import { Button as GroveButton } from "../design/Button";
import { StatusBadge } from "../design/StatusBadge";
import { ApiError, api } from "../api/client";
import type { Project, SessionPage } from "../api/generated";
import { useQuery } from "../state/store";
import { CreationDialog } from "./create/CreationDialog";
import { LoadingBar } from "./LoadingScreen";
import { When } from "./When";
import { Icon } from "./icons";
import { chatLayout } from "./chat-layout.stylex";
import type { Opener } from "./Workspace";

// 기록을 둘러보는 동안 열린 탭과 마지막 작업 위치는 그대로 둔다.
export function ProjectHistoryDialog({ project, open, onClose }: { project: Project; open: Opener; onClose: () => void }) {
    const [archived, setArchived] = useState(false);
    const [pages, setPages] = useState<string[]>([""]);
    return <CreationDialog label={`${project.name} 기록`} onClose={onClose} width="56em">
        <Stack as="header" direction="horizontal" align="center" justify="between" gap={2}>
            <Heading level={2}>{project.name} 기록</Heading>
            <GroveButton type="button" appearance="icon" aria-label="기록 닫기" onClick={onClose}><Icon name="close" /></GroveButton>
        </Stack>
        <Stack direction="horizontal" align="center" gap={2}>
            <GroveButton type="button" variant="secondary" density="compact" appearance="choice" aria-pressed={archived}
                onClick={() => { setArchived((value) => !value); setPages([""]); }}>
                보관된 대화{archived && <Icon name="close" size={12} />}
            </GroveButton>
        </Stack>
        <GroveList density="compact" edge="flush" hasDividers>
            {pages.map((cursor, i) => <SessionPageList key={cursor + i} projectId={project.id} cursor={cursor} archived={archived}
                open={open} onMore={(next) => setPages((current) => current.includes(next) ? current : [...current, next])} last={i === pages.length - 1} />)}
        </GroveList>
    </CreationDialog>;
}

function SessionPageList(p: { projectId: string; cursor: string; archived: boolean; open: Opener; onMore: (c: string) => void; last: boolean }) {
    const qs = new URLSearchParams({ limit: "30", archived: String(p.archived) });
    if (p.cursor) qs.set("cursor", p.cursor);
    const page = useQuery<SessionPage>(`sessions:${p.projectId}:${qs}`, () => api.get(`/projects/${p.projectId}/sessions?${qs}`),
        { keepPreviousData: true, scope: `sessions:${p.projectId}:${p.cursor}` });
    return (
        <>
            {page.loading && <LoadingBar label="기록 불러오는 중…" />}
            {page.error && <GroveListItem label={<GroveText color="error" role="alert">
                {page.error instanceof ApiError ? page.error.message : "대화 기록을 불러오지 못했어요."}
                {" "}<GroveButton type="button" appearance="link" onClick={page.reload}>다시 확인</GroveButton>
            </GroveText>} />}
            {(page.data?.items ?? []).map((s) => (
                <GroveListItem key={s.id} label={<Stack direction="horizontal" align="center" gap={1}>
                    <GroveButton appearance="link" xstyle={chatLayout.sessionTitle} onClick={() => p.open({ kind: "session", project_id: p.projectId, resource_id: s.id, title: s.title })}>
                        <GroveText type="inherit" color="inherit" maxLines={1} hasTruncateTooltip={false}>
                        {s.unread && <GroveText type="supporting" color="secondary" aria-label="읽지 않음" data-testid="session-unread">● </GroveText>}
                        {s.title}
                        </GroveText>
                    </GroveButton>
                    {s.preview && <GroveText type="supporting" color="secondary" maxLines={1} xstyle={chatLayout.sessionPreview}>{s.preview}</GroveText>}
                    {s.active_turn === "awaiting_input" ? (
                        <StatusBadge status="awaiting_input">답변 대기</StatusBadge>
                    ) : (
                        s.active_turn && <StatusBadge status="running">실행 중</StatusBadge>
                    )}
                    {s.pending_approvals > 0 && <StatusBadge status="awaiting_approval">승인 {s.pending_approvals}</StatusBadge>}
                    {s.unreviewed_unknown > 0 && <StatusBadge status="unknown_result">결과 확인 필요</StatusBadge>}
                </Stack>} endContent={<GroveText type="supporting" color="secondary" justify="end" textWrap="nowrap" hasTabularNumbers data-testid="session-updated"><When at={s.updated_at} /></GroveText>} />
            ))}
            {p.last && page.data?.next_cursor && (
                <GroveListItem label={
                    <GroveButton variant="secondary" onClick={() => p.onMore(page.data!.next_cursor!)}>
                        더 보기
                    </GroveButton>
                } />
            )}
            {!page.loading && !page.error && p.cursor === "" && page.data?.items.length === 0 && <GroveListItem
                label={<GroveText color="secondary">{p.archived ? "보관된 대화가 없어요." : "아직 대화 기록이 없어요."}</GroveText>} />}
        </>
    );
}
