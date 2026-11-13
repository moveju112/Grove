import { useEffect, useState } from "react";
import { When } from "./When";
import { ApiError, api } from "../api/client";
import type { Notification } from "../api/generated";
import { useCapability } from "../state/capabilities";
import { useQuery } from "../state/store";
import type { Opener } from "./Workspace";
import { ServerActionButton } from "./pwa/ServerActionButton";
import { Icon } from "./icons";

/// 서버에 영속 보관된 알림. 기기가 꺼져 있던 동안의 알림도 접속하면 보인다.
export function NotificationsPanel({ open }: { open: Opener }) {
    const q = useQuery<{ items: Notification[]; unread: number }>("notifications", () => api.get("/notifications?limit=30"));
    const items = q.data?.items ?? [];
    const unread = q.data?.unread ?? 0;
    const delivery = useCapability("notification_delivery_v1");
    const pending = items.filter((n) => !n.delivered_at).map((n) => n.id).sort();
    const pendingKey = pending.join(",");
    const [deliveryError, setDeliveryError] = useState<string | null>(null);
    const [readError, setReadError] = useState<string | null>(null);
    const confirmDelivery = async () => {
        if (delivery !== true || pending.length === 0) return;
        setDeliveryError(null);
        try {
            await api.post("/notifications/delivered", { ids: pending }, { requires: ["notification_delivery_v1"] });
        } catch (e) {
            setDeliveryError(e instanceof ApiError ? e.message : "앱 전달을 확인하지 못했습니다.");
        } finally {
            q.reload();
        }
    };
    // 이 effect는 앱이 목록을 받은 뒤 실행한다. 목록 펼침·읽음·서버 실행 성공과는 별개다.
    useEffect(() => {
        if (!pendingKey) { setDeliveryError(null); return; }
        void confirmDelivery();
        // 같은 대상 목록은 자동 반복하지 않고 실패 시 명시적인 재확인을 제공한다.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [pendingKey, delivery]);
    const read = async (path: string) => {
        setReadError(null);
        try { await api.post(path); }
        catch (e) { setReadError(e instanceof ApiError ? e.message : "읽음 표시를 저장하지 못했습니다."); }
        finally { q.reload(); }
    };
    return (
        <details className="notifications" data-testid="notifications">
            <summary>
                <Icon name="bell" size={16} />
                알림{" "}
                {unread > 0 && (
                    <span className="badge" data-testid="notifications-unread" aria-label={`읽지 않은 알림 ${unread}개`}>
                        {unread}
                    </span>
                )}
            </summary>
            {deliveryError && <p className="err" role="alert">앱 전달 미확인: {deliveryError} <ServerActionButton className="ghost small" onClick={() => void confirmDelivery()}>전달 다시 확인</ServerActionButton></p>}
            {readError && <p className="err" role="alert">{readError}</p>}
            {items.length === 0 ? (
                <p className="muted small">알림이 없습니다.</p>
            ) : (
                <>
                    {unread > 0 && <ServerActionButton className="ghost small" onClick={() => void read("/notifications/read-all")}>모두 읽음</ServerActionButton>}
                    <ul className="session-list">
                        {items.map((n) => (
                            <li key={n.id} data-testid="notification" className={n.read_at ? "muted" : ""}>
                                <button
                                    className="ghost"
                                    onClick={() => {
                                        if (!n.read_at) void read(`/notifications/${n.id}/read`);
                                        if (n.session_id && n.project_id) open({ kind: "session", project_id: n.project_id, resource_id: n.session_id, title: n.title });
                                    }}
                                >
                                    <strong>{n.title}</strong>
                                    {n.body && <span className="small"> {n.body.slice(0, 120)}</span>}
                                    <span className="muted small"> · <When at={n.created_at} /></span>
                                    <span className="muted small notification-phase" data-testid="notification-delivery">
                                        서버 저장됨 · {delivery === false ? "전달 확인 미지원" : n.delivered_at ? "앱 전달 확인" : "앱 전달 미확인"} · {n.read_at ? "읽음" : "미열람"}
                                    </span>
                                </button>
                            </li>
                        ))}
                    </ul>
                </>
            )}
        </details>
    );
}
