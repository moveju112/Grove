import { useState } from "react";
import { api } from "../api/client";
import { useQuery } from "../state/store";

type Row = {
    key: string;
    label: string;
    input_tokens: number;
    output_tokens: number;
    cache_read_tokens: number;
    reasoning_tokens: number;
    reasoning_unreported_responses: number;
    responses: number;
    estimated_cost: { currency: string; amount: number }[];
    unpriced_tokens: number;
};
type Report = { rows: Row[]; total: Row; pricing_versions: string[] };

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

const fmt = (n: number) => n.toLocaleString();
const cost = (r: Row) =>
    r.estimated_cost.length === 0 ? null : r.estimated_cost.map((c) => `${c.amount.toLocaleString(undefined, { maximumFractionDigits: 4 })} ${c.currency}`).join(" + ");

/// 사용량 카드: 표와 막대(텍스트로도 같은 값). 비용은 프로필 가격표 기준 추정이다.
export function UsagePanel() {
    const [days, setDays] = useState(7);
    const [group, setGroup] = useState("day");
    const { from, to } = range(days);
    const tz = -new Date().getTimezoneOffset();
    const q = useQuery<Report>(`usage:${days}:${group}`, () =>
        api.get(`/usage?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&group_by=${group}&tz_offset_minutes=${tz}`),
    );
    const rows = q.data?.rows ?? [];
    const max = Math.max(1, ...rows.map((r) => r.input_tokens + r.output_tokens));
    const t = q.data?.total;
    return (
        <section className="setting" data-testid="usage-panel">
            <h2>사용량</h2>
            <div className="inline wrap">
                <select aria-label="기간" value={days} onChange={(e) => setDays(Number(e.target.value))}>
                    {PERIODS.map(([d, l]) => <option key={d} value={d}>{l}</option>)}
                </select>
                <select aria-label="묶음" value={group} onChange={(e) => setGroup(e.target.value)}>
                    {GROUPS.map(([g, l]) => <option key={g} value={g}>{l}</option>)}
                </select>
            </div>
            {t && (
                <p data-testid="usage-total">
                    합계: 입력 {fmt(t.input_tokens)} · 출력 {fmt(t.output_tokens)} · cache 읽기 {fmt(t.cache_read_tokens)} tokens · 응답 {t.responses}개
                    <br />
                    추정 비용: {cost(t) ?? "—"}
                    {t.unpriced_tokens > 0 && <span className="warn"> · 가격 미설정 {fmt(t.unpriced_tokens)} tokens(비용에 포함 안 됨)</span>}
                    {t.reasoning_unreported_responses > 0 && <span className="muted small"> · reasoning token을 보고하지 않은 응답 {t.reasoning_unreported_responses}개</span>}
                </p>
            )}
            <p className="muted small">
                비용은 모델 프로필 가격표{q.data?.pricing_versions.length ? `(${q.data.pricing_versions.join(", ")})` : ""}로 계산한 추정치이며 계정 청구액·quota와 다를 수 있습니다.
            </p>
            {rows.length === 0 ? (
                <p className="muted">이 기간에 사용량이 없습니다.</p>
            ) : (
                <table className="usage" data-testid="usage-table">
                    <thead>
                        <tr><th>{GROUPS.find((g) => g[0] === group)?.[1]}</th><th>입력</th><th>출력</th><th>추정 비용</th><th aria-hidden>비율</th></tr>
                    </thead>
                    <tbody>
                        {rows.map((r) => (
                            <tr key={r.key}>
                                <td>{r.label}</td>
                                <td>{fmt(r.input_tokens)}</td>
                                <td>{fmt(r.output_tokens)}</td>
                                <td>{cost(r) ?? <span className="muted">가격 미설정</span>}</td>
                                <td aria-hidden>
                                    <span className="bar" style={{ width: `${Math.round(((r.input_tokens + r.output_tokens) / max) * 100)}%` }} />
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            )}
        </section>
    );
}
