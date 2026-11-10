import { api } from "../api/client";
import { useQuery } from "../state/store";
import type { Opener } from "./Workspace";

type Notification = { id: string; title: string; body: string; project_id: string | null; session_id: string | null; created_at: string; read_at: string | null };

/// 서버에 영속 보관된 알림. 기기가 꺼져 있던 동안의 알림도 접속하면 보인다.
export function NotificationsPanel({ open }: { open: Opener }) {
    const q = useQuery<{ items: Notification[]; unread: number }>("notifications", () => api.get("/notifications?limit=30"));
    const items = q.data?.items ?? [];
    const unread = q.data?.unread ?? 0;
    const read = (id: string) => void api.post(`/notifications/${id}/read`).finally(() => q.reload());
    return (
        <details className="notifications" data-testid="notifications">
            <summary>
                알림{" "}
                {unread > 0 && (
                    <span className="badge" data-testid="notifications-unread" aria-label={`읽지 않은 알림 ${unread}개`}>
                        {unread}
                    </span>
                )}
            </summary>
            {items.length === 0 ? (
                <p className="muted small">알림이 없습니다.</p>
            ) : (
                <>
                    {unread > 0 && <button className="ghost small" onClick={() => void api.post("/notifications/read-all").finally(() => q.reload())}>모두 읽음</button>}
                    <ul className="session-list">
                        {items.map((n) => (
                            <li key={n.id} data-testid="notification" className={n.read_at ? "muted" : ""}>
                                <button
                                    className="ghost"
                                    onClick={() => {
                                        if (!n.read_at) read(n.id);
                                        if (n.session_id && n.project_id) open({ kind: "session", project_id: n.project_id, resource_id: n.session_id, title: n.title });
                                    }}
                                >
                                    <strong>{n.title}</strong>
                                    {n.body && <span className="small"> {n.body.slice(0, 120)}</span>}
                                    <span className="muted small"> · {new Date(n.created_at).toLocaleString()}</span>
                                </button>
                            </li>
                        ))}
                    </ul>
                </>
            )}
        </details>
    );
}
