import { useState } from "react";
import { Panel } from "./ui/Controls";
import { ApiError, api } from "../api/client";
import type { Notification, RemoteWatch } from "../api/generated";
import { useQuery } from "../state/store";
import { When } from "./When";
import { ServerActionButton } from "./pwa/ServerActionButton";

const STATUS: Record<string, string> = {
    watching: "감시 중",
    succeeded: "원격 성공",
    failed: "원격 실패",
    timed_out: "감시 시간 초과(결과 불명)",
    cancelled: "감시 취소됨",
    stopped: "감시 중단(설정 확인 필요)",
};

/// 원격 job 상태와 알림 단계를 따로 적는다(EXEC-017). 알림 저장은 앱 전달·열람과 다르다.
export function noticePhase(n: Pick<Notification, "delivered_at" | "read_at"> | undefined): string {
    if (!n) return "알림 없음";
    return `알림 저장됨 · ${n.delivered_at ? "앱 전달 확인" : "앱 전달 미확인"} · ${n.read_at ? "읽음" : "미열람"}`;
}

/// 원격 job 완료 감시(EXEC-014~017). 정확한 HTTPS URL을 GET으로만 조회한다.
export function RemoteWatchesPanel({ sessionId, disabled }: { sessionId: string; disabled: boolean }) {
    const q = useQuery<RemoteWatch[]>(`remote-watches:${sessionId}`, () => api.get(`/sessions/${sessionId}/remote-watches`));
    const notes = useQuery<{ items: Notification[] }>("notifications", () => api.get("/notifications?limit=30"));
    const [err, setErr] = useState<string | null>(null);
    const [form, setForm] = useState({ title: "", url: "", pointer: "/status", success: "success", failure: "failure", interval: "60", timeout: "60" });
    const watches = q.data ?? [];
    const active = watches.filter((w) => w.status === "watching").length;
    const act = async (f: () => Promise<unknown>) => {
        setErr(null);
        try {
            await f();
        } catch (e) {
            setErr(e instanceof ApiError ? e.message : "원격 감시 요청 실패");
        }
        q.reload();
    };
    const split = (s: string) => s.split(",").map((x) => x.trim()).filter(Boolean);
    return (
        <Panel className="remote-watches" data-testid="remote-watches" title={`원격 작업 감시${watches.length > 0 ? ` · 감시 중 ${active}/${watches.length}` : ""}`}>
            {err && <p className="err" role="alert">{err}</p>}
            <ul className="session-list">
                {watches.map((w) => {
                    const n = notes.data?.items.find((x) => x.id === w.notification_id);
                    return (
                        <li key={w.id} data-testid="remote-watch" data-status={w.status}>
                            <strong>{w.title}</strong> <span className={`status ${w.status}`}>{STATUS[w.status] ?? w.status}</span>
                            <span className="muted small"> · 원격 상태 {w.remote_value ?? "아직 없음"} · 확인 {w.checks}회</span>
                            {w.last_checked_at && <span className="muted small"> · 마지막 확인 <When at={w.last_checked_at} /></span>}
                            {w.last_error && <span className="small err"> · {w.last_error.message}</span>}
                            {w.task_id && <span className="muted small"> · 연결된 로컬 명령의 결과는 작업 목록에서 따로 봅니다</span>}
                            {w.finished_at && <span className="muted small" data-testid="remote-watch-notice"> · {noticePhase(n)}</span>}
                            <div className="muted small">{w.url}</div>
                            {w.status === "watching" && !disabled && (
                                <span className="inline">
                                    <ServerActionButton className="ghost small" onClick={() => void act(() => api.post(`/remote-watches/${w.id}/check`, { expected_revision: w.revision }))}>
                                        지금 확인
                                    </ServerActionButton>
                                    <ServerActionButton
                                        className="ghost small"
                                        title="이 서버의 조회만 멈춥니다. 원격 작업은 취소하지 않습니다"
                                        onClick={() => void act(() => api.post(`/remote-watches/${w.id}/cancel`, { expected_revision: w.revision }))}
                                    >
                                        감시 취소(원격 작업은 계속)
                                    </ServerActionButton>
                                </span>
                            )}
                        </li>
                    );
                })}
            </ul>
            {!disabled && (
                <form
                    className="grid-form"
                    onSubmit={(e) => {
                        e.preventDefault();
                        void act(async () => {
                            await api.post(`/sessions/${sessionId}/remote-watches`, {
                                title: form.title,
                                url: form.url,
                                status_pointer: form.pointer,
                                success_values: split(form.success),
                                failure_values: split(form.failure),
                                interval_secs: Number(form.interval),
                                timeout_mins: Number(form.timeout),
                            });
                            setForm((f) => ({ ...f, title: "", url: "" }));
                        });
                    }}
                >
                    <input aria-label="감시 이름" placeholder="이름" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
                    <input aria-label="상태 URL" placeholder="https://…" value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} />
                    <input aria-label="상태 위치(JSON pointer)" value={form.pointer} onChange={(e) => setForm({ ...form, pointer: e.target.value })} />
                    <input aria-label="성공 값(쉼표 구분)" value={form.success} onChange={(e) => setForm({ ...form, success: e.target.value })} />
                    <input aria-label="실패 값(쉼표 구분)" value={form.failure} onChange={(e) => setForm({ ...form, failure: e.target.value })} />
                    <input aria-label="확인 간격(초)" type="number" min={10} max={3600} value={form.interval} onChange={(e) => setForm({ ...form, interval: e.target.value })} />
                    <input aria-label="감시 시간(분)" type="number" min={1} value={form.timeout} onChange={(e) => setForm({ ...form, timeout: e.target.value })} />
                    <ServerActionButton type="submit" disabled={!form.title.trim() || !form.url.trim()}>감시 시작</ServerActionButton>
                </form>
            )}
        </Panel>
    );
}
