import { useState } from "react";
import {
    costCurrencies, formatCost, formatNumber as fmt, formatShare, sortRows, tokenShare, totalTokens,
    type SortDirection, type SortKey, type UsageReport, type UsageRow,
} from "./model";
import "./usage.css";

function ReportingDetails({ row }: { row: UsageRow }) {
    return (
        <span className="muted small">
            cache 읽기 {fmt(row.cache_read_tokens)} tokens(입력에 포함)
            <br />
            {row.responses > 0 && row.reasoning_unreported_responses === row.responses
                ? "reasoning: 보고된 값 없음"
                : <>보고된 reasoning {fmt(row.reasoning_tokens)} tokens(출력에 포함)</>}
            {row.reasoning_unreported_responses > 0 && <> · 미보고 응답 {fmt(row.reasoning_unreported_responses)}개</>}
        </span>
    );
}

function CostDetails({ row }: { row: UsageRow }) {
    return (
        <>
            <span>{formatCost(row)}</span>
            {row.unpriced_tokens > 0 && <span className="warn small"> · 가격 미설정 {fmt(row.unpriced_tokens)} tokens(비용에 포함 안 됨)</span>}
        </>
    );
}

/// 색상 정보와 무관하게 같은 수치·분모를 figcaption과 표에서 읽을 수 있다.
export function TokenDonut({ total }: { total: UsageRow }) {
    const tokens = totalTokens(total);
    const inputShare = tokenShare(total.input_tokens, tokens);
    const outputShare = tokenShare(total.output_tokens, tokens);
    return (
        <figure className="usage-donut" data-testid="usage-donut">
            <svg viewBox="0 0 120 120" aria-hidden="true" focusable="false">
                <circle className="usage-ring-base" cx="60" cy="60" r="44" />
                {tokens > 0 && (
                    <g transform="rotate(-90 60 60)">
                        <circle className="usage-ring-output" cx="60" cy="60" r="44" />
                        <circle className="usage-ring-input" cx="60" cy="60" r="44" pathLength="100"
                            strokeDasharray={`${(inputShare ?? 0) * 100} 100`} />
                    </g>
                )}
            </svg>
            <figcaption>
                <strong>입력·출력 구성</strong>
                <p>분모: 입력+출력 {fmt(tokens)} tokens</p>
                <p><span className="usage-swatch usage-input" aria-hidden="true" />입력 {fmt(total.input_tokens)} tokens · {formatShare(inputShare)}</p>
                <p><span className="usage-swatch usage-output" aria-hidden="true" />출력 {fmt(total.output_tokens)} tokens · {formatShare(outputShare)}</p>
                {tokens === 0 && <p className="muted">총 token이 0이라 비율을 계산하지 않습니다.</p>}
            </figcaption>
        </figure>
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
        <div className="usage-presentation">
            <div className="usage-cards" data-testid="usage-total">
                <div className="usage-card"><span>총 token (입력+출력)</span><strong>{fmt(tokens)}</strong></div>
                <div className="usage-card"><span>입력 tokens</span><strong>{fmt(total.input_tokens)}</strong></div>
                <div className="usage-card"><span>출력 tokens</span><strong>{fmt(total.output_tokens)}</strong></div>
                <div className="usage-card"><span>응답</span><strong>{fmt(total.responses)}개</strong></div>
                <div className="usage-card usage-cost-card"><span>추정 비용 · 통화별 별도 금액</span><CostDetails row={total} /></div>
            </div>
            <ReportingDetails row={total} />
            <TokenDonut total={total} />
            {rows.length > 0 && (
                <>
                    <div className="inline wrap">
                        <label>정렬 기준{" "}
                            <select aria-label="정렬 기준" value={activeSort} onChange={(e) => setSort(e.target.value as SortKey)}>
                                {sortOptions.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                            </select>
                        </label>
                        <label>정렬 방향{" "}
                            <select aria-label="정렬 방향" value={direction} onChange={(e) => setDirection(e.target.value as SortDirection)}>
                                <option value="desc">내림차순</option><option value="asc">오름차순</option>
                            </select>
                        </label>
                    </div>
                    <div className="usage-table-scroll" role="region" aria-label="사용량 비교 표" tabIndex={0}>
                        <table data-testid="usage-table">
                            <caption>{groupLabel}별 사용량 · 비율 분모: 이 기간의 입력+출력 {fmt(tokens)} tokens</caption>
                            <thead>
                                <tr>
                                    <th scope="col">{groupLabel}</th><th scope="col">입력</th><th scope="col">출력</th>
                                    <th scope="col">총 token · 비율</th><th scope="col">응답</th>
                                    <th scope="col">세부 token</th><th scope="col">추정 비용</th>
                                </tr>
                            </thead>
                            <tbody>
                                {rows.map((row) => {
                                    const share = tokenShare(totalTokens(row), tokens);
                                    return (
                                        <tr key={row.key}>
                                            <th scope="row">{row.label}</th>
                                            <td>{fmt(row.input_tokens)}</td><td>{fmt(row.output_tokens)}</td>
                                            <td>
                                                {fmt(totalTokens(row))} tokens · {formatShare(share)}
                                                <span className="usage-share-track" aria-hidden="true">
                                                    <span style={{ width: `${(share ?? 0) * 100}%` }} />
                                                </span>
                                            </td>
                                            <td>{fmt(row.responses)}</td>
                                            <td><ReportingDetails row={row} /></td>
                                            <td><CostDetails row={row} /></td>
                                        </tr>
                                    );
                                })}
                            </tbody>
                        </table>
                    </div>
                </>
            )}
        </div>
    );
}
