import { useState } from "react";
import { ApiError, api } from "../api/client";
import type { RecentItem, RecentPage } from "../api/generated";
import { useQuery } from "../state/store";
import type { Opener } from "./Workspace";

const FILTERS: [string, string][] = [
    ["all", "전체"],
    ["pinned", "고정"],
    ["running", "실행 중"],
    ["awaiting_approval", "승인 대기"],
    ["awaiting_input", "답변 대기"],
    ["unread", "읽지 않음"],
    ["hidden", "숨김"],
];

const STATUS: Record<string, string> = {
    running: "실행 중",
    awaiting_approval: "승인 대기",
    awaiting_input: "답변 대기",
    unknown_result: "결과 확인 필요",
    archived: "보관됨",
    missing: "삭제됨",
    project_unavailable: "프로젝트 없음",
};

export function RecentPanel({ open }: { open: Opener }) {
    const [filter, setFilter] = useState("all");
    const [q, setQ] = useState("");
    const [limit, setLimit] = useState(30);
    const [err, setErr] = useState<string | null>(null);
    const query = new URLSearchParams({ filter, q, limit: String(limit) }).toString();
    const recent = useQuery<RecentPage>(`recent:${query}`, () => api.get(`/recent?${query}`));

    const patch = async (it: RecentItem, body: object) => {
        try {
            await api.patch(`/recent/${it.id}`, { expected_revision: it.revision, ...body });
        } catch (e) {
            setErr(e instanceof ApiError ? e.message : "변경 실패");
            recent.reload();
        }
    };

    const openItem = (it: RecentItem, how: "here" | "right" | "down" = "here") => {
        if (it.kind === "session") open({ kind: "session", project_id: it.project_id, resource_id: it.resource_id, title: it.title }, how);
        else if (it.kind === "project") open({ kind: "project", project_id: it.project_id, resource_id: it.resource_id, title: it.title }, how);
        else if (it.kind === "terminal") open({ kind: "terminal", project_id: it.project_id, resource_id: it.resource_id, title: it.title }, how);
    };

    return (
        <section className="recent" aria-label="최근">
            <h2>최근</h2>
            <input type="search" placeholder="최근 항목 검색" value={q} onChange={(e) => setQ(e.target.value)} aria-label="최근 항목 검색" />
            <div className="chips" role="group" aria-label="필터">
                {FILTERS.map(([k, label]) => (
                    <button key={k} className={filter === k ? "chip on" : "chip"} aria-pressed={filter === k} onClick={() => setFilter(k)}>
                        {label}
                    </button>
                ))}
            </div>
            {err && <p className="err" role="alert">{err}</p>}
            <ul className="recent-list">
                {(recent.data?.items ?? []).map((it) => (
                    <li key={it.id} className={it.unread ? "unread" : ""} data-testid="recent-item">
                        <button className="link" onClick={() => openItem(it)} title={`${it.project_name} · ${it.title}`}>
                            <span className="badge">{it.project_name}</span> {it.title}
                            {STATUS[it.status] && <span className={`status ${it.status}`}>{STATUS[it.status]}</span>}
                            {it.unread && <span className="dot" aria-label="읽지 않음" />}
                        </button>
                        <span className="row-actions">
                            <button className="ghost small" title="오른쪽에 열기" aria-label="오른쪽에 열기" onClick={() => openItem(it, "right")}>⇥</button>
                            <button className="ghost small" title="아래에 열기" aria-label="아래에 열기" onClick={() => openItem(it, "down")}>⤓</button>
                            <button className="ghost small" aria-label={it.pinned ? "고정 해제" : "고정"} title={it.pinned ? "고정 해제" : "고정"} onClick={() => patch(it, { pinned: !it.pinned })}>
                                {it.pinned ? "★" : "☆"}
                            </button>
                            <button className="ghost small" aria-label={it.hidden ? "다시 표시" : "최근에서 숨기기"} title={it.hidden ? "다시 표시" : "최근에서 숨기기(삭제 아님)"} onClick={() => patch(it, { hidden: !it.hidden })}>
                                {it.hidden ? "↺" : "–"}
                            </button>
                        </span>
                    </li>
                ))}
            </ul>
            {recent.data?.items.length === 0 && <p className="muted">항목이 없습니다.</p>}
            {recent.data?.next_offset != null && (
                <button className="ghost" onClick={() => setLimit((l) => l + 30)}>
                    더 보기 ({recent.data.total - recent.data.items.length}개 남음)
                </button>
            )}
        </section>
    );
}
