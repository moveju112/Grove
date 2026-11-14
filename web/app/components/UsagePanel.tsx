import { useState } from "react";
import { ApiError, api } from "../api/client";
import { type QueueInfo, queueText } from "../state/queue";
import { useQuery } from "../state/store";
import { UsagePresentation } from "./usage/UsagePresentation";
import type { UsageReport } from "./usage/model";
import { ServerActionButton } from "./pwa/ServerActionButton";
import { SettingsGroup } from "./SettingsGroup";

type CapacityRequest = { turn_id: string; status: string; session_id: string; session_title: string; project_id: string; queue?: QueueInfo };
type Capacity = {
    limits: { max_active: number | null; max_queued_per_owner: number | null; max_queued_total: number | null };
    server: { running: number; waiting: number };
    mine: { running: number; waiting: number; awaiting_user: number };
    requests: CapacityRequest[];
};

/// 실행 용량(FAIR-011): 서버 전체는 합계·한도만, 대기 이유와 취소는 이 기기의 요청에만 보여 준다.
function CapacitySection() {
    const q = useQuery<Capacity>("usage-capacity", () => api.get("/usage/capacity"));
    const [err, setErr] = useState<string | null>(null);
    const c = q.data;
    if (!c) return null;
    const cancel = async (id: string) => {
        setErr(null);
        try {
            await api.post(`/turns/${id}/cancel`);
        } catch (e) {
            setErr(e instanceof ApiError ? e.message : "취소 실패");
        }
        q.reload();
    };
    const limit = (n: number | null) => (n == null ? "제한 없음" : String(n));
    return (
        <div data-testid="usage-capacity">
            <h3>실행 용량</h3>
            <p>
                서버 전체: 실행 {c.server.running}/{limit(c.limits.max_active)} · 대기 {c.server.waiting}
                <span className="muted small"> · 기기별 대기 한도 {limit(c.limits.max_queued_per_owner)} · 서버 대기 한도 {limit(c.limits.max_queued_total)}</span>
            </p>
            {c.requests.length === 0 ? (
                <p className="muted">이 기기에서 실행·대기 중인 요청이 없습니다.</p>
            ) : (
                <ul className="session-list">
                    {c.requests.map((r) => (
                        <li key={r.turn_id} data-testid="capacity-request">
                            <span>{r.session_title || "제목 없는 대화"}</span>{" "}
                            <span className="muted small">
                                {r.queue ? queueText(r.queue) : r.status === "awaiting_approval" ? "승인·답변 대기(실행 슬롯 사용 안 함)" : r.status === "queued" ? "대기 중" : "실행 중"}
                            </span>{" "}
                            <ServerActionButton className="ghost small" onClick={() => void cancel(r.turn_id)}>취소</ServerActionButton>
                        </li>
                    ))}
                </ul>
            )}
            {err && <p className="error" role="alert">{err}</p>}
        </div>
    );
}

const GROUPS: [string, string][] = [
    ["day", "일별"],
    ["week", "주별(월요일 시작)"],
    ["month", "월별"],
    ["model", "모델"],
    ["provider", "provider"],
    ["agent", "에이전트"],
    ["workflow", "워크플로우"],
    ["project", "프로젝트"],
    ["session", "대화"],
];
const PERIODS: [number, string][] = [
    [1, "오늘"],
    [7, "7일"],
    [30, "30일"],
    [90, "90일"],
];

function range(days: number) {
    const to = new Date();
    const from = new Date(to);
    from.setHours(0, 0, 0, 0);
    from.setDate(from.getDate() - (days - 1));
    to.setTime(to.getTime() + 60_000);
    return { from: from.toISOString(), to: to.toISOString() };
}

/// 조회 계약·실행 용량은 유지하고 사용량 표현만 전용 컴포넌트에 전달한다.
export function UsagePanel() {
    const [days, setDays] = useState(7);
    const [group, setGroup] = useState("day");
    const { from, to } = range(days);
    const tz = -new Date().getTimezoneOffset();
    const q = useQuery<UsageReport>(`usage:${days}:${group}`, () =>
        api.get(`/usage?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&group_by=${group}&tz_offset_minutes=${tz}`),
    );
    return (
        <SettingsGroup title="사용량" scope="서버 전체" testId="usage-panel">
            <CapacitySection />
            <div className="inline wrap">
                <select aria-label="기간" value={days} onChange={(e) => setDays(Number(e.target.value))}>
                    {PERIODS.map(([d, l]) => <option key={d} value={d}>{l}</option>)}
                </select>
                <select aria-label="묶음" value={group} onChange={(e) => setGroup(e.target.value)}>
                    {GROUPS.map(([g, l]) => <option key={g} value={g}>{l}</option>)}
                </select>
                <button className="ghost" disabled={q.loading} onClick={q.reload}>{q.error ? "다시 시도" : "새로고침"}</button>
            </div>
            {(q.loading || (!q.data && !q.error)) && <p className="muted" role="status">사용량을 불러오는 중입니다.{q.data ? " 아래는 마지막으로 조회한 값입니다." : ""}</p>}
            {q.error != null && (
                <p className="err" role="alert">
                    사용량을 불러오지 못했습니다.{q.data ? " 아래는 마지막으로 조회한 값입니다." : " 다시 시도해 주세요."}
                </p>
            )}
            {q.data && <UsagePresentation report={q.data} groupLabel={GROUPS.find(([g]) => g === group)?.[1] ?? group} />}
            <p className="muted small">
                비용은 모델 프로필 가격표{q.data?.pricing_versions.length ? `(${q.data.pricing_versions.join(", ")})` : ""}로 계산한 추정치이며 계정 청구액·quota와 다를 수 있습니다.
            </p>
            {q.data && !q.loading && !q.error && q.data.rows.length === 0 && (
                <p className="muted">이 기간에 사용량이 없습니다.</p>
            )}
        </SettingsGroup>
    );
}
