import { useEffect, useState } from "react";
import { ActionMenu } from "./ui/Controls";
import { ApiError, api } from "../api/client";
import type { RecentItem, RecentPage } from "../api/generated";
import { loadPrefs, savePrefs, usePrefs } from "../state/device";
import { type RecentIntent, retryIntent } from "../state/recentPatch";
import { effectiveRecentWindow, groupBySplit, recentSince, recentWindowLabel } from "../state/recentWindow";
import { When } from "./When";
import { useQuery } from "../state/store";
import { DRAG_OPEN } from "../state/layout";
import type { Opener } from "./Workspace";
import { ServerActionButton } from "./pwa/ServerActionButton";
import { Stack } from "@astryxdesign/core/Stack";
import { Heading } from "@astryxdesign/core/Text";

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
    const recent = useQuery<RecentPage>(`recent:${query}`, () => api.get(`/recent?${query}`));

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
        // 이미 보이는 탭으로 이동해 컴포넌트가 다시 mount되지 않아도 접근 시각은 갱신한다.
        // view_state를 보내지 않아 읽던 위치·읽음 정보는 그대로 둔다.
        void api.post("/recent/touch", { kind: it.kind, project_id: it.project_id, resource_id: it.resource_id, title: it.title })
            .catch((e) => setErr(e instanceof ApiError ? e.message : "최근 접근 기록을 갱신하지 못했습니다."));
    };

    return (
        <Stack as="section" className={presentation === "home" ? "home-recent" : "recent"} aria-label={presentation === "home" ? "홈 최근" : "최근"}>
            <div className="recent-head">
                <Heading level={presentation === "home" ? 1 : 2}>최근</Heading>
                <div className="chips" role="group" aria-label="시간 범위">
                    {[...prefs.recentWindows, "all" as const].map((option) => (
                        <button key={option} className={range === option ? "chip on" : "chip"} aria-pressed={range === option}
                            aria-label={`최근 ${recentWindowLabel(option)} 범위`} onClick={() => savePrefs({ ...loadPrefs(), recentWindow: option })}>
                            {recentWindowLabel(option)}
                        </button>
                    ))}
                </div>
            </div>
            {err && <p className="err" role="alert">{err}</p>}
            {Boolean(recent.error) && <p className="err" role="alert">
                {recent.error instanceof ApiError ? recent.error.message : "최근 목록을 불러오지 못했습니다."}
            </p>}
            <ul className="recent-list">
                {groupBySplit(recent.data?.items ?? [], linked).map(({ item, linked: members }) => members.length === 0 ? row(item) : (
                    <li key={item.id} className="recent-split" data-testid="recent-split-group" aria-label="분할로 함께 연 대화">
                        <ul>
                            {row(item, members.map((m) => m.title).join(", "))}
                            {members.map((m) => row(m, item.title))}
                        </ul>
                    </li>
                ))}
            </ul>
            {recent.data?.items.length === 0 && <p className="recent-empty">최근 항목 없음</p>}
            {recent.data?.next_offset != null && (
                <button className="ghost" onClick={() => setLimit((l) => l + 30)}>
                    더 보기
                </button>
            )}
        </Stack>
    );

    function row(it: RecentItem, linkedTo?: string) {
        return (
                    <li key={it.id} className={it.unread ? "unread" : ""} data-testid={presentation === "home" ? "home-recent-item" : "recent-item"}>
                        <button className="link" onClick={() => openItem(it)} title={`${it.project_name} · ${it.title}${linkedTo ? ` · 분할로 함께 열림: ${linkedTo}` : ""} · 영역이나 가장자리로 끌어서 열 수 있습니다`}
                            draggable={["session", "project", "terminal", "file"].includes(it.kind)}
                            onDragStart={(e) => {
                                const target = { kind: it.kind, project_id: it.project_id, resource_id: it.resource_id, title: it.title, ...(it.kind === "file" ? { filePath: it.resource_id } : {}) };
                                e.dataTransfer.setData(DRAG_OPEN, JSON.stringify(target));
                                e.dataTransfer.effectAllowed = "copy";
                            }}
                        >
                            <span className="recent-title">
                                {it.pinned && <span aria-label="고정됨">★ </span>}
                                {it.title}
                                {STATUS[it.status] && <span className={`status ${it.status}`}>{STATUS[it.status]}</span>}
                                {it.unread && <span className="dot" aria-label="읽지 않음" />}
                                {linkedTo && <span className="muted small" aria-label={`분할로 함께 열림: ${linkedTo}`}> ⧉</span>}
                            </span>
                            <span className="recent-project">{it.project_name}</span>
                            <span className="muted small" data-testid="recent-time"> <When at={it.last_activity_at} relative /></span>
                        </button>
                        <ActionMenu className="recent-actions" label="최근 항목 관리">
                            <div className="row-actions">
                            <button className="ghost small" title="오른쪽에 열기" aria-label="오른쪽에 열기" onClick={() => openItem(it, "right")}>⇥</button>
                            <button className="ghost small" title="아래에 열기" aria-label="아래에 열기" onClick={() => openItem(it, "down")}>⤓</button>
                            <ServerActionButton className="ghost small pin-toggle" aria-pressed={it.pinned} aria-label={it.pinned ? "고정 해제" : "고정"} title={it.pinned ? "고정 해제" : "고정"} onClick={() => patch(it, { pinned: !it.pinned })}>
                                {it.pinned ? "★" : "☆"}
                            </ServerActionButton>
                            <ServerActionButton className="ghost small" aria-label={it.hidden ? "다시 표시" : "최근에서 숨기기"}
                                title={it.hidden ? "다시 표시" : "최근에서 숨기기(삭제 아님, 새 메시지가 오면 다시 보임)"} onClick={() => patch(it, { hidden: !it.hidden })}>
                                {it.hidden ? "↺" : "–"}
                            </ServerActionButton>
                            </div>
                        </ActionMenu>
                    </li>
        );
    }
}
