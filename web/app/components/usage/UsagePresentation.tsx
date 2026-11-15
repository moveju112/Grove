import { Stack as GroveStack } from "@astryxdesign/core/Stack";
import { Select } from "../../design/Select";
import { Card } from "@astryxdesign/core/Card";
import { Grid, GridSpan } from "@astryxdesign/core/Grid";
import { ProgressBar } from "@astryxdesign/core/ProgressBar";
import { Text as GroveText } from "@astryxdesign/core/Text";
import { Table, TableHeader, TableBody, TableRow, TableHeaderCell, TableCell } from "@astryxdesign/core/Table";
import { useState } from "react";
import {
    costCurrencies, formatCost, formatNumber as fmt, formatShare, sortRows, tokenShare, totalTokens,
    type SortDirection, type SortKey, type UsageReport, type UsageRow,
} from "./model";

function ReportingDetails({ row }: { row: UsageRow }) {
    return (
        <GroveText type="supporting" color="secondary">
            cache 읽기 {fmt(row.cache_read_tokens)} tokens(입력에 포함)
            <br />
            {row.responses > 0 && row.reasoning_unreported_responses === row.responses
                ? "reasoning: 보고된 값 없음"
                : <>보고된 reasoning {fmt(row.reasoning_tokens)} tokens(출력에 포함)</>}
            {row.reasoning_unreported_responses > 0 && <> · 미보고 응답 {fmt(row.reasoning_unreported_responses)}개</>}
        </GroveText>
    );
}

function CostDetails({ row }: { row: UsageRow }) {
    return (
        <>
            <GroveText type="inherit" color="inherit">{formatCost(row)}</GroveText>
            {row.unpriced_tokens > 0 && <GroveText type="supporting" color="warning"> · 가격 미설정 {fmt(row.unpriced_tokens)} tokens(비용에 포함 안 됨)</GroveText>}
        </>
    );
}

/// 비율은 Astryx의 진행 표시로, 수치·분모는 색에 의존하지 않는 본문으로 제공한다.
export function TokenDonut({ total }: { total: UsageRow }) {
    const tokens = totalTokens(total);
    const inputShare = tokenShare(total.input_tokens, tokens);
    const outputShare = tokenShare(total.output_tokens, tokens);
    return (
        <GroveStack as="figure" gap={2} data-testid="usage-donut">
            <GroveStack as="figcaption" gap={1}>
                <GroveText weight="bold">입력·출력 구성</GroveText>
                <GroveText>분모: 입력+출력 {fmt(tokens)} tokens</GroveText>
                <GroveText>입력 {fmt(total.input_tokens)} tokens · {formatShare(inputShare)}</GroveText>
                <GroveText>출력 {fmt(total.output_tokens)} tokens · {formatShare(outputShare)}</GroveText>
                {tokens === 0 && <GroveText as="p" display="block" type="inherit" color="secondary">총 token이 0이라 비율을 계산하지 않습니다.</GroveText>}
            </GroveStack>
            {tokens > 0 && <GroveStack gap={2} maxWidth={320}>
                <ProgressBar value={total.input_tokens} max={tokens} label="입력 token 비율" />
                <ProgressBar value={total.output_tokens} max={tokens} label="출력 token 비율" />
            </GroveStack>}
        </GroveStack>
    );
}

export function UsagePresentation({ report, groupLabel }: { report: UsageReport; groupLabel: string }) {
    const [sort, setSort] = useState<SortKey>("tokens");
    const [direction, setDirection] = useState<SortDirection>("desc");
    const currencies = costCurrencies(report);
    // 다른 기간·묶음에서 해당 통화가 사라지면 유효한 token 정렬로 돌아간다.
    const activeSort = sort.startsWith("cost:") && !currencies.includes(sort.slice(5)) ? "tokens" : sort;
    const rows = sortRows(report.rows, activeSort, direction);
    const total = report.total;
    const tokens = totalTokens(total);
    const sortOptions: [SortKey, string][] = [
        ["tokens", "총 token"], ["label", groupLabel], ["input_tokens", "입력"],
        ["output_tokens", "출력"], ["responses", "응답"],
        ...currencies.map((currency): [SortKey, string] => [`cost:${currency}`, `추정 비용 (${currency})`]),
    ];
    return (
        <GroveStack gap={3} paddingBlockStart={3}>
            <Grid gap={2} columns={{ minWidth: 140, repeat: "fit" }} data-testid="usage-total">
                {[
                    ["총 token (입력+출력)", fmt(tokens)],
                    ["입력 tokens", fmt(total.input_tokens)],
                    ["출력 tokens", fmt(total.output_tokens)],
                    ["응답", `${fmt(total.responses)}개`],
                ].map(([label, value]) => <Card key={label} padding={3}>
                    <GroveStack gap={1}>
                        <GroveText>{label}</GroveText>
                        <GroveText size="xl" weight="bold" hasTabularNumbers>{value}</GroveText>
                    </GroveStack>
                </Card>)}
                <GridSpan columns="full"><Card padding={3}>
                    <GroveStack gap={1}><GroveText>추정 비용 · 통화별 별도 금액</GroveText><CostDetails row={total} /></GroveStack>
                </Card></GridSpan>
            </Grid>
            <ReportingDetails row={total} />
            <TokenDonut total={total} />
            {rows.length > 0 && (
                <>
                    <GroveStack direction="horizontal" align="center" wrap="wrap" gap={1.5}>
                        <Select label="정렬 기준" value={activeSort} onChange={(value) => setSort(value as SortKey)}
                            options={sortOptions.map(([value, label]) => ({ value, label }))} />
                        <Select label="정렬 방향" value={direction} onChange={(value) => setDirection(value as SortDirection)}
                            options={[{ value: "desc", label: "내림차순" }, { value: "asc", label: "오름차순" }]} />
                    </GroveStack>
                        <Table density="compact" aria-label="사용량 비교 표" data-testid="usage-table">
                            <caption>{groupLabel}별 사용량 · 비율 분모: 이 기간의 입력+출력 {fmt(tokens)} tokens</caption>
                            <TableHeader>
                                <TableRow isHeaderRow>
                                    <TableHeaderCell scope="col">{groupLabel}</TableHeaderCell><TableHeaderCell scope="col">입력</TableHeaderCell><TableHeaderCell scope="col">출력</TableHeaderCell>
                                    <TableHeaderCell scope="col">총 token · 비율</TableHeaderCell><TableHeaderCell scope="col">응답</TableHeaderCell>
                                    <TableHeaderCell scope="col">세부 token</TableHeaderCell><TableHeaderCell scope="col">추정 비용</TableHeaderCell>
                                </TableRow>
                            </TableHeader>
                            <TableBody>
                                {rows.map((row) => {
                                    const share = tokenShare(totalTokens(row), tokens);
                                    return (
                                        <TableRow key={row.key}>
                                            <TableHeaderCell scope="row">{row.label}</TableHeaderCell>
                                            <TableCell>{fmt(row.input_tokens)}</TableCell><TableCell>{fmt(row.output_tokens)}</TableCell>
                                            <TableCell>
                                                {fmt(totalTokens(row))} tokens · {formatShare(share)}
                                                <ProgressBar value={share ?? 0} max={1}
                                                    label={`${row.label} token 비율`} isLabelHidden aria-hidden="true" />
                                            </TableCell>
                                            <TableCell>{fmt(row.responses)}</TableCell>
                                            <TableCell><ReportingDetails row={row} /></TableCell>
                                            <TableCell><CostDetails row={row} /></TableCell>
                                        </TableRow>
                                    );
                                })}
                            </TableBody>
                        </Table>
                </>
            )}
        </GroveStack>
    );
}
