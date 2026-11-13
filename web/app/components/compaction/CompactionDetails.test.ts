import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../../api/client";
import { requestFocus } from "../../state/focus";
import { CompactionDetails, focusCompactionSource, type CompactionRecord } from "./CompactionDetails";

vi.mock("../../state/focus", () => ({ requestFocus: vi.fn() }));
vi.mock("../ui/Controls", () => ({
    DetailDialog: ({ title, children }: { title: import("react").ReactNode; children: import("react").ReactNode }) => createElement("section", null, title, children),
}));
afterEach(() => vi.restoreAllMocks());

const record: CompactionRecord = {
    summary: "보존된 요약", auto: false, estimated_before: 1500, estimated_after: 15,
    generation: { profile_name: "요약 전용", protocol: "openai", model: "summary-model" },
    pricing: { currency: "USD", version: "2026-09" }, cost_status: "estimated", estimated_cost: 0.000028,
    usage: { input_tokens: 11, output_tokens: 3 }, source: { from_seq: 10, upto_seq: 20, messages: 8 },
};
const render = (r: CompactionRecord) => renderToStaticMarkup(createElement(CompactionDetails, { sessionId: "s", record: r }));

describe("압축 기록", () => {
    it("생성 당시 모델·가격 기준·사용량·추정치를 표시한다", () => {
        const html = render(record);
        for (const text of ["수동", "1500", "15", "요약 전용", "openai", "summary-model", "0.000028 USD", "2026-09", "실제 청구액이 아닙니다", "모델 context를 복원하지 않습니다"]) expect(html).toContain(text);
    });
    it("legacy 기록을 현재 프로필로 보충하지 않는다", () => {
        const html = render({ summary: "과거", auto: true, profile_id: "deleted" });
        expect(html).toContain("생성 당시 모델 정보 미기록");
        expect(html).toContain("가격 기준 미기록");
        expect(html).toContain("원문 범위 미기록");
        expect(html).not.toContain("원문 처음으로");
        expect(html).not.toContain("추정 비용 0");
    });
    it.each([
        { ...record, pricing: null, estimated_cost: null, cost_status: "missing_pricing" as const },
        { ...record, usage: undefined, estimated_cost: null, cost_status: "usage_unreported_or_zero" as const },
        { ...record, usage: { input_tokens: 0, output_tokens: 0 }, estimated_cost: null, cost_status: "usage_unreported_or_zero" as const },
        { ...record, usage: { input_tokens: 0, output_tokens: 3 }, estimated_cost: null, cost_status: "usage_unreported_or_zero" as const },
    ])("가격·사용량 누락을 비용 0으로 꾸미지 않는다", (r) => {
        const html = render(r);
        expect(html).toContain("추정 불가");
        expect(html).not.toContain("추정 비용 0");
    });
    it("명시적인 무료 가격과 가격표 version 누락을 구분한다", () => {
        const html = render({ ...record, estimated_cost: 0, pricing: { currency: "USD" } });
        expect(html).toContain("추정 비용 0 USD");
        expect(html).toContain("version 미기록");
    });
    it("작은 양수 비용을 반올림해 무료로 표시하지 않는다", () => {
        expect(render({ ...record, estimated_cost: 1e-15 })).toContain("추정 비용 0.000000000000001 USD");
    });
    it.each(["first", "last"] as const)("실제로 보존된 %s 메시지를 기존 focus로 보낸다", async (edge) => {
        const get = vi.spyOn(api, "get").mockResolvedValue({ items: [{ seq: edge === "first" ? 13 : 18 }] });
        expect(await focusCompactionSource("s", record.source!, edge)).toBe(true);
        expect(get).toHaveBeenCalledWith(`/sessions/s/messages?limit=1&${edge === "first" ? "after_seq=10" : "before_seq=21"}`);
        expect(requestFocus).toHaveBeenCalledWith("s", edge === "first" ? 13 : 18);
    });
    it.each([{ items: [] }, { items: [{ seq: 21 }] }, { items: [{ seq: 10 }] }])("사라진 범위는 focus를 요청하지 않는다", async ({ items }) => {
        vi.mocked(requestFocus).mockClear();
        vi.spyOn(api, "get").mockResolvedValue({ items });
        expect(await focusCompactionSource("s", record.source!, "first")).toBe(false);
        expect(requestFocus).not.toHaveBeenCalled();
    });
    it("조회 실패를 성공으로 바꾸거나 재시도하지 않는다", async () => {
        const get = vi.spyOn(api, "get").mockRejectedValue(new Error("조회 거절"));
        await expect(focusCompactionSource("s", record.source!, "first")).rejects.toThrow("조회 거절");
        expect(get).toHaveBeenCalledTimes(1);
    });
});
