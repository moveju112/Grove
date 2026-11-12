import { useState } from "react";
import { When } from "./When";
import { api } from "../api/client";
import { useQuery } from "../state/store";
import type { Opener } from "./Workspace";

export type RecoveryItem = {
    kind: "turn" | "tool_call";
    id: string;
    session_id: string;
    project_id: string;
    session_title: string;
    archived: boolean;
    status: string;
    at: string;
    code: string | null;
    message: string | null;
    tool_name: string | null;
    turn_id: string | null;
    evidence: { text_chars: number; tool_calls: number } | { corrupt: true; kind: string } | null;
};
type Page = { items: RecoveryItem[]; next_cursor: string | null };

/// 한 항목의 상태 설명. 검토·확인은 과거 실행의 성공 판정이 아니다(REC-010).
export function recoveryLabel(i: RecoveryItem): string {
    if (i.kind === "tool_call") return `도구 ${i.tool_name ?? ""} 결과 불명`;
    const base = i.status === "interrupted" ? "요청 중단" : "요청 실패";
    if (!i.evidence) return base;
    if ("corrupt" in i.evidence) return `${base} · 중단 증거 손상(원본 보존)`;
    return `${base} · 확정 전 응답 ${i.evidence.text_chars}자 보존`;
}

/// 확인하지 않은 중단 요청과 결과 불명 도구(REC-009·010). 항목을 누르면 해당 대화로 이동하고, 재실행·검토는 대화에서 고른다.
export function RecoveryPanel({ open }: { open: Opener }) {
    const q = useQuery<Page>("recovery", () => api.get("/recovery?limit=50"));
    const [more, setMore] = useState<Page | null>(null);
    const items = [...(q.data?.items ?? []), ...(more?.items ?? [])];
    const next = more ? more.next_cursor : q.data?.next_cursor;
    if (items.length === 0) return null;
    return (
        <details className="recovery" data-testid="recovery">
            <summary>
                확인 필요{" "}
                <span className="badge" aria-label={`확인할 기록 ${items.length}${next ? "개 이상" : "개"}`}>
                    {items.length}
                    {next ? "+" : ""}
                </span>
            </summary>
            <p className="muted small">자동으로 다시 실행하지 않습니다. 대화에서 결과를 확인한 뒤 다시 실행·검토·닫기를 고르세요.</p>
            <ul className="session-list">
                {items.map((i) => (
                    <li key={`${i.kind}:${i.id}`} data-testid="recovery-item">
                        <button className="ghost" onClick={() => open({ kind: "session", project_id: i.project_id, resource_id: i.session_id, title: i.session_title })}>
                            <strong>{i.session_title}</strong>
                            <span className="small"> {recoveryLabel(i)}</span>
                            {i.message && <span className="muted small"> · {i.message.slice(0, 80)}</span>}
                            <span className="muted small"> · <When at={i.at} /></span>
                            {i.archived && <span className="muted small"> · 보관됨</span>}
                        </button>
                    </li>
                ))}
            </ul>
            {next && (
                <button className="ghost small" onClick={() => void api.get<Page>(`/recovery?limit=50&cursor=${encodeURIComponent(next)}`).then((p) => setMore({ items: [...(more?.items ?? []), ...p.items], next_cursor: p.next_cursor }))}>
                    더 보기
                </button>
            )}
        </details>
    );
}
