import { StatusBadge } from "../design/StatusBadge";
import { Card } from "@astryxdesign/core/Card";
import { List as GroveList, ListItem as GroveListItem } from "@astryxdesign/core/List";
import { Text as GroveText } from "@astryxdesign/core/Text";
import { useEffect, useRef, useState } from "react";
import { ActionMenu } from "./ui/Controls";
import { ApiError, api } from "../api/client";
import type { RecentItem, RecentPage } from "../api/generated";
import { loadPrefs, savePrefs, usePrefs } from "../state/device";
import { type RecentIntent, retryIntent } from "../state/recentPatch";
import { effectiveRecentWindow, groupBySplit, recentSince, recentWindowLabel } from "../state/recentWindow";
import { When } from "./When";
import { invalidate, useQuery } from "../state/store";
import { DRAG_OPEN } from "../state/layout";
import type { Opener } from "./Workspace";
import { ServerActionButton } from "./pwa/ServerActionButton";
import { Stack } from "@astryxdesign/core/Stack";
import { Heading } from "@astryxdesign/core/Text";
import { Icon } from "./icons";
import { Button } from "../design/Button";

const STATUS: Record<string, string> = {
    running: "실행 중",
    awaiting_approval: "승인 대기",
    awaiting_input: "답변 대기",
    unknown_result: "결과 확인 필요",
    archived: "보관됨",
    missing: "삭제됨",
    project_unavailable: "프로젝트 없음",
};

const NO_LINKED: ReadonlySet<string> = new Set();

/// 분 단위 현재 시각. 시간 범위 하한을 1분마다 다시 계산한다.
function useMinute(): Date {
    const [now, setNow] = useState(() => new Date());
    useEffect(() => {
        const timer = setInterval(() => setNow(new Date()), 60_000);
        return () => clearInterval(timer);
    }, []);
    return now;
}

/// linked: 현재 배치에서 분할로 함께 열린 대화 ID. 원본처럼 한 묶음으로 보여 준다.
export function RecentPanel({ open, linked = NO_LINKED, presentation = "sidebar" }: {
    open: Opener; linked?: ReadonlySet<string>; presentation?: "sidebar" | "home";
}) {
    const [limit, setLimit] = useState(30);
    const [err, setErr] = useState<string | null>(null);
    const prefs = usePrefs();
    const range = effectiveRecentWindow(prefs.recentWindow, prefs.recentWindows);
    const now = useMinute();
    const since = range !== "all" ? recentSince(range, now) : "";
    const query = new URLSearchParams({ filter: "all", limit: String(limit), ...(since ? { since } : {}) }).toString();
    // 시각은 요청에만 쓰고 cache key는 범위별로 고정한다. 같은 범위는 즉시 다시 연다.
    const recent = useQuery<RecentPage>(`recent:range:${range}:${limit}`, () => api.get(`/recent?${query}`),
        { keepPreviousData: true, scope: "recent:range" });
    const previousMinute = useRef(now);
    useEffect(() => {
        if (previousMinute.current === now) return;
        previousMinute.current = now;
        invalidate("recent:range");
    }, [now]);

    const patch = async (it: RecentItem, intent: RecentIntent) => {
        setErr(null);
        try {
            await api.patch(`/recent/${it.id}`, { expected_revision: it.revision, ...intent });
        } catch (e) {
            // 다른 기기가 먼저 바꿨다: 이미 원하는 값이면 그대로 두고, 아니면 최신 값 위에 내 필드만 한 번 다시 적용한다.
            const current = e instanceof ApiError && e.code === "revision_conflict" ? (e.details as { current?: RecentItem } | undefined)?.current : undefined;
            const again = current ? retryIntent(current, intent) : null;
            try {
                if (again) await api.patch(`/recent/${it.id}`, again);
                else if (!current) throw e;
            } catch (retry) {
                setErr(retry instanceof ApiError ? retry.message : "변경 실패");
            }
        } finally {
            recent.reload();
        }
    };

    const openItem = (it: RecentItem, how: "here" | "right" | "down" = "here") => {
        if (it.kind === "session") open({ kind: "session", project_id: it.project_id, resource_id: it.resource_id, title: it.title }, how);
        else if (it.kind === "project") open({ kind: "project", project_id: it.project_id, resource_id: it.resource_id, title: it.title }, how);
        else if (it.kind === "terminal") open({ kind: "terminal", project_id: it.project_id, resource_id: it.resource_id, title: it.title }, how);
        else if (it.kind === "file") open({ kind: "file", project_id: it.project_id, resource_id: it.resource_id, filePath: it.resource_id, title: it.title }, how);
        else return;
        // 접근 기록은 갱신하되 대화의 정렬·시간 표시는 마지막 확정 답변을 그대로 쓴다.
        // view_state를 보내지 않아 읽던 위치·읽음 정보는 그대로 둔다.
        void api.post("/recent/touch", { kind: it.kind, project_id: it.project_id, resource_id: it.resource_id, title: it.title })
            .catch((e) => setErr(e instanceof ApiError ? e.message : "최근 접근 기록을 갱신하지 못했습니다."));
    };

    return (
        <Stack as="section" gap={2} paddingBlock={2} aria-label={presentation === "home" ? "홈 최근" : "최근"}>
            <Stack direction="horizontal" align="center" justify="between" gap={2} paddingInline={2} minHeight={32}>
                <Heading level={presentation === "home" ? 1 : 2} type={presentation === "home" ? undefined : "navigation"}>최근</Heading>
                <Stack direction="horizontal" gap={0} role="group" aria-label="시간 범위">
                    {[...prefs.recentWindows, "all" as const].map((option) => (
                        <Button key={option} appearance="choice" aria-pressed={range === option}
                            aria-label={`최근 ${recentWindowLabel(option)} 범위`} onClick={() => savePrefs({ ...loadPrefs(), recentWindow: option })}>
                            {recentWindowLabel(option)}
                        </Button>
                    ))}
                </Stack>
            </Stack>
            {err && <GroveText as="p" display="block" type="inherit" color="error" role="alert">{err}</GroveText>}
            {Boolean(recent.error) && <GroveText as="p" display="block" type="inherit" color="error" role="alert">
                {recent.error instanceof ApiError ? recent.error.message : "최근 목록을 불러오지 못했습니다."}
            </GroveText>}
            <GroveList density="compact" edge="flush" data-testid="recent-list" aria-busy={recent.loading}>
                {groupBySplit(recent.data?.items ?? [], linked).map(({ item, linked: members }) => members.length === 0 ? row(item) : (
                    <GroveListItem key={item.id} data-testid="recent-split-group" aria-label="분할로 함께 연 대화" label={
                        <Card variant="muted" padding={0}>
                        <GroveList density="compact" edge="flush">
                            {row(item, members.map((m) => m.title).join(", "))}
                            {members.map((m) => row(m, item.title))}
                        </GroveList>
                        </Card>
                    } />
                ))}
            </GroveList>
            {!recent.loading && recent.data?.items.length === 0 && <GroveText as="p" display="block" type="supporting" color="secondary">최근 항목 없음</GroveText>}
            {recent.data?.next_offset != null && (
                <Button variant="secondary" onClick={() => setLimit((l) => l + 30)}>
                    더 보기
                </Button>
            )}
        </Stack>
    );

    function row(it: RecentItem, linkedTo?: string) {
        return (
                    <GroveListItem key={it.id} data-testid={presentation === "home" ? "home-recent-item" : "recent-item"} label={
                        <Button type="button" appearance="navigation" density={presentation === "home" ? "touch" : undefined} onClick={() => openItem(it)} title={`${it.project_name} · ${it.title}${linkedTo ? ` · 분할로 함께 열림: ${linkedTo}` : ""} · 영역이나 가장자리로 끌어서 열 수 있습니다`}
                            draggable={["session", "project", "terminal", "file"].includes(it.kind)}
                            onDragStart={(e) => {
                                const target = { kind: it.kind, project_id: it.project_id, resource_id: it.resource_id, title: it.title, ...(it.kind === "file" ? { filePath: it.resource_id } : {}) };
                                e.dataTransfer.setData(DRAG_OPEN, JSON.stringify(target));
                                e.dataTransfer.effectAllowed = "copy";
                            }}
                        >
                            <GroveText type="inherit" color="inherit" maxLines={1} hasTruncateTooltip={false} weight={it.unread ? "bold" : "normal"}>
                                {it.pinned && <GroveText type="inherit" color="inherit" aria-label="고정됨">★ </GroveText>}
                                {it.title}
                                {STATUS[it.status] && <StatusBadge status={it.status}>{STATUS[it.status]}</StatusBadge>}
                                {it.unread && <GroveText type="supporting" color="secondary" aria-label="읽지 않음"> ●</GroveText>}
                                {linkedTo && <GroveText type="supporting" color="secondary" aria-label={`분할로 함께 열림: ${linkedTo}`}> ⧉</GroveText>}
                            </GroveText>
                            <GroveText type="supporting" color="secondary" maxLines={1} hasTruncateTooltip={false}>{it.project_name}</GroveText>
                            <GroveText type="supporting" color="secondary" data-testid="recent-time"> <When at={it.last_activity_at} relative /></GroveText>
                        </Button>
                    } endContent={
                        <ActionMenu label="최근 항목 관리">
                            <Stack gap={0.5}>
                            <Button appearance="navigation" title="오른쪽에 열기" aria-label="오른쪽에 열기" onClick={() => openItem(it, "right")}><Icon name="panel" />오른쪽에 열기</Button>
                            <Button appearance="navigation" title="아래에 열기" aria-label="아래에 열기" onClick={() => openItem(it, "down")}><Icon name="panelBottom" />아래에 열기</Button>
                            <ServerActionButton appearance="navigation" aria-pressed={it.pinned} aria-label={it.pinned ? "고정 해제" : "고정"} title={it.pinned ? "고정 해제" : "고정"} onClick={() => patch(it, { pinned: !it.pinned })}>
                                <Icon name="pin" />{it.pinned ? "고정 해제" : "고정"}
                            </ServerActionButton>
                            <ServerActionButton appearance="navigation" aria-label={it.hidden ? "다시 표시" : "최근에서 숨기기"}
                                title={it.hidden ? "다시 표시" : "최근에서 숨기기(삭제 아님, 새 메시지가 오면 다시 보임)"} onClick={() => patch(it, { hidden: !it.hidden })}>
                                <Icon name={it.hidden ? "restore" : "eyeOff"} />{it.hidden ? "다시 표시" : "최근에서 숨기기"}
                            </ServerActionButton>
                            </Stack>
                        </ActionMenu>
                    } />
        );
    }
}
