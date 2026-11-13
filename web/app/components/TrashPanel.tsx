import { useRef, useState } from "react";
import { Panel } from "./ui/Controls";
import { ApiError, api, newKey } from "../api/client";
import { useQuery } from "../state/store";
import { ServerActionButton } from "./pwa/ServerActionButton";

type Item = { id: string; path: string; deleted_at: string | null; is_dir: boolean; status: "trashed" | "needs_review" | "purging" };
type Attempt = { id: string; op: "restore" | "delete"; key: string; confirm?: string };

/// 응답이 유실되면 같은 키로 결과를 다시 확인한다. 새 요청으로 파일 작업을 반복하지 않는다.
export function TrashPanel({ projectId }: { projectId: string }) {
    const q = useQuery<{ items: Item[] }>(`trash:${projectId}`, () => api.get(`/projects/${projectId}/trash`));
    const [err, setErr] = useState<string | null>(null);
    const [attempt, setAttempt] = useState<Attempt | null>(null);
    const [busy, setBusy] = useState(false);
    const active = useRef(false);
    const items = q.data?.items ?? [];
    const act = async (a: Attempt) => {
        if (active.current) return;
        active.current = true;
        setBusy(true);
        setErr(null);
        setAttempt(a);
        try {
            await api.post(`/trash/${a.id}/${a.op}`, a.confirm === undefined ? {} : { confirm: a.confirm }, { key: a.key });
            setAttempt(null);
        } catch (e) {
            setErr(e instanceof ApiError ? e.message : "응답을 받지 못했습니다. 같은 요청의 결과를 다시 확인할 수 있습니다.");
            if (e instanceof ApiError && !e.retryable) setAttempt(null);
        } finally {
            active.current = false;
            setBusy(false);
            q.reload();
        }
    };
    return (
        <Panel className="trash" data-testid="trash-panel" title={`휴지통${items.length > 0 ? ` · ${items.length}` : ""}`}>
            {(err || Boolean(q.error)) && <p className="err" role="alert">{err ?? "휴지통 목록을 불러오지 못했습니다"}</p>}
            {Boolean(q.error) && <button className="ghost small" onClick={q.reload}>목록 다시 불러오기</button>}
            {attempt && !busy && <ServerActionButton className="ghost small" onClick={() => void act(attempt)}>같은 요청 결과 확인</ServerActionButton>}
            {q.loading && items.length === 0 && <p className="muted small" role="status">불러오는 중…</p>}
            {!q.loading && !q.error && items.length === 0 && <p className="muted small">비어 있습니다</p>}
            <ul className="session-list">
                {items.map((t) => (
                    <li key={t.id} data-testid="trash-row">
                        <code className="small">{t.path}{t.is_dir ? "/" : ""}</code>{" "}
                        {t.deleted_at && <span className="muted small">{t.deleted_at.slice(0, 16).replace("T", " ")}</span>}
                        {t.status === "needs_review" && <span className="err small">중단된 작업 · 원본과 휴지통 확인 필요</span>}
                        {t.status === "purging" && <span className="muted small">보존 기간이 지나 정리 중</span>}
                        <ServerActionButton className="ghost small" disabled={busy || attempt !== null || t.status !== "trashed"} onClick={() => void act({ id: t.id, op: "restore", key: newKey() })}>
                            복원
                        </ServerActionButton>
                        <ServerActionButton className="ghost small" disabled={busy || attempt !== null} onClick={() => {
                            const c = prompt(`영구 삭제하면 되돌릴 수 없습니다. 확인하려면 ${t.path} 를 그대로 입력하세요`);
                            if (c !== null) void act({ id: t.id, op: "delete", key: newKey(), confirm: c });
                        }}>
                            영구 삭제
                        </ServerActionButton>
                    </li>
                ))}
            </ul>
        </Panel>
    );
}
