import { Text as GroveText } from "@astryxdesign/core/Text";
import { Button as GroveButton } from "../design/Button";
import { useEffect, useState } from "react";
import { When } from "./When";
import { api } from "../api/client";
import { useQuery } from "../state/store";
import type { Opener } from "./Workspace";
import { requestFocus } from "../state/focus";
import { useCapability } from "../state/capabilities";
import { Icon } from "./icons";
import { DetailDialog } from "./ui/Controls";
import { BooleanSelect } from "./BooleanSelect";
import { TextInput } from "../design/Fields";

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
        <DetailDialog className="search" data-testid="search-panel" label="대화 검색" title={<><Icon name="search" size={16} />대화 검색</>}>
            {supported !== false && <select aria-label="검색 방식" value={recall ? "recall" : "sessions"} onChange={(e) => setRecall(e.target.value === "recall")}>
                <option value="sessions">대화 검색</option><option value="recall">메시지 회상(키워드)</option>
            </select>}
            <TextInput type="search" label="대화 검색어" isLabelHidden placeholder={recall ? "과거 메시지의 키워드" : "제목·본문 검색"} value={q} onChange={setQ} />
            <div className="inline wrap small">
                {!recall && <BooleanSelect label="본문 포함" value={body} onChange={setBody} />}
                {recall && <BooleanSelect label="보관된 대화·프로젝트 포함" value={archived} onChange={setArchived} />}
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
            {err && <GroveText as="p" display="block" type="inherit" color="error" role="alert">{err}</GroveText>}
            {res && (
                <>
                    <GroveText as="p" display="block" type="supporting" color="secondary" data-testid="search-total">{res.total}개</GroveText>
                    <ul className="session-list">
                        {res.items.map((h) => (
                            <li key={`${h.id}:${h.match_seq ?? "-"}`} data-testid="search-hit">
                                <GroveButton
                                    className="ghost"
                                    data-dialog-close
                                    onClick={() => {
                                        // 본문에서 찾았으면 그 메시지로 이동한다(UI-026).
                                        if (h.match_seq != null) requestFocus(h.id, h.match_seq);
                                        open({ kind: "session", project_id: h.project_id, resource_id: h.id, title: h.title });
                                    }}
                                >
                                    <strong>{h.title}</strong> <GroveText type="supporting" color="secondary">{h.project_name} · <When at={h.updated_at} />{h.archived_at ? " · 보관" : ""}</GroveText>
                                    {h.source && <GroveText type="supporting" color="secondary"> · {h.source.role} · 원문 #{h.source.seq}</GroveText>}
                                    {h.snippet && <GroveText type="supporting" color="inherit" className="snippet"> {h.snippet}</GroveText>}
                                </GroveButton>
                            </li>
                        ))}
                    </ul>
                    {recall && <div className="inline small">
                        <GroveButton type="button" className="ghost" disabled={!res.offset} onClick={() => page(Math.max(0, (res.offset ?? 0) - 30))}>이전 회상 결과</GroveButton>
                        <GroveButton type="button" className="ghost" disabled={res.next_offset == null} onClick={() => res.next_offset != null && page(res.next_offset)}>다음 회상 결과</GroveButton>
                    </div>}
                </>
            )}
        </DetailDialog>
    );
}
