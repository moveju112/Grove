import { Fragment, useState, type ReactNode } from "react";
import { Stack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { Heading } from "@astryxdesign/core/Heading";
import { Table, TableHeader, TableBody, TableRow, TableHeaderCell, TableCell } from "@astryxdesign/core/Table";
import { Button } from "../../design/Button";
import { Select } from "../../design/Select";
import type { UsageDashboard as Report, UsageMetrics } from "../../api/generated";
import { HelpTip } from "../HelpTip";
import { UsageCharts } from "./UsageCharts";
import { dashboardStyles as styles } from "./dashboard.stylex";
import { cacheHit, freshInput, number, providerName, providerRows, sortedRows, speed, tokens, type Group, type Sort } from "./dashboardModel";

type Column = { label: string; width: number; left?: boolean };
type Row = { key: string; cells: ReactNode[]; details?: ReactNode };
const summaryColumns: Column[] = [
    { label: "제공자", width: 90, left: true }, { label: "평균 모델 속도", width: 116 },
    { label: "하위 10% 평균 속도", width: 142 }, { label: "상위 10% 평균 속도", width: 142 },
    { label: "토큰", width: 120 }, { label: "호출", width: 68 }, { label: "캐시 적중", width: 80 },
];
const modelColumns: Column[] = [
    { label: "모델", width: 180, left: true }, { label: "호출", width: 64 }, { label: "TOK/S", width: 64 },
    { label: "토큰", width: 100 }, { label: "새 입력", width: 96 }, { label: "출력", width: 92 },
    { label: "캐시 읽기", width: 100 }, { label: "캐시 쓰기", width: 100 }, { label: "적중", width: 64 },
];
const effortColumns: Column[] = [
    { label: "모델", width: 200, left: true }, { label: "Effort", width: 96, left: true },
    { label: "Fast", width: 72, left: true }, { label: "TOK/S", width: 72 }, { label: "호출", width: 64 }, { label: "토큰", width: 110 },
];
const cacheWrites = (m: UsageMetrics) => m.responses > 0 && m.cache_write_unreported_responses === m.responses ? "—" : number(m.cache_write_tokens);

/** Paseodog과 같은 고정 숫자 열·우측 정렬. 좁은 화면에서도 표 안에서만 스크롤한다. */
function UsageTable({ columns, rows, label, testId }: { columns: Column[]; rows: Row[]; label: string; testId?: string }) {
    return <Table density="compact" dividers="none" textOverflow="truncate" aria-label={label} data-testid={testId}
        xstyle={styles.table(columns.reduce((sum, column) => sum + column.width, 0))}>
        <TableHeader><TableRow isHeaderRow>{columns.map((column, index) => <TableHeaderCell key={column.label} scope="col"
            xstyle={[styles.cell(column.width, index === 0), styles.headerCell, column.left && styles.left]}>{column.label}</TableHeaderCell>)}</TableRow></TableHeader>
        <TableBody>{rows.map((row, index) => <Fragment key={row.key}>
            <TableRow xstyle={[index > 0 && styles.tableRow]}>{row.cells.map((cell, i) => i === 0
                ? <TableHeaderCell key={i} scope="row" xstyle={[styles.cell(columns[i]!.width, true), columns[i]!.left && styles.left]}>{cell}</TableHeaderCell>
                : <TableCell key={i} xstyle={[styles.cell(columns[i]!.width, false), columns[i]!.left && styles.left]}>{cell}</TableCell>)}</TableRow>
            {row.details && <TableRow><TableCell colSpan={columns.length} xstyle={styles.cell(0, true)}>{row.details}</TableCell></TableRow>}
        </Fragment>)}</TableBody>
    </Table>;
}

function TokenDetails({ metrics: m }: { metrics: UsageMetrics }) {
    return <Stack xstyle={styles.details}>
        <Text xstyle={styles.small}>새 입력 {number(freshInput(m))} · 출력 {number(m.output_tokens)}</Text>
        <Text xstyle={styles.small}>캐시 읽기 {number(m.cache_read_tokens)} · 쓰기 {cacheWrites(m)}{m.cache_write_unreported_responses > 0 ? ` · 쓰기 미보고 ${number(m.cache_write_unreported_responses)}개 응답` : ""}</Text>
        <Text xstyle={styles.small}>reasoning {number(m.reasoning_tokens)}{m.reasoning_unreported_responses > 0 ? ` · 미보고 ${number(m.reasoning_unreported_responses)}개 응답` : ""}</Text>
        <Text xstyle={styles.hint} color="secondary">속도 측정 {number(m.measured_responses)}/{number(m.responses)}개 응답 · 출력 {number(m.measured_output_tokens)} 토큰 / 모델 요청 {(m.response_ms / 1000).toLocaleString()}초</Text>
        {m.unreported_responses > 0 && <Text xstyle={styles.hint} color="warning">토큰 미보고 {number(m.unreported_responses)}개 응답 · 보고된 토큰만 합산했어요.</Text>}
    </Stack>;
}

const GROUPS: { value: Group; label: string }[] = [
    { value: "models", label: "모델별" }, { value: "projects", label: "프로젝트별" }, { value: "agents", label: "에이전트별" },
    { value: "workflows", label: "워크플로우별" }, { value: "sessions", label: "대화별" }, { value: "efforts", label: "Effort·Fast별" },
];

export function UsageDashboard({ report, quotas }: { report: Report; quotas?: ReactNode }) {
    const [group, setGroup] = useState<Group>("models");
    const [sort, setSort] = useState<Sort>("tokens");
    const [provider, setProvider] = useState("all");
    const [expanded, setExpanded] = useState<string | null>(null);
    const providers = providerRows(report.providers);
    const activeProvider = provider === "all" || providers.some((row) => row.provider === provider) ? provider : "all";
    const rows = sortedRows(report, group, sort, activeProvider);
    const total = report.total;
    const summaries = providers.map((row) => ({ key: row.provider, label: providerName(row.provider), metrics: row.metrics }));
    const tokenWidth = Math.max(120, ...summaries.map((row) => number(tokens(row.metrics)).length * 7 + 12));
    const summaryCells = (m: UsageMetrics, key: string) => [
        <Text key="speed" as="span" type="inherit" data-testid={`usage-speed-${key}`}>{speed(m.tok_per_second)} tok/s</Text>,
        `${speed(m.low10_tok_per_second)} tok/s`, `${speed(m.high10_tok_per_second)} tok/s`,
        <Text key="tokens" as="span" type="inherit" aria-label={`${number(tokens(m))} 토큰`} data-testid={`usage-token-${key}`}>{number(tokens(m))}</Text>,
        number(m.responses), cacheHit(m),
    ];
    const agents = [...new Set(report.efforts.map((row) => row.context?.agent ?? null))];
    return <Stack xstyle={styles.flow} aria-label="사용량 통계">
        <Stack xstyle={styles.card} data-testid="usage-providers">
            <Stack xstyle={styles.desktop} data-testid="usage-total">
                <UsageTable columns={summaryColumns.map((column) => column.label === "토큰" ? { ...column, width: tokenWidth } : column)} label="제공자별 사용량 요약" rows={summaries.map((row) => ({ key: row.key, cells: [row.label, ...summaryCells(row.metrics, row.key)] }))} />
            </Stack>
            <Stack xstyle={[styles.mobile, styles.flow]} data-testid="usage-mobile-summary">
                {summaries.map((row) => <Stack key={row.key} gap={2}>
                    <Text xstyle={styles.cardTitle}>{row.label}</Text>
                    <UsageTable columns={[{ label: "지표", width: 148, left: true }, { label: "값", width: Math.max(112, tokenWidth) }]} label={`${row.label} 사용량 요약`}
                        rows={summaryCells(row.metrics, row.key).map((cell, i) => ({ key: summaryColumns[i + 1]!.label, cells: [summaryColumns[i + 1]!.label, cell] }))} />
                </Stack>)}
            </Stack>
        </Stack>
        <Stack gap={0.5}>
            <Stack direction="horizontal" align="center" gap={1}>
                <Text xstyle={styles.hint} color="secondary">평균 모델 속도: 출력 토큰 / 모델 요청 시간 · 측정 {number(total.measured_responses)}/{number(total.responses)}개 응답</Text>
                <HelpTip label="tok/s 계산 기준"><Text>로컬 도구 실행과 대기열 시간은 제외해요. Claude Code는 CLI가 보고한 API 요청 시간의 합을 써요. 모델 시간이 없는 응답(과거 기록 포함)이나 출력이 없는 응답은 제외해요.</Text></HelpTip>
            </Stack>
            <Text xstyle={styles.hint} color="secondary">하위·상위 10%: 느린·빠른 응답의 평균 속도</Text>
        </Stack>
        {quotas}
        <Stack direction="horizontal" align="center" gap={1}>
            <Heading level={2} xstyle={styles.sectionTitle}>토큰</Heading>
            <HelpTip label="토큰 집계 기준"><Text>총토큰은 새 입력·캐시 읽기·캐시 쓰기·출력의 합이에요. 적중률은 전체 입력 중 캐시 읽기 비율이에요. 실패·취소 등 저장되지 않은 사용량은 포함되지 않아요.</Text></HelpTip>
        </Stack>
        <UsageCharts report={report} />
        <Stack as="section" xstyle={styles.flow} data-testid="usage-breakdown">
            <Stack direction="horizontal" xstyle={styles.baseline} gap={2} wrap="wrap">
                <Heading level={2} xstyle={styles.sectionTitle}>제공자·모델</Heading>
                <Text xstyle={styles.small} color="secondary">{providers.length}개 제공자</Text>
            </Stack>
            <Stack xstyle={styles.card}>
                <Stack direction="horizontal" align="center" gap={2} wrap="wrap">
                    <Select label="묶음" hideLabel value={group} onChange={(value) => setGroup(value as Group)} options={GROUPS} />
                    <Select label="정렬 기준" hideLabel value={sort} onChange={(value) => setSort(value as Sort)} options={[{ value: "tokens", label: "토큰 많은 순" }, { value: "speed", label: "tok/s 높은 순" }]} />
                    <Select label="공급자 필터" hideLabel value={activeProvider} onChange={setProvider} options={[{ value: "all", label: "모든 제공자" }, ...providers.map((row) => ({ value: row.provider, label: providerName(row.provider) }))]} />
                </Stack>
                <UsageTable columns={[{ ...modelColumns[0]!, label: group === "models" ? "모델" : GROUPS.find((g) => g.value === group)!.label }, ...modelColumns.slice(1)]}
                    testId="usage-table" label="사용량 비교 표" rows={rows.map((row) => {
                        const key = JSON.stringify([group, row.provider, row.key]);
                        return { key, cells: [
                            <Button key="name" type="button" appearance="disclosure" xstyle={styles.modelButton} title={`${providerName(row.provider)} · ${row.label}`}
                                aria-expanded={expanded === key} onClick={() => setExpanded(expanded === key ? null : key)}>{providerName(row.provider)} · {row.label}</Button>,
                            number(row.metrics.responses), speed(row.metrics.tok_per_second), number(tokens(row.metrics)),
                            number(freshInput(row.metrics)), number(row.metrics.output_tokens), number(row.metrics.cache_read_tokens), cacheWrites(row.metrics), cacheHit(row.metrics),
                        ], details: expanded === key ? <TokenDetails metrics={row.metrics} /> : undefined };
                    })} />
                {rows.length === 0 && <Text xstyle={styles.small} color="secondary">이 조건에 맞는 사용 내역이 없어요.</Text>}
            </Stack>
        </Stack>
        <Stack direction="horizontal" xstyle={styles.baseline} gap={2} wrap="wrap">
            <Heading level={2} xstyle={styles.sectionTitle}>에이전트·Effort·Fast</Heading>
            <Text xstyle={styles.small} color="secondary">모델·요청 effort·Fast 설정별 속도 비교</Text>
        </Stack>
        {agents.map((agent) => <Stack key={JSON.stringify(agent)} xstyle={styles.card}>
            <Text xstyle={styles.cardTitle}>{agent ?? "에이전트 미기록"}</Text>
            <UsageTable columns={effortColumns} label={`${agent ?? "에이전트 미기록"} 에이전트 사용량`} rows={report.efforts.filter((row) => (row.context?.agent ?? null) === agent).map((row) => ({
                key: JSON.stringify([row.provider, row.key]), cells: [
                    `${providerName(row.provider)} · ${row.context?.model ?? row.label}`, row.context?.effort ?? "미기록",
                    row.context?.fast === true ? "켜짐" : row.context?.fast === false ? "꺼짐" : "미기록",
                    speed(row.metrics.tok_per_second), number(row.metrics.responses), number(tokens(row.metrics)),
                ],
            }))} />
        </Stack>)}
        {agents.length === 0 && <Text xstyle={styles.small} color="secondary">선택한 기간에 Effort·Fast별 상세 기록이 없습니다.</Text>}
        <Text xstyle={styles.hint} color="secondary">과거 기록은 추정하지 않고 미기록으로 표시하며, 상세 기록이 없는 합계는 이 분류에 포함되지 않을 수 있어요.</Text>
        {total.responses === 0 && <Text xstyle={styles.small} color="secondary" role="status">이 기간에 기록된 사용량이 없어요.</Text>}
        {total.unreported_responses > 0 && <Text xstyle={styles.hint} color="warning">토큰 미보고 {number(total.unreported_responses)}개 응답 · 합계는 보고된 값 기준이에요.</Text>}
    </Stack>;
}
