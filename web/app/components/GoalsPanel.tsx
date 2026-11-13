import { useState } from "react";
import { ApiError, api } from "../api/client";
import { useAutoOpen } from "../state/autoOpen";
import { useQuery } from "../state/store";
import { ServerActionButton } from "./pwa/ServerActionButton";
import { useServerBlockReason } from "./pwa/lifecycle";

type Goal = { id: string; title: string; status: "pending" | "in_progress" | "done" | "cancelled"; revision: number };

/// 대화별 Goal 목록. 미완료 항목은 다음 요청에서 모델에 알려 줄 뿐, 자동으로 실행하지 않는다.
export function GoalsPanel({ sessionId, disabled }: { sessionId: string; disabled: boolean }) {
    const serverBlocked = useServerBlockReason();
    const q = useQuery<{ goals: Goal[] }>(`goals:${sessionId}`, () => api.get(`/sessions/${sessionId}/goals`));
    const [title, setTitle] = useState("");
    const [err, setErr] = useState<string | null>(null);
    // 저장 중에는 누른 값을 먼저 보여 준다. 실패하면 서버 값으로 돌아간다.
    const [optimistic, setOptimistic] = useState<Record<string, boolean>>({});
    const goals = q.data?.goals ?? [];
    const open = goals.filter((g) => g.status === "pending" || g.status === "in_progress").length;
    // 남은 Goal이 생기면 열고, 모두 끝나도 사용자가 연 목록을 닫지 않는다.
    const details = useAutoOpen(open > 0);
    const act = async (f: () => Promise<unknown>) => {
        setErr(null);
        try {
            await f();
        } catch (e) {
            setErr(e instanceof ApiError ? (e.code === "revision_conflict" ? "다른 곳에서 먼저 바뀌었습니다. 최신 목록을 불러왔습니다" : e.message) : "Goal 변경 실패");
        }
        q.reload();
    };
    const move = (i: number) => {
        const ids = goals.map((g) => g.id);
        [ids[i - 1], ids[i]] = [ids[i]!, ids[i - 1]!];
        void act(() => api.post(`/sessions/${sessionId}/goals/reorder`, { ids }));
    };
    return (
        <details className="goals" data-testid="goals-panel" {...details}>
            <summary>Goal {goals.length > 0 ? `· 남은 ${open}/${goals.length}` : ""}</summary>
            {err && <p className="err" role="alert">{err}</p>}
            <ul className="session-list">
                {goals.map((g, i) => (
                    <li key={g.id} data-testid="goal" data-status={g.status}>
                        <label className="check">
                            <input
                                type="checkbox"
                                checked={optimistic[g.id] ?? g.status === "done"}
                                disabled={disabled || g.status === "cancelled" || !!serverBlocked}
                                title={serverBlocked ?? undefined}
                                onChange={(e) => {
                                    const done = e.target.checked;
                                    setOptimistic((o) => ({ ...o, [g.id]: done }));
                                    void act(() =>
                                        api.patch(`/sessions/${sessionId}/goals/${g.id}`, { expected_revision: g.revision, status: done ? "done" : "pending" }),
                                    ).finally(() =>
                                        setOptimistic((o) => {
                                            const { [g.id]: _, ...rest } = o;
                                            return rest;
                                        }),
                                    );
                                }}
                            />
                            <span className={g.status === "done" || g.status === "cancelled" ? "muted strike" : ""}>{g.title}</span>
                        </label>
                        {g.status === "in_progress" && <span className="status running">진행 중</span>}
                        {i > 0 && !disabled && <ServerActionButton className="ghost small" aria-label={`${g.title} 위로`} onClick={() => move(i)}>↑</ServerActionButton>}
                    </li>
                ))}
            </ul>
            {!disabled && (
                <form
                    className="inline"
                    onSubmit={(e) => {
                        e.preventDefault();
                        void act(async () => {
                            await api.post(`/sessions/${sessionId}/goals`, { title });
                            setTitle("");
                        });
                    }}
                >
                    <input aria-label="새 Goal" placeholder="할 일 추가" value={title} onChange={(e) => setTitle(e.target.value)} />
                    <ServerActionButton type="submit" disabled={!title.trim()}>추가</ServerActionButton>
                </form>
            )}
        </details>
    );
}
