import { useRef, useState } from "react";
import { ApiError, api, newKey } from "../api/client";
import type { FileChange } from "../api/generated";
import { useQuery } from "../state/store";

const OP: Record<string, string> = { created: "새 파일", modified: "수정", deleted: "삭제" };

type Attempt = { op: "undo" | "redo"; ids: string[]; key: string };

type Review = { files: { path: string; diff?: string; unavailable?: string; unchanged: boolean }[] };

/// 이 대화의 도구가 바꾼 파일(GIT-011~014). 대화 되감기(rewind)와는 별개로, 파일만 되돌리거나 다시 적용한다.
/// 되돌리기는 파일이 기록 뒤 바뀌지 않았을 때만 하고, 충돌이면 아무 파일도 바꾸지 않는다.
export function ChangesPanel({ sessionId, disabled }: { sessionId: string; disabled: boolean }) {
    const q = useQuery<FileChange[]>(`changes:${sessionId}`, () => api.get(`/sessions/${sessionId}/file-changes`));
    const [err, setErr] = useState<string | null>(null);
    const [diff, setDiff] = useState<{ id: string; text: string } | null>(null);
    const [review, setReview] = useState<Review | null>(null);
    const [attempt, setAttempt] = useState<Attempt | null>(null);
    const [busy, setBusy] = useState(false);
    const active = useRef(false);
    const locked = disabled || busy || attempt !== null;
    const list = q.data ?? [];
    if (list.length === 0) return null;
    // 턴(요청)별로 묶는다. 사용자가 직접 만든 도구 요청은 turn_id가 없다.
    const groups: { turn: string | null; items: FileChange[] }[] = [];
    for (const c of list) {
        const g = groups.find((x) => x.turn === c.turn_id);
        if (g) g.items.push(c);
        else groups.push({ turn: c.turn_id, items: [c] });
    }
    const act = async (a: Attempt) => {
        if (active.current || disabled) return;
        active.current = true;
        setBusy(true);
        setAttempt(a);
        setErr(null);
        try {
            await api.post(`/sessions/${sessionId}/file-changes/${a.op}`, { change_ids: a.ids }, { key: a.key });
            setAttempt(null);
            if (review) setReview(await api.get<Review>(`/sessions/${sessionId}/review`));
        } catch (e) {
            if (e instanceof ApiError && e.code === "conflict") {
                const files = ((e.details as { files?: { path: string }[] })?.files ?? []).map((f) => f.path).join(", ");
                setErr(`${e.message}${files ? ` (${files})` : ""}`);
            } else setErr(e instanceof ApiError ? e.message : "응답을 받지 못했습니다. 같은 요청의 결과를 다시 확인하세요.");
            if (e instanceof ApiError && e.status < 500 && e.code !== "result_unknown" && !e.retryable) setAttempt(null);
        } finally {
            active.current = false;
            setBusy(false);
            q.reload();
        }
    };
    const showDiff = async (id: string) => {
        if (diff?.id === id) return setDiff(null);
        const d = await api.get<{ diff: string | null; unavailable?: string }>(`/file-changes/${id}/diff`);
        setDiff({ id, text: d.diff ?? (d.unavailable === "binary" ? "(텍스트가 아닌 파일)" : "(내용을 보관하지 않음)") });
    };
    return (
        <details className="changes" data-testid="changes-panel">
            <summary>파일 변경 이력 · {list.filter((c) => !c.undone_at).length}/{list.length}</summary>
            <p className="muted small">대화 되감기와 별개입니다. 파일만 되돌리며, 기록 뒤 파일이 바뀌었으면 충돌로 알리고 아무것도 바꾸지 않습니다.</p>
            {err && (
                <p className="err" role="alert">
                    {err}
                </p>
            )}
            {attempt && !busy && <div className="inline">
                <button className="ghost small" disabled={disabled} onClick={() => void act(attempt)}>같은 요청 결과 확인</button>
                <button className="ghost small" onClick={() => { setAttempt(null); setErr(null); }}>원문 확인 후 닫기</button>
                <span className="muted small">원문과 변경 이력을 확인한 뒤 새 요청을 시작하세요.</span>
            </div>}
            {groups.map((g, gi) => {
                const applied = g.items.filter((c) => !c.undone_at && c.stored).map((c) => c.id);
                const undone = g.items.filter((c) => c.undone_at && c.stored).map((c) => c.id);
                return (
                    <div key={g.turn ?? `manual-${gi}`} className="change-group" data-testid="change-group">
                        <div className="inline">
                            <strong className="small">{g.turn ? `요청 ${gi + 1}` : "직접 요청"}</strong>
                            <button className="ghost small" disabled={locked || applied.length === 0} onClick={() => void act({ op: "undo", ids: applied, key: newKey() })}>
                                이 요청의 변경 되돌리기
                            </button>
                            <button className="ghost small" disabled={locked || undone.length === 0} onClick={() => void act({ op: "redo", ids: undone, key: newKey() })}>
                                다시 적용
                            </button>
                        </div>
                        <ul className="session-list">
                            {g.items.map((c) => (
                                <li key={c.id} data-testid="change-row" data-state={c.undone_at ? "undone" : "applied"}>
                                    <code className="small">{c.path}</code> <span className="muted small">{OP[c.op] ?? c.op} · {c.tool}</span>
                                    {c.undone_at && <em className="small"> 되돌림</em>}
                                    {!c.stored && <em className="small"> (파일이 커서 되돌릴 수 없음)</em>}
                                    <button className="ghost small" onClick={() => void showDiff(c.id)}>patch</button>
                                    {c.stored && (
                                        <button className="ghost small" disabled={locked} onClick={() => void act({ op: c.undone_at ? "redo" : "undo", ids: [c.id], key: newKey() })}>
                                            {c.undone_at ? "다시 적용" : "되돌리기"}
                                        </button>
                                    )}
                                    {diff?.id === c.id && <pre className="diff" data-testid="change-diff">{diff.text}</pre>}
                                </li>
                            ))}
                        </ul>
                    </div>
                );
            })}
            <button className="ghost small" onClick={() => void api.get<Review>(`/sessions/${sessionId}/review`).then(setReview)}>
                대화 전체 검토(처음 상태와 지금 비교)
            </button>
            {review && (
                <div data-testid="review">
                    {review.files.map((f) => (
                        <div key={f.path}>
                            <code className="small">{f.path}</code> {f.unchanged && <span className="muted small">처음과 같음</span>}
                            {f.diff ? <pre className="diff">{f.diff}</pre> : f.unavailable && <p className="muted small">비교할 수 없음({f.unavailable})</p>}
                        </div>
                    ))}
                </div>
            )}
        </details>
    );
}
