import { StatusBadge } from "../design/StatusBadge";
import { Card } from "@astryxdesign/core/Card";
import { List as GroveList, ListItem as GroveListItem } from "@astryxdesign/core/List";
import { Text as GroveText } from "@astryxdesign/core/Text";
import { useEffect, useRef, useState } from "react";
import { ApiError, api } from "../api/client";
import type { RecentItem, RecentPage } from "../api/generated";
import { loadPrefs, savePrefs, usePrefs } from "../state/device";
import { type RecentIntent, patchRecent } from "../state/recentPatch";
import { effectiveRecentWindow, groupBySplit, recentSince, recentWindowLabel, type RecentSplitGroup } from "../state/recentWindow";
import { When } from "./When";
import { invalidate, useQuery } from "../state/store";
import { DRAG_OPEN } from "../state/layout";
import type { Opener } from "./Workspace";
import { ServerActionButton } from "./pwa/ServerActionButton";
import { Stack } from "@astryxdesign/core/Stack";
import { Heading } from "@astryxdesign/core/Text";
import { Icon } from "./icons";
import { Button } from "../design/Button";
import { workspaceStyles } from "./workspace.stylex";

const STATUS: Record<string, string> = {
    queued: "실행 대기",
    awaiting_approval: "승인 대기",
    awaiting_input: "답변 대기",
    unknown_result: "결과 확인 필요",
    archived: "보관됨",
    missing: "삭제됨",
    project_unavailable: "프로젝트 없음",
    failed: "오류",
    interrupted: "중단됨",
    cancelled: "취소됨",
};

const NO_SPLITS: readonly RecentSplitGroup[] = [];

/// 분 단위 현재 시각. 시간 범위 하한을 1분마다 다시 계산한다.
function useMinute(): Date {
    const [now, setNow] = useState(() => new Date());
    useEffect(() => {
        const timer = setInterval(() => setNow(new Date()), 60_000);
        return () => clearInterval(timer);
    }, []);
    return now;
}

export function RecentPanel({ open, splitGroups = NO_SPLITS, presentation = "sidebar" }: {
    open: Opener; splitGroups?: readonly RecentSplitGroup[]; presentation?: "sidebar" | "home";
}) {
    const [limit, setLimit] = useState(30);
    const [err, setErr] = useState<string | null>(null);
    const prefs = usePrefs();
    const range = effectiveRecentWindow(prefs.recentWindow, prefs.recentWindows);
    const now = useMinute();
    const since = recentSince(range, now);
    const query = new URLSearchParams({ filter: "all", limit: String(limit), since }).toString();
    // 시각은 요청에만 쓰고 cache key는 범위별로 고정한다. 같은 범위는 즉시 다시 연다.
    const recent = useQuery<RecentPage>(`recent:range:${range}:${limit}`, () => api.get(`/recent?${query}`),
        { keepPreviousData: true, scope: "recent:range" });
    // 이전 데몬에서 반환하는 터미널 기록도 최근 목록에 표시하지 않는다.
    const items = recent.data?.items.filter((it) => it.kind !== "terminal");
    const previousMinute = useRef(now);
    useEffect(() => {
        if (previousMinute.current === now) return;
        previousMinute.current = now;
        invalidate("recent:range");
    }, [now]);

    const patch = async (it: RecentItem, intent: RecentIntent) => {
        setErr(null);
        try {
            await patchRecent(it, intent);
        } catch (e) {
            setErr(e instanceof ApiError ? e.message : "변경 실패");
        } finally {
            recent.reload();
        }
    };

    const openItem = (it: RecentItem, how: "here" | "right" | "down" = "here") => {
        if (it.kind === "session") open({ kind: "session", project_id: it.project_id, resource_id: it.resource_id, title: it.title }, how);
        else if (it.kind === "project") open({ kind: "project", project_id: it.project_id, resource_id: it.resource_id, title: it.title }, how);
        else if (it.kind === "file") open({ kind: "file", project_id: it.project_id, resource_id: it.resource_id, filePath: it.resource_id, title: it.title }, how);
        else return;
        // 접근 기록은 갱신하되 대화의 정렬·시간 표시는 마지막 확정 답변을 그대로 쓴다.
        // view_state를 보내지 않아 읽던 위치·읽음 정보는 그대로 둔다.
        // 완료 확인은 클릭한 요청 ID만 보낸다. 그 뒤 도착한 다른 완료까지 확인하지 않는다.
        void api.post("/recent/touch", {
            kind: it.kind, project_id: it.project_id, resource_id: it.resource_id, title: it.title,
            ...(it.kind === "session" && it.completion_unread && it.completed_turn_id
                ? { seen_completed_turn_id: it.completed_turn_id } : {}),
        })
            .catch((e) => setErr(e instanceof ApiError ? e.message : "최근 접근 기록을 갱신하지 못했습니다."));
    };

    return (
        <Stack as="section" gap={presentation === "sidebar" ? 0 : 2} paddingBlock={presentation === "sidebar" ? 0 : 2}
            xstyle={presentation === "sidebar" && workspaceStyles.recentPanel} aria-label={presentation === "home" ? "홈 최근" : "최근"}>
            <Stack direction="horizontal" align="center" justify="between" gap={2} paddingInline={2} minHeight={32}>
                <Heading level={presentation === "home" ? 1 : 2} type={presentation === "home" ? undefined : "navigation"}>최근</Heading>
                <Stack direction="horizontal" gap={0} role="group" aria-label="시간 범위">
                    {prefs.recentWindows.map((option) => (
                        <Button key={option} appearance="choice" aria-pressed={range === option}
                            aria-label={`최근 ${recentWindowLabel(option)} 범위`} onClick={() => savePrefs({ ...loadPrefs(), recentWindow: option })}>
                            {recentWindowLabel(option)}
                        </Button>
                    ))}
                </Stack>
            </Stack>
            <Stack gap={0} xstyle={presentation === "sidebar" && workspaceStyles.recentItems}
                role={presentation === "sidebar" ? "region" : undefined} aria-label={presentation === "sidebar" ? "최근 목록" : undefined}
                tabIndex={presentation === "sidebar" ? 0 : undefined} data-testid="recent-scroll">
            {err && <GroveText as="p" display="block" type="inherit" color="error" role="alert">{err}</GroveText>}
            {Boolean(recent.error) && <GroveText as="p" display="block" type="inherit" color="error" role="alert">
                {recent.error instanceof ApiError ? recent.error.message : "최근 목록을 불러오지 못했습니다."}
            </GroveText>}
            <GroveList density="compact" edge="flush" xstyle={presentation === "sidebar" && workspaceStyles.recentList} data-testid="recent-list" aria-busy={recent.loading}>
                {groupBySplit(items ?? [], splitGroups).map(({ item, linked: members }) => members.length === 0 ? row(item) : (
                    <GroveListItem key={item.id} xstyle={presentation === "sidebar" && workspaceStyles.recentRow} data-testid="recent-split-group" aria-label="분할로 함께 연 대화" label={
                        <Card variant="muted" padding={0} xstyle={workspaceStyles.recentGroup} data-testid="recent-split-surface">
                        <GroveList density="compact" edge="flush" xstyle={presentation === "sidebar" && workspaceStyles.recentList}>
                            {row(item, members.map((m) => m.title).join(", "))}
                            {members.map((m) => row(m, [item, ...members].filter((other) => other !== m).map((other) => other.title).join(", ")))}
                        </GroveList>
                        </Card>
                    } />
                ))}
            </GroveList>
            {!recent.loading && items?.length === 0 && <GroveText as="p" display="block" type="supporting" color="secondary">최근 항목 없음</GroveText>}
            {recent.data?.next_offset != null && (
                <Button variant="secondary" onClick={() => setLimit((l) => l + 30)}>
                    더 보기
                </Button>
            )}
            </Stack>
        </Stack>
    );

    function row(it: RecentItem, linkedTo?: string) {
        const running = it.kind === "session" && it.status === "running";
        const completed = it.kind === "session" && it.completion_unread;
        return (
                    <GroveListItem key={it.id} xstyle={[presentation === "sidebar" && workspaceStyles.recentRow, workspaceStyles.recentState]}
                        data-testid={presentation === "home" ? "home-recent-item" : "recent-item"}
                        data-recent-state={running ? "running" : completed ? "completed" : undefined}
                        data-session={it.kind === "session" ? it.resource_id : undefined} label={
                        <Button type="button" appearance="navigation" density={presentation === "home" ? "touch" : undefined}
                            xstyle={presentation === "sidebar" && [workspaceStyles.recentRowControl, workspaceStyles.recentTitle]}
                            aria-description={running ? "실행 중" : completed ? "완료 · 확인 안 함" : undefined}
                            onClick={() => openItem(it)} title={`${it.project_name} · ${it.title}${linkedTo ? ` · 분할로 함께 열림: ${linkedTo}` : ""} · 영역이나 가장자리로 끌어서 열 수 있습니다`}
                            draggable={["session", "project", "file"].includes(it.kind)}
                            onDragStart={(e) => {
                                const target = { kind: it.kind, project_id: it.project_id, resource_id: it.resource_id, title: it.title, ...(it.kind === "file" ? { filePath: it.resource_id } : {}) };
                                e.dataTransfer.setData(DRAG_OPEN, JSON.stringify(target));
                                e.dataTransfer.effectAllowed = "copy";
                            }}
                        >
                            <GroveText type="inherit" color="inherit" maxLines={1} hasTruncateTooltip={false} weight={completed ? "bold" : "normal"}>
                                {it.pinned && <GroveText type="inherit" color="inherit" aria-label="고정됨">★ </GroveText>}
                                {it.title}
                                {STATUS[it.status] && <StatusBadge status={it.status}>{STATUS[it.status]}</StatusBadge>}
                                {it.unread && it.status !== "running" && !it.completion_unread && <GroveText type="supporting" color="secondary" aria-label="읽지 않음"> ●</GroveText>}
                                {linkedTo && <GroveText type="supporting" color="secondary" aria-label={`분할로 함께 열림: ${linkedTo}`}> ⧉</GroveText>}
                            </GroveText>
                        </Button>
                    } endContent={
                        <Stack direction="horizontal" align="center" gap={0} xstyle={workspaceStyles.recentActions}>
                            <GroveText type="supporting" color="secondary" textWrap="nowrap" xstyle={workspaceStyles.recentTime} data-testid="recent-time">
                                <When at={it.last_activity_at} relative compact />
                            </GroveText>
                            <ServerActionButton appearance="icon" density="compact" width="var(--spacing-8)"
                                xstyle={[workspaceStyles.recentClose, presentation === "sidebar" && workspaceStyles.recentRowControl]}
                                aria-label="최근에서 숨기기" title="최근에서 숨기기" onClick={() => patch(it, { hidden: true })}>
                                <Icon name="close" size={12} />
                            </ServerActionButton>
                        </Stack>
                    } />
        );
    }
}
