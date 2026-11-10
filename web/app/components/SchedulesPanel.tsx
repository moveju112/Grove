import { useState } from "react";
import { ApiError, api } from "../api/client";
import type { ModelProfile } from "../api/generated";
import { useQuery } from "../state/store";
import type { Opener } from "./Workspace";

type Schedule = {
    id: string;
    project_id: string;
    name: string;
    prompt: string;
    profile_id: string;
    kind: "once" | "interval" | "daily";
    at: string | null;
    interval_minutes: number | null;
    daily_time: string | null;
    tz_offset_minutes: number;
    on_approval: "wait" | "fail";
    tools_enabled: boolean;
    status: "active" | "paused" | "done";
    next_run_at: string | null;
    revision: number;
};
type Run = { id: string; planned_at: string; manual: boolean; status: string; session_id: string | null; detail: string | null };

const RUN_LABEL: Record<string, string> = {
    running: "실행 중",
    completed: "완료",
    failed: "실패",
    cancelled: "취소",
    interrupted: "중단(재시작)",
    skipped_overlap: "건너뜀(이전 실행 중)",
    missed: "놓침",
    start_failed: "시작 실패",
};

function when(s: Schedule) {
    if (s.kind === "once") return `한 번 · ${new Date(s.at ?? "").toLocaleString()}`;
    if (s.kind === "interval") return `${s.interval_minutes}분마다`;
    const h = s.tz_offset_minutes / 60;
    return `매일 ${s.daily_time} (UTC${h >= 0 ? "+" : ""}${h})`;
}

function Runs({ id, projectId, open }: { id: string; projectId: string; open: Opener }) {
    const q = useQuery<Run[]>(`schedules:runs:${id}`, () => api.get(`/schedules/${id}/runs`));
    const runs = q.data ?? [];
    if (runs.length === 0) return <p className="muted small">아직 실행 기록이 없습니다.</p>;
    return (
        <ul className="session-list" data-testid="schedule-runs">
            {runs.slice(0, 10).map((r) => (
                <li key={r.id} data-status={r.status}>
                    <span className="muted small">{new Date(r.planned_at).toLocaleString()}{r.manual ? " · 수동" : ""}</span> <span className={`status ${r.status}`}>{RUN_LABEL[r.status] ?? r.status}</span>
                    {r.detail && <span className="muted small"> {r.detail}</span>}
                    {r.session_id && (
                        <button className="ghost small" onClick={() => open({ kind: "session", project_id: projectId, resource_id: r.session_id!, title: "예약 실행" })}>
                            대화 열기
                        </button>
                    )}
                </li>
            ))}
        </ul>
    );
}

/// 프로젝트 예약 실행. 승인이 필요한 도구는 자동 승인하지 않고 정책(대기/실패)을 따른다.
export function SchedulesPanel({ projectId, open }: { projectId: string; open: Opener }) {
    const q = useQuery<Schedule[]>(`schedules:${projectId}`, () => api.get(`/schedules?project_id=${projectId}`));
    const profiles = useQuery<ModelProfile[]>("profiles", () => api.get("/model-profiles"));
    const [err, setErr] = useState<string | null>(null);
    const [form, setForm] = useState({ name: "", prompt: "", kind: "daily", daily_time: "09:00", interval_minutes: 60, at: "", profile_id: "", on_approval: "wait", tools: false });
    const list = q.data ?? [];
    const act = async (f: () => Promise<unknown>) => {
        setErr(null);
        try {
            await f();
        } catch (e) {
            setErr(e instanceof ApiError ? (e.code === "revision_conflict" ? "다른 곳에서 먼저 바뀌었습니다. 최신 상태를 불러왔습니다" : e.message) : "예약 변경 실패");
        }
        q.reload();
    };
    const profileId = form.profile_id || profiles.data?.[0]?.id || "";
    const submit = () =>
        act(async () => {
            const body: Record<string, unknown> = {
                name: form.name,
                prompt: form.prompt,
                profile_id: profileId,
                kind: form.kind,
                on_approval: form.on_approval,
                tools: form.tools,
                tz_offset_minutes: -new Date().getTimezoneOffset(),
            };
            if (form.kind === "daily") body.daily_time = form.daily_time;
            if (form.kind === "interval") body.interval_minutes = Number(form.interval_minutes);
            if (form.kind === "once") body.at = form.at ? new Date(form.at).toISOString() : "";
            await api.post(`/projects/${projectId}/schedules`, body);
            setForm((f) => ({ ...f, name: "", prompt: "" }));
        });
    return (
        <details className="schedules" data-testid="schedules-panel">
            <summary>예약 실행 {list.length > 0 ? `· ${list.filter((s) => s.status === "active").length}개 활성` : ""}</summary>
            {err && <p className="err" role="alert">{err}</p>}
            <ul className="session-list">
                {list.map((s) => (
                    <li key={s.id} data-testid="schedule" data-status={s.status}>
                        <details>
                            <summary>
                                <strong>{s.name}</strong> <span className="muted small">{when(s)}</span>{" "}
                                <span className={`status ${s.status}`}>{s.status === "active" ? "활성" : s.status === "paused" ? "일시 정지" : "끝남"}</span>
                                {s.next_run_at && s.status === "active" && <span className="muted small"> · 다음 {new Date(s.next_run_at).toLocaleString()}</span>}
                            </summary>
                            <p className="small">{s.prompt}</p>
                            <p className="muted small">승인 필요 시: {s.on_approval === "wait" ? "승인을 기다림" : "실패로 끝냄"} · 도구 {s.tools_enabled ? "사용" : "끔"}</p>
                            <div className="inline wrap">
                                <button className="small" onClick={() => void act(() => api.post(`/schedules/${s.id}/run`))}>지금 실행</button>
                                {s.status === "active" && <button className="ghost small" onClick={() => void act(() => api.post(`/schedules/${s.id}/pause`, { expected_revision: s.revision }))}>일시 정지</button>}
                                {s.status === "paused" && <button className="ghost small" onClick={() => void act(() => api.post(`/schedules/${s.id}/resume`, { expected_revision: s.revision }))}>재개</button>}
                                <button
                                    className="ghost small danger"
                                    onClick={() => {
                                        if (confirm(`예약 '${s.name}'을 삭제할까요? 실행 기록과 대화는 남습니다.`)) void act(() => api.post(`/schedules/${s.id}/delete`, { expected_revision: s.revision }));
                                    }}
                                >
                                    삭제
                                </button>
                            </div>
                            <Runs id={s.id} projectId={projectId} open={open} />
                        </details>
                    </li>
                ))}
            </ul>
            <form
                className="stack"
                onSubmit={(e) => {
                    e.preventDefault();
                    void submit();
                }}
            >
                <input aria-label="예약 이름" placeholder="이름" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
                <textarea aria-label="예약 지시" placeholder="실행할 지시" rows={2} value={form.prompt} onChange={(e) => setForm({ ...form, prompt: e.target.value })} />
                <div className="inline wrap">
                    <select aria-label="예약 방식" value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })}>
                        <option value="daily">매일</option>
                        <option value="interval">간격</option>
                        <option value="once">한 번</option>
                    </select>
                    {form.kind === "daily" && <input aria-label="실행 시각" type="time" value={form.daily_time} onChange={(e) => setForm({ ...form, daily_time: e.target.value })} />}
                    {form.kind === "interval" && (
                        <input aria-label="간격(분)" type="number" min={1} value={form.interval_minutes} onChange={(e) => setForm({ ...form, interval_minutes: Number(e.target.value) })} />
                    )}
                    {form.kind === "once" && <input aria-label="실행 일시" type="datetime-local" value={form.at} onChange={(e) => setForm({ ...form, at: e.target.value })} />}
                    <select aria-label="예약 모델" value={profileId} onChange={(e) => setForm({ ...form, profile_id: e.target.value })}>
                        {(profiles.data ?? []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                    </select>
                    <label className="check">
                        <input type="checkbox" checked={form.tools} onChange={(e) => setForm({ ...form, tools: e.target.checked })} /> 도구 사용
                    </label>
                    <select aria-label="승인 필요 시" value={form.on_approval} onChange={(e) => setForm({ ...form, on_approval: e.target.value })}>
                        <option value="wait">승인 필요 시 기다림</option>
                        <option value="fail">승인 필요 시 실패</option>
                    </select>
                </div>
                <p className="muted small">매일 실행은 이 기기의 현재 UTC offset으로 저장됩니다. 서머타임이 바뀌면 다시 저장하세요. 서버가 꺼져 있어 놓친 실행은 나중에 몰아서 실행하지 않습니다.</p>
                <button type="submit" disabled={!form.name.trim() || !form.prompt.trim() || !profileId}>예약 추가</button>
            </form>
        </details>
    );
}
