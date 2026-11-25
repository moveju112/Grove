import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { AccountUsageReport } from "../../api/generated";
import { UsageSummary } from "./SidebarUsage";

const report: AccountUsageReport = { accounts: [
    { protocol: "codex_cli", name: "Codex", status: "available", checked_at: "2026-01-01T00:00:00Z", limits: [
        { label: "5시간", remaining_percent: 82, remaining: null, resets_at: null },
        { label: "주간", remaining_percent: 0, remaining: null, resets_at: null },
        { label: "Spark 5시간", remaining_percent: 45.5, remaining: null, resets_at: null },
        { label: "크레딧", remaining_percent: null, remaining: "12.5", resets_at: null },
    ] },
    { protocol: "claude_code", name: "Claude", status: "available", checked_at: "2026-01-01T00:00:00Z", limits: [
        { label: "5시간", remaining_percent: 95.5, remaining: null, resets_at: null },
        { label: "주간", remaining_percent: 8, remaining: null, resets_at: null },
        { label: "Opus 주간", remaining_percent: 40, remaining: null, resets_at: null },
    ] },
] };

describe("탐색 하단 사용 한도", () => {
    it("Claude·Codex의 5시간·주간 네 한도만 실제 사용률과 게이지로 표시한다", () => {
        const html = renderToStaticMarkup(createElement(UsageSummary, { report }));
        for (const text of ["Claude 5시간", "Claude 주간", "Codex 5시간", "Codex 주간", ">18%<", ">100%<", ">4.5%<", ">92%<",
            'aria-label="Codex 5시간 사용 18%"', 'aria-label="Claude 주간 사용 92%"']) {
            expect(html).toContain(text);
        }
        expect(html).not.toContain("남음");
        for (const text of ["Spark", "Opus", "크레딧", "12.5"]) expect(html).not.toContain(text);
        expect(html).not.toContain("codex_cli");
        expect(html).not.toContain("토큰");
        expect(html.match(/role="progressbar"/g)).toHaveLength(4);
        expect(html).toContain('aria-valuenow="100"');
        expect(html).toContain('aria-valuenow="4.5"');
        expect(html.indexOf("Claude 5시간")).toBeLessThan(html.indexOf("Codex 5시간"));
    });

    it("빈 계정은 숨기고 미지원·조회 제한은 0%로 꾸미지 않는다", () => {
        expect(renderToStaticMarkup(createElement(UsageSummary, { report: { accounts: [] } }))).toBe("");
        const html = renderToStaticMarkup(createElement(UsageSummary, { report: { accounts: [
            { ...report.accounts[1]!, status: "unsupported" },
            { ...report.accounts[0]!, status: "rate_limited", limits: [] },
        ] } }));
        expect(html).toContain("한도 조회 미지원");
        expect(html).toContain("조회 제한");
        expect(html).not.toContain("%");
        expect(html).not.toContain('role="progressbar"');
    });

    it("인증 필요·인증 상태 조회 실패를 한도 미지원과 구분한다", () => {
        for (const [status, text] of [
            ["authentication_required", "인증 필요"],
            ["unavailable", "조회 실패"],
        ] as const) {
            const html = renderToStaticMarkup(createElement(UsageSummary, { report: { accounts: [
                { ...report.accounts[1]!, status, limits: [] },
            ] } }));
            expect(html).toContain(text);
            expect(html).not.toContain("한도 조회 미지원");
            expect(html).not.toContain("%");
            expect(html).not.toContain('role="progressbar"');
        }
    });

    it("인증이 필요한 계정에만 이름이 구분되는 설정 열기 버튼을 표시한다", () => {
        const html = renderToStaticMarkup(createElement(UsageSummary, { onAuthenticate: () => {}, report: { accounts: [
            { ...report.accounts[1]!, status: "authentication_required", limits: [] },
            { ...report.accounts[0]!, status: "unsupported", limits: [] },
        ] } }));
        expect(html).toContain('aria-label="Claude 인증 설정 열기"');
        expect(html).toContain('aria-haspopup="dialog"');
        expect(html).not.toContain('aria-label="Codex 인증 설정 열기"');
        expect(html).toContain("한도 조회 미지원");
    });

    it("리셋 시각이 지난 수치를 새 한도로 오인하지 않게 한다", () => {
        const html = renderToStaticMarkup(createElement(UsageSummary, { failed: true, now: Date.parse("2026-01-02T00:00:00Z"),
            report: { accounts: [{ ...report.accounts[0]!, limits: [
                { label: "5시간", remaining_percent: 15, remaining: null, resets_at: "2026-01-01T00:00:00Z" },
            ] }] } }));
        expect(html).toContain("갱신 대기");
        expect(html).toContain("갱신 실패 · 이전 값");
        expect(html).not.toContain("85%");
        expect(html).not.toContain('role="progressbar"');
    });

    it("모델별 한도를 전체 한도로 대체하지 않고 조금 남은 한도를 100%로 반올림하지 않는다", () => {
        const html = renderToStaticMarkup(createElement(UsageSummary, { report: { accounts: [
            { ...report.accounts[0]!, limits: [
                { label: "5시간", remaining_percent: 0.01, remaining: null, resets_at: null },
                { label: "Spark 주간", remaining_percent: 70, remaining: null, resets_at: null },
            ] },
        ] } }));
        expect(html).toContain("&gt;99.9%");
        expect(html).not.toContain("30%");
        // 요금제에 없는 기간은 이름·줄표 없이 비워 둔다.
        expect(html).not.toContain("Codex 주간");
        expect(html).not.toContain("—");
        expect(html.match(/role="progressbar"/g)).toHaveLength(1);
    });

    it("5시간 한도가 없으면 그 자리를 비우고 주간은 오른쪽 열에 그대로 두며, 높은 사용률도 주의 색을 쓰지 않는다", () => {
        const html = renderToStaticMarkup(createElement(UsageSummary, { report: { accounts: [
            { ...report.accounts[0]!, limits: [{ label: "주간", remaining_percent: 5, remaining: null, resets_at: null }] },
        ] } }));
        expect(html).not.toContain("Codex 5시간");
        expect(html).not.toContain("—");
        expect(html).toContain(">95%<");
        expect(html).not.toContain('data-variant="warning"');
        expect(html.indexOf('aria-hidden="true"')).toBeLessThan(html.indexOf("Codex 주간"));
        expect(html.match(/role="progressbar"/g)).toHaveLength(1);
        // 공용 한도가 하나도 없는 계정은 줄 자체를 만들지 않는다.
        expect(renderToStaticMarkup(createElement(UsageSummary, { report: { accounts: [
            { ...report.accounts[0]!, limits: [{ label: "크레딧", remaining_percent: null, remaining: "12.5", resets_at: null }] },
        ] } }))).toBe("");
    });

    it("쓰기 시작한 한도를 0%로 반올림하지 않는다", () => {
        const html = renderToStaticMarkup(createElement(UsageSummary, { report: { accounts: [
            { ...report.accounts[0]!, limits: [{ label: "5시간", remaining_percent: 99.99, remaining: null, resets_at: null }] },
        ] } }));
        expect(html).toContain("&lt;0.1%");
    });
});
