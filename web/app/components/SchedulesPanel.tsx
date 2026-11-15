import { Stack as GroveStack } from "@astryxdesign/core/Stack";
import { Text as GroveText } from "@astryxdesign/core/Text";
import { Button as GroveButton } from "../design/Button";
import { type ReactNode, useState } from "react";
import { Panel } from "./ui/Controls";
import { BooleanSelect } from "./BooleanSelect";
import { When } from "./When";
import { ApiError, api } from "../api/client";
import type { ModelProfile } from "../api/generated";
import { useQuery } from "../state/store";
import type { Opener } from "./Workspace";
import { ServerActionButton } from "./pwa/ServerActionButton";
import { HelpTip, SentenceText } from "./HelpTip";
import { TextInput, TextArea } from "../design/Fields";

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
    max_runs: number | null;
    end_at: string | null;
    pause_after_failures: number | null;
    consecutive_failures: number;
    paused_reason: "user" | "failures" | null;
    runs_used: number;
    backoff_until: string | null;
    bot_id: string | null;
    webhook_enabled: boolean;
    quiet_policy: "off" | "unchanged_result";
};
type BotRef = { id: string; name: string; project_id: string; profile_id: string | null; status: string; runnable: boolean };

/// 반복 한도·연속 실패 상태(AUTO-009). 자동 실행만 세고 수동 실행은 횟수에 넣지 않는다.
function limits(s: Schedule) {
    const parts: ReactNode[] = [];
    if (s.kind !== "once") parts.push(`자동 실행 ${s.runs_used}${s.max_runs ? `/${s.max_runs}` : ""}회`);
    if (s.end_at) parts.push(<>종료 <When at={s.end_at} absolute /></>);
    parts.push(s.pause_after_failures ? `연속 ${s.pause_after_failures}회 실패 시 자동 정지` : "실패해도 자동 정지 안 함");
    if (s.consecutive_failures > 0) {
        const waiting = s.backoff_until && new Date(s.backoff_until).getTime() > Date.now();
        parts.push(<GroveText type="inherit" color="warning">연속 실패 {s.consecutive_failures}회{waiting && <> · 자동 실행 재개 <When at={s.backoff_until!} absolute /></>}</GroveText>);
    }
    return parts.map((p, i) => <GroveText type="inherit" color="inherit" key={i}>{i > 0 && " · "}{p}</GroveText>);
}
type Run = {
    id: string;
    planned_at: string;
    manual: boolean;
    status: string;
    session_id: string | null;
    detail: string | null;
    result_class: string | null;
    notified: boolean | null;
    usage: { input_tokens?: number; output_tokens?: number } | null;
};

// 결과 분류(QUIET-001): 실행 상태와 별개다.
const CLASS_LABEL: Record<string, string> = {
    changed: "변화 있음",
    no_change: "변화 없음",
    needs_approval: "승인 필요",
    unknown: "결과 불명 작업",
};

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
    if (s.kind === "once") return <>한 번 · <When at={s.at ?? ""} absolute /></>;
    if (s.kind === "interval") return `${s.interval_minutes}분마다`;
    const h = s.tz_offset_minutes / 60;
    return `매일 ${s.daily_time} (UTC${h >= 0 ? "+" : ""}${h})`;
}

function Runs({ id, projectId, open }: { id: string; projectId: string; open: Opener }) {
    const q = useQuery<Run[]>(`schedules:runs:${id}`, () => api.get(`/schedules/${id}/runs`));
    const runs = q.data ?? [];
    if (runs.length === 0) return <GroveText as="p" display="block" type="supporting" color="secondary">아직 실행 기록이 없습니다.</GroveText>;
    return (
        <ul className="session-list" data-testid="schedule-runs">
            {runs.slice(0, 10).map((r) => (
                <li key={r.id} data-status={r.status}>
                    <GroveText type="supporting" color="secondary"><When at={r.planned_at} />{r.manual ? " · 수동" : ""}</GroveText> <GroveText type="inherit" color="inherit" className={`status ${r.status}`}>{RUN_LABEL[r.status] ?? r.status}</GroveText>
                    {r.result_class && CLASS_LABEL[r.result_class] && <GroveText type="supporting" color="inherit" className="badge" data-testid="run-class"> {CLASS_LABEL[r.result_class]}</GroveText>}
                    {r.notified === false && <GroveText type="supporting" color="secondary"> · 알림 생략(실행·비용은 발생)</GroveText>}
                    {r.usage && (r.usage.input_tokens || r.usage.output_tokens) ? <GroveText type="supporting" color="secondary"> · {(r.usage.input_tokens ?? 0) + (r.usage.output_tokens ?? 0)} token</GroveText> : null}
                    {r.detail && <GroveText type="supporting" color="secondary"> {r.detail}</GroveText>}
                    {r.session_id && (
                        <GroveButton className="ghost small" onClick={() => open({ kind: "session", project_id: projectId, resource_id: r.session_id!, title: "예약 실행" })}>
                            대화 열기
                        </GroveButton>
                    )}
                </li>
            ))}
        </ul>
    );
}

/// webhook(RTE-004): 켜면 새 비밀을 한 번만 보여 준다. 다시 만들면 이전 비밀은 무효.
function Webhook({ s, act }: { s: Schedule; act: (f: () => Promise<unknown>) => Promise<void> }) {
    const [shown, setShown] = useState<{ secret: string; path: string } | null>(null);
    const enable = () =>
        act(async () => {
            if (s.webhook_enabled && !confirm("비밀을 다시 만들면 이전 비밀로 보낸 요청은 거부됩니다. 계속할까요?")) return;
            setShown(await api.post<{ secret: string; path: string }>(`/schedules/${s.id}/webhook`, { enable: true }));
        });
    return (
        <div className="stack small" data-testid="schedule-webhook">
            <GroveStack direction="horizontal" align="center" wrap="wrap" className="inline wrap">
                <GroveText type="inherit" color="inherit">webhook {s.webhook_enabled ? "켜짐" : "꺼짐"}</GroveText>
                <ServerActionButton className="ghost small" onClick={() => void enable()}>{s.webhook_enabled ? "비밀 다시 만들기" : "webhook 켜기"}</ServerActionButton>
                {s.webhook_enabled && (
                    <ServerActionButton className="ghost small" onClick={() => void act(async () => { await api.post(`/schedules/${s.id}/webhook`, { enable: false }); setShown(null); })}>
                        webhook 끄기
                    </ServerActionButton>
                )}
            </GroveStack>
            {shown && (
                <div className="notice" role="status">
                    <GroveText as="p" display="block" type="inherit" color="inherit">이 비밀은 지금만 표시되니 발신 측에 저장하세요.</GroveText>
                    <code data-testid="webhook-secret">{shown.secret}</code>
                    <GroveText as="p" display="block" type="inherit" color="secondary">POST {location.origin}{shown.path} <HelpTip label="webhook 요청 형식 도움말">
                        <GroveText as="p" display="block" type="inherit" color="inherit">헤더: <code>X-Grove-Timestamp</code>(unix 초), <code>X-Grove-Event-Id</code>, <code>X-Grove-Signature: sha256=HMAC-SHA256(비밀, "timestamp.event_id.본문")</code>의 hex.</GroveText>
                        <GroveText as="p" display="block" type="inherit" color="inherit">본문은 64KiB 이하이며 같은 event ID는 한 번만 실행하고 payload의 지시는 따르지 않습니다.</GroveText>
                    </HelpTip></GroveText>
                </div>
            )}
        </div>
    );
}

/// 프로젝트 예약 실행. 승인이 필요한 도구는 자동 승인하지 않고 정책(대기/실패)을 따른다.
export function SchedulesPanel({ projectId, open }: { projectId: string; open: Opener }) {
    const q = useQuery<Schedule[]>(`schedules:${projectId}`, () => api.get(`/schedules?project_id=${projectId}`));
    const profiles = useQuery<ModelProfile[]>("profiles", () => api.get("/model-profiles"));
    const [err, setErr] = useState<string | null>(null);
    const bots = useQuery<{ bots: BotRef[] }>("bots", () => api.get("/bots"));
    const [form, setForm] = useState({ name: "", prompt: "", kind: "daily", daily_time: "09:00", interval_minutes: 60, at: "", profile_id: "", on_approval: "wait", tools: false, max_runs: "", end_at: "", pause_after_failures: "5", bot_id: "", confirmed: false, start_paused: false, quiet: false });
    const list = q.data ?? [];
    // 담당 봇 후보: 이 프로젝트의 실행 가능한 활성 봇(RTE-001)
    const projectBots = (bots.data?.bots ?? []).filter((b) => b.project_id === projectId && b.status === "active" && b.runnable);
    const bot = projectBots.find((b) => b.id === form.bot_id);
    const botName = (id: string | null) => (bots.data?.bots ?? []).find((b) => b.id === id)?.name ?? "삭제된 봇";
    const act = async (f: () => Promise<unknown>) => {
        setErr(null);
        try {
            await f();
        } catch (e) {
            setErr(e instanceof ApiError ? (e.code === "revision_conflict" ? "다른 곳에서 먼저 바뀌었습니다. 최신 상태를 불러왔습니다" : e.message) : "예약 변경 실패");
        }
        q.reload();
    };
    const profileId = bot ? bot.profile_id ?? "" : form.profile_id || profiles.data?.find((profile) => profile.enabled !== false)?.id || "";
    const profileName = profiles.data?.find((p) => p.id === profileId)?.name ?? profileId;
    const submit = () =>
        act(async () => {
            if (profiles.data?.find((profile) => profile.id === profileId)?.enabled === false) throw new Error("비활성 모델 프로필은 선택할 수 없습니다");
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
            if (form.kind !== "once" && form.max_runs) body.max_runs = Number(form.max_runs);
            if (form.kind !== "once" && form.end_at) body.end_at = new Date(form.end_at).toISOString();
            body.pause_after_failures = form.pause_after_failures ? Number(form.pause_after_failures) : null;
            if (bot) {
                body.bot_id = bot.id;
                body.session_mode = "same";
            }
            if (form.start_paused) body.start_paused = true;
            if (form.quiet) body.quiet_policy = "unchanged_result";
            await api.post(`/projects/${projectId}/schedules`, body);
            setForm((f) => ({ ...f, name: "", prompt: "", confirmed: false }));
        });
    return (
        <Panel className="schedules" data-testid="schedules-panel" title={<GroveText type="inherit" color="inherit" className="inline">
            예약 실행{list.length > 0 ? ` · ${list.filter((s) => s.status === "active").length}개 활성` : ""}
            <HelpTip label="예약 실행 도움말">
                <SentenceText text="매일 실행은 이 기기의 현재 UTC offset으로 저장하므로 서머타임 변경 시 다시 저장하세요. 서버가 꺼져 놓친 실행은 소급하지 않습니다. 연속 실패 시 간격을 1분부터 두 배씩 최대 하루까지 늘리고, 정한 횟수에 이르면 멈춥니다. 사용자 취소·서버 재시작 중단은 실패로 세지 않습니다." />
            </HelpTip>
        </GroveText>}>
            {err && <GroveText as="p" display="block" type="inherit" color="error" role="alert">{err}</GroveText>}
            <ul className="session-list">
                {list.map((s) => (
                    <li key={s.id} data-testid="schedule" data-status={s.status}>
                        <Panel title={<>
                                <strong>{s.name}</strong> <GroveText type="supporting" color="secondary">{when(s)}</GroveText>{" "}
                                <GroveText type="inherit" color="inherit" className={`status ${s.status}`}>
                                    {s.status === "active" ? "활성" : s.status === "paused" ? (s.paused_reason === "failures" ? "일시 정지(연속 실패)" : "일시 정지") : "끝남"}
                                </GroveText>
                                {s.next_run_at && s.status === "active" && <GroveText type="supporting" color="secondary"> · 다음 <When at={s.next_run_at} absolute /></GroveText>}
                            </>}>
                            <GroveText as="p" display="block" type="supporting" color="inherit">{s.prompt}</GroveText>
                            {s.bot_id && <GroveText as="p" display="block" type="supporting" color="inherit" data-testid="schedule-bot">담당 봇: {botName(s.bot_id)} · 결과는 봇 대화에 전달</GroveText>}
                            <GroveText as="p" display="block" type="supporting" color="secondary">승인 필요 시: {s.on_approval === "wait" ? "승인을 기다림" : "실패로 끝냄"} · 도구 {s.tools_enabled ? "사용" : "끔"}</GroveText>
                            <GroveText as="p" display="block" type="supporting" color="secondary" data-testid="schedule-limits">{limits(s)}</GroveText>
                            {s.quiet_policy === "unchanged_result" && <GroveText as="p" display="block" type="supporting" color="secondary">직전 완료 결과와 같으면 자동 실행 알림을 생략합니다(실행 기록·비용은 남고, 실패·승인 필요·직접 실행은 항상 알림).</GroveText>}
                            <GroveStack direction="horizontal" align="center" wrap="wrap" className="inline wrap">
                                <ServerActionButton className="small" onClick={() => void act(() => api.post(`/schedules/${s.id}/run`))}>지금 실행</ServerActionButton>
                                {s.status === "active" && <ServerActionButton className="ghost small" onClick={() => void act(() => api.post(`/schedules/${s.id}/pause`, { expected_revision: s.revision }))}>일시 정지</ServerActionButton>}
                                {s.status === "paused" && <ServerActionButton className="ghost small" onClick={() => void act(() => api.post(`/schedules/${s.id}/resume`, { expected_revision: s.revision }))}>재개</ServerActionButton>}
                                <ServerActionButton
                                    className="ghost small danger"
                                    onClick={() => {
                                        if (confirm(`예약 '${s.name}'을 삭제할까요? 실행 기록과 대화는 남습니다.`)) void act(() => api.post(`/schedules/${s.id}/delete`, { expected_revision: s.revision }));
                                    }}
                                >
                                    삭제
                                </ServerActionButton>
                            </GroveStack>
                            <Webhook s={s} act={act} />
                            <Runs id={s.id} projectId={projectId} open={open} />
                        </Panel>
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
                <TextInput label="예약 이름" isLabelHidden placeholder="이름" value={form.name} onChange={(value) => setForm({ ...form, name: value })} />
                <TextArea label="예약 지시" isLabelHidden placeholder="실행할 지시" rows={2} value={form.prompt} onChange={(value) => setForm({ ...form, prompt: value })} />
                <GroveStack direction="horizontal" align="center" wrap="wrap" className="inline wrap">
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
                    <select aria-label="담당 봇" value={form.bot_id} onChange={(e) => setForm({ ...form, bot_id: e.target.value, confirmed: false })}>
                        <option value="">담당 봇 없음(새 대화)</option>
                        {projectBots.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
                    </select>
                    <select aria-label="예약 모델" value={profileId} disabled={!!bot} onChange={(e) => setForm({ ...form, profile_id: e.target.value })}>
                        {(profiles.data ?? []).map((p) => <option key={p.id} value={p.id} disabled={p.enabled === false}>{p.name}{p.enabled === false ? " · 비활성" : ""}</option>)}
                    </select>
                    <BooleanSelect label="도구 사용" value={form.tools} onChange={(value) => setForm({ ...form, tools: value })} />
                    <select aria-label="승인 필요 시" value={form.on_approval} onChange={(e) => setForm({ ...form, on_approval: e.target.value })}>
                        <option value="wait">승인 필요 시 기다림</option>
                        <option value="fail">승인 필요 시 실패</option>
                    </select>
                </GroveStack>
                <GroveStack direction="horizontal" align="center" wrap="wrap" className="inline wrap">
                    {form.kind !== "once" && (
                        <>
                            <input aria-label="최대 실행 횟수" type="number" min={1} placeholder="최대 횟수(없음)" value={form.max_runs} onChange={(e) => setForm({ ...form, max_runs: e.target.value })} />
                            <label className="small">
                                종료 일시 <input aria-label="종료 일시" type="datetime-local" value={form.end_at} onChange={(e) => setForm({ ...form, end_at: e.target.value })} />
                            </label>
                        </>
                    )}
                    <BooleanSelect label="결과가 직전과 같으면 알림 생략" value={form.quiet} onChange={(value) => setForm({ ...form, quiet: value })} />
                    <label className="small">
                        연속 실패 시 정지(회){" "}
                        <input aria-label="연속 실패 시 정지" type="number" min={1} max={100} placeholder="정지 안 함" value={form.pause_after_failures} onChange={(e) => setForm({ ...form, pause_after_failures: e.target.value })} />
                    </label>
                </GroveStack>
                {bot && (
                    <div className="stack small" data-testid="schedule-confirm">
                        <GroveText as="p" display="block" type="inherit" color="inherit">
                            활성화 전 확인: <strong>{bot.name}</strong>이(가) {form.kind === "daily" ? `매일 ${form.daily_time}` : form.kind === "interval" ? `${form.interval_minutes}분마다` : "한 번"} 이 프로젝트에서 모델 {profileName}로 실행합니다. 도구 {form.tools ? "사용" : "끔"}, 승인 필요 시 {form.on_approval === "wait" ? "대기" : "실패"}
                            {form.max_runs ? `, 최대 ${form.max_runs}회` : ""}. 실행마다 모델 비용이 발생하고 결과는 봇 대화에 남습니다.
                        </GroveText>
                        <BooleanSelect label="위 범위를 확인했습니다" value={form.confirmed} trueLabel="확인함" falseLabel="미확인" onChange={(value) => setForm({ ...form, confirmed: value })} />
                        <BooleanSelect label="저장만 하고 일시 정지 상태로 둠" value={form.start_paused} onChange={(value) => setForm({ ...form, start_paused: value })} />
                    </div>
                )}
                <ServerActionButton type="submit" disabled={!form.name.trim() || !form.prompt.trim() || !profileId || (!!bot && !form.confirmed)}>예약 추가</ServerActionButton>
            </form>
        </Panel>
    );
}
