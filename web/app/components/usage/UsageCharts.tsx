import { Stack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { useEffect, useRef, useState } from "react";
import * as stylex from "@stylexjs/stylex";
import type { UsageDashboard } from "../../api/generated";
import { usePrefs } from "../../state/device";
import { absoluteTime } from "../../state/time";
import { compact, number, speed, tokens } from "./dashboardModel";
import { dashboardStyles as styles } from "./dashboard.stylex";

/** 원본의 140px 합계 막대·구성 차트에 터치/키보드 구간 조회를 보존한다. */
export function UsageCharts({ report }: { report: UsageDashboard }) {
    const [selection, setSelection] = useState<{ from: string; index: number } | null>(null);
    const [width, setWidth] = useState(400);
    const plot = useRef<SVGSVGElement>(null);
    const prefs = usePrefs();
    useEffect(() => {
        const element = plot.current;
        if (!element) return;
        const observer = new ResizeObserver(([entry]) => setWidth(Math.max(1, entry!.contentRect.width)));
        observer.observe(element);
        return () => observer.disconnect();
    }, []);
    const series = report.series;
    const selected = selection?.from === report.from ? Math.min(selection.index, series.length - 1) : 0;
    const bucket = selection?.from === report.from ? series[selected] : null;
    const maxTokens = Math.max(0, ...series.map((point) => tokens(point.total)));
    const peak = Math.max(1, maxTokens);
    const step = width / Math.max(1, series.length);
    const gap = series.length > 60 ? 1 : 3;
    const labelStep = Math.max(1, Math.ceil(series.length / 8));
    const groups = series.filter((_, i) => i % labelStep === 0);
    const label = (at: string) => new Date(at).toLocaleString(undefined, report.interval === "hour"
        ? { hour: "numeric", minute: "2-digit", hour12: prefs.clock === "system" ? undefined : prefs.clock === "12h" }
        : { month: "numeric", day: "numeric" });
    const choose = (index: number) => setSelection({ from: report.from, index });
    const m = report.total;
    // Grove의 정규화된 입력에는 캐시가 포함된다. 구성에서 한 번만 집계한다.
    const breakdown = [
        { label: "입력", value: Math.max(0, m.input_tokens - m.cache_read_tokens - m.cache_write_tokens), color: "var(--accent)" },
        { label: "출력", value: m.output_tokens, color: "var(--ok)" },
        { label: "캐시 읽기", value: m.cache_read_tokens, color: "var(--warn)" },
        { label: "캐시 쓰기", value: m.cache_write_tokens, color: "var(--muted)" },
    ];
    const sum = breakdown.reduce((n, item) => n + item.value, 0);
    let offset = 0;
    return <Stack xstyle={styles.card} data-testid="usage-charts">
        <Stack as="figure" gap={0} data-testid="usage-chart-tokens">
            <Stack as="figcaption" direction="horizontal" justify="between" wrap="wrap" gap={1.5} xstyle={styles.chartCaption}>
                <Text weight="semibold" xstyle={styles.text}>추이</Text>
                <Text color="secondary" xstyle={styles.small}>모든 제공자 합계 · 구간 최대 {number(maxTokens)} 토큰</Text>
            </Stack>
            <Stack direction="horizontal" xstyle={styles.chartRow}>
                <Stack justify="between" align="end" xstyle={styles.axis} aria-hidden="true">
                    <Text type="inherit">{compact(peak)}</Text><Text type="inherit">{compact(peak / 2)}</Text><Text type="inherit">0</Text>
                </Stack>
                <Stack xstyle={styles.plot}>
                    <svg ref={plot} viewBox={`0 0 ${width} 140`} preserveAspectRatio="none" {...stylex.props(styles.chart)} role="group" aria-label="시간별 토큰 사용량">
                        {[0, 0.5, 1].map((ratio) => <line key={ratio} x1={0} x2={width} y1={ratio * 139} y2={ratio * 139} stroke="var(--line)" opacity={ratio === 1 ? 1 : 0.5} />)}
                        {series.map((point, i) => {
                            const amount = tokens(point.total), height = Math.max(1, amount / peak * 140);
                            return <rect key={point.start} x={i * step} y={140 - height} width={Math.max(0.1, step - gap)} height={height}
                                rx={Math.min(3, Math.max(0.1, step - gap) / 2)} fill="var(--accent)" opacity={amount ? 1 : 0.35} />;
                        })}
                        {bucket && <line x1={(selected + 0.5) * step} x2={(selected + 0.5) * step} y1={0} y2={140} stroke="var(--muted)" strokeDasharray="2 3" />}
                        {series.map((point, i) => <rect key={point.start} x={i * step} y={0} width={step} height={140}
                            {...stylex.props(styles.bucket)} role="button" tabIndex={i === selected ? 0 : -1}
                            aria-label={`${absoluteTime(point.start, prefs)} · ${number(tokens(point.total))} 토큰 · ${speed(point.total.tok_per_second)} tok/s`}
                            onClick={() => choose(i)} onFocus={() => choose(i)} onKeyDown={(event) => {
                                if (!["ArrowLeft", "ArrowRight", "Home", "End", "Enter", " "].includes(event.key)) return;
                                event.preventDefault();
                                const next = event.key === "Home" ? 0 : event.key === "End" ? series.length - 1 : event.key === "ArrowLeft" ? Math.max(0, i - 1) : event.key === "ArrowRight" ? Math.min(series.length - 1, i + 1) : i;
                                choose(next);
                                event.currentTarget.parentElement?.querySelectorAll<SVGElement>('[role="button"]')[next]?.focus();
                            }} />)}
                    </svg>
                    <Stack direction="horizontal" gap={0}>
                        {groups.map((point, i) => <Stack key={point.start} xstyle={[styles.axisLabels, styles.labelGroup(Math.min(labelStep, series.length - i * labelStep))]}><Text type="inherit">{label(point.start)}</Text></Stack>)}
                    </Stack>
                </Stack>
            </Stack>
            {bucket && <Stack as="output" xstyle={styles.selected} aria-live="polite" paddingBlockStart={2}>
                {absoluteTime(bucket.start, prefs)} · {number(tokens(bucket.total))} 토큰 · {speed(bucket.total.tok_per_second)} tok/s
            </Stack>}
        </Stack>
        <Stack xstyle={styles.composition}>
            <Text weight="semibold" xstyle={styles.text}>구성</Text>
            <svg viewBox="0 0 100 8" preserveAspectRatio="none" {...stylex.props(styles.compositionBar)} role="img" aria-label="캐시를 중복 합산하지 않은 토큰 구성">
                {breakdown.map((item) => {
                    const x = offset;
                    const width = sum > 0 ? item.value / sum * 100 : 0;
                    offset += width;
                    return <rect key={item.label} x={x} y={0} width={width} height={8} fill={item.color} />;
                })}
            </svg>
            <Stack direction="horizontal" wrap="wrap" xstyle={styles.legend}>
                {breakdown.map((item) => <Stack key={item.label} as="span" direction="horizontal" align="center" gap={1.5}>
                    <svg width={8} height={8} aria-hidden="true"><circle cx={4} cy={4} r={4} fill={item.color} /></svg>
                    <Text color="secondary" xstyle={styles.small}>{item.label}</Text><Text xstyle={styles.legendValue}>{number(item.value)}</Text>
                </Stack>)}
            </Stack>
        </Stack>
    </Stack>;
}
