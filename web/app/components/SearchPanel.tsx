import { useEffect, useState } from "react";
import { When } from "./When";
import { api } from "../api/client";
import { useQuery } from "../state/store";
import type { Opener } from "./Workspace";
import { requestFocus } from "../state/focus";
import { useCapability } from "../state/capabilities";

type Hit = { id: string; title: string; project_id: string; project_name: string; updated_at: string; snippet: string | null; match_seq: number | null; archived_at: string | null; source?: { message_id: string; role: string; seq: number } };
type Project = { id: string; name: string };

const STATUS: [string, string][] = [
    ["", "보관 제외 전체"],
    ["running", "실행 중"],
    ["awaiting_approval", "승인 대기"],
    ["awaiting_input", "답변 대기"],
    ["unknown_result", "결과 불명"],
    ["archived", "보관됨"],
];

/// 프로젝트를 가로지르는 대화 검색(제목·본문·상태·프로젝트·기간).
export function SearchPanel({ open }: { open: Opener }) {
    const projects = useQuery<Project[]>("projects", () => api.get("/projects"));
    const [q, setQ] = useState("");
    const [body, setBody] = useState(true);
    const [status, setStatus] = useState("");
    const [project, setProject] = useState("");
    const [days, setDays] = useState(0);
    const supported = useCapability("recall_keyword_v1");
    const [recall, setRecall] = useState(false);
    const [archived, setArchived] = useState(false);
    const [url, setUrl] = useState<string | null>(null);
    const result = useQuery<{ items: Hit[]; total: number; offset?: number; next_offset?: number | null }>(url ? `search:${url}` : null, () => api.get(url!));
    const res = url ? result.data : undefined;
    const err = result.error instanceof Error ? result.error.message : null;

    useEffect(() => {
        if ((recall && !q.trim()) || (!q.trim() && !status && !project && !days)) {
            setUrl(null);
            return;
        }
        // 입력이 멈춘 뒤 조회한다. 서버 이벤트·재접속 때는 공용 cache가 같은 검색도 갱신한다.
        const t = setTimeout(() => {
            const p = new URLSearchParams({ q: q.trim(), body: String(body), limit: "30" });
            if (status && !recall) p.set("status", status);
            if (recall) p.set("include_archived", String(archived));
            if (project) p.set("project_id", project);
            if (days) p.set("from", new Date(Date.now() - days * 86_400_000).toISOString());
            setUrl(`${recall ? "/recall" : "/sessions/search"}?${p}`);
        }, 250);
        return () => {
            clearTimeout(t);
        };
    }, [q, body, status, project, days, recall, archived]);

    const page = (offset: number) => {
        if (!url) return;
        const [path, query] = url.split("?");
        const params = new URLSearchParams(query);
        params.set("offset", String(offset));
        setUrl(`${path}?${params}`);
    };

    return (
        <details className="search" data-testid="search-panel">
            <summary>대화 검색</summary>
            {supported !== false && <select aria-label="검색 방식" value={recall ? "recall" : "sessions"} onChange={(e) => setRecall(e.target.value === "recall")}>
                <option value="sessions">대화 검색</option><option value="recall">메시지 회상(키워드)</option>
            </select>}
            <input type="search" aria-label="대화 검색어" placeholder={recall ? "과거 메시지의 키워드" : "제목·본문 검색"} value={q} onChange={(e) => setQ(e.target.value)} />
            {recall && <p className="muted small">의미 검색이 아닌 본문 부분 일치 검색입니다. 기간은 메시지 작성 시각 기준이며, 결과를 누르면 원문으로 이동합니다.</p>}
            <div className="inline wrap small">
                {!recall && <label className="check"><input type="checkbox" checked={body} onChange={(e) => setBody(e.target.checked)} /> 본문 포함</label>}
                {recall && <label className="check"><input type="checkbox" checked={archived} onChange={(e) => setArchived(e.target.checked)} /> 보관된 대화·프로젝트 포함</label>}
                {!recall && <select aria-label="검색 상태" value={status} onChange={(e) => setStatus(e.target.value)}>
                    {STATUS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                </select>}
                <select aria-label="검색 프로젝트" value={project} onChange={(e) => setProject(e.target.value)}>
                    <option value="">모든 프로젝트</option>
                    {(projects.data ?? []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
                <select aria-label="검색 기간" value={days} onChange={(e) => setDays(Number(e.target.value))}>
                    <option value={0}>전체 기간</option>
                    <option value={1}>1일</option>
                    <option value={7}>7일</option>
                    <option value={30}>30일</option>
                </select>
            </div>
            {err && <p className="err" role="alert">{err}</p>}
            {res && (
                <>
                    <p className="muted small" data-testid="search-total">{res.total}개</p>
                    <ul className="session-list">
                        {res.items.map((h) => (
                            <li key={`${h.id}:${h.match_seq ?? "-"}`} data-testid="search-hit">
                                <button
                                    className="ghost"
                                    onClick={() => {
                                        // 본문에서 찾았으면 그 메시지로 이동한다(UI-026).
                                        if (h.match_seq != null) requestFocus(h.id, h.match_seq);
                                        open({ kind: "session", project_id: h.project_id, resource_id: h.id, title: h.title });
                                    }}
                                >
                                    <strong>{h.title}</strong> <span className="muted small">{h.project_name} · <When at={h.updated_at} />{h.archived_at ? " · 보관" : ""}</span>
                                    {h.source && <span className="muted small"> · {h.source.role} · 원문 #{h.source.seq}</span>}
                                    {h.snippet && <span className="small snippet"> {h.snippet}</span>}
                                </button>
                            </li>
                        ))}
                    </ul>
                    {recall && <div className="inline small">
                        <button type="button" className="ghost" disabled={!res.offset} onClick={() => page(Math.max(0, (res.offset ?? 0) - 30))}>이전 회상 결과</button>
                        <button type="button" className="ghost" disabled={res.next_offset == null} onClick={() => res.next_offset != null && page(res.next_offset)}>다음 회상 결과</button>
                    </div>}
                </>
            )}
        </details>
    );
}
