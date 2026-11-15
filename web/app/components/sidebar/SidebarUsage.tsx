import { Text as GroveText } from "@astryxdesign/core/Text";
import { useEffect, useRef } from "react";
import { api } from "../../api/client";
import { useQuery } from "../../state/store";
import { formatShare, tokenShare, totalTokens, type UsageReport } from "../usage/model";

type Capacity = { limits: { max_active: number | null }; server: { running: number; waiting: number } };

/// 사이드바 맨 아래 요약. 서버가 아는 값(오늘 provider별 토큰, 실행 용량)만 보이며 계정 quota는 추정하지 않는다.
export function SidebarUsage() {
    const from = new Date();
    from.setHours(0, 0, 0, 0);
    const day = from.toISOString().slice(0, 10);
    const tz = -new Date().getTimezoneOffset();
    // to는 키에 넣지 않는다. 다시 읽을 때마다 현재 시각까지 조회한다.
    const usage = useQuery<UsageReport>(`usage:sidebar:${day}`, () =>
        api.get(`/usage?from=${encodeURIComponent(from.toISOString())}&to=${encodeURIComponent(new Date(Date.now() + 60_000).toISOString())}&group_by=provider&tz_offset_minutes=${tz}`));
    const capacity = useQuery<Capacity>("usage-capacity", () => api.get("/usage/capacity"));
    // reload는 렌더마다 새 함수라 ref로 최신 값을 읽어 1분 주기를 유지한다.
    const reload = useRef(() => {});
    reload.current = () => { usage.reload(); capacity.reload(); };
    useEffect(() => {
        const t = setInterval(() => reload.current(), 60_000);
        return () => clearInterval(t);
    }, []);

    const total = usage.data ? totalTokens(usage.data.total) : 0;
    const rows = (usage.data?.rows ?? []).filter((r) => totalTokens(r) > 0).slice(0, 3);
    const c = capacity.data;
    const max = c?.limits.max_active ?? null;
    if (rows.length === 0 && (!c || (c.server.running === 0 && c.server.waiting === 0))) return null;
    return (
        <section className="side-usage" aria-label="사용량 요약" data-testid="sidebar-usage">
            {c && (c.server.running > 0 || c.server.waiting > 0) && (
                <Meter label="실행 중" value={max ? `${c.server.running}/${max}` : `${c.server.running}`}
                    share={max ? c.server.running / max : null} note={c.server.waiting > 0 ? `대기 ${c.server.waiting}` : undefined} />
            )}
            {rows.map((r) => (
                    <Meter key={r.key} label={`${r.label} · 오늘`} value={compact(totalTokens(r))}
                        share={tokenShare(totalTokens(r), total)} shareText={formatShare(tokenShare(totalTokens(r), total))} />
                ))}
        </section>
    );
}

function Meter({ label, value, share, note, shareText }: { label: string; value: string; share: number | null; note?: string; shareText?: string }) {
    const pct = share === null ? null : Math.max(0, Math.min(1, share));
    return (
        <div className="side-meter">
            <GroveText type="inherit" color="inherit" className="side-meter-label">{label}</GroveText>
            <span className="side-meter-value num" title={shareText ? `오늘 전체의 ${shareText}` : undefined}>{value}</span>
            {pct !== null && (
                <GroveText type="inherit" color="inherit" className="side-meter-track" aria-hidden="true">
                    <i className={pct >= 0.7 ? "hi" : ""} style={{ transform: `scaleX(${pct})` }} />
                </GroveText>
            )}
            {note && <GroveText type="inherit" color="inherit" className="side-meter-note">{note}</GroveText>}
        </div>
    );
}

function compact(n: number): string {
    if (n >= 1_000_000) return `${(n / 1_000_000).toLocaleString(undefined, { maximumFractionDigits: 1 })}M 토큰`;
    if (n >= 1_000) return `${(n / 1_000).toLocaleString(undefined, { maximumFractionDigits: 1 })}K 토큰`;
    return `${n.toLocaleString()} 토큰`;
}
