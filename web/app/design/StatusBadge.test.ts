import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { StatusBadge } from "./StatusBadge";

describe("상태 배지", () => {
    it.each([
        ["failed", "error"], ["denied", "error"],
        ["awaiting_approval", "warning"], ["awaiting_input", "warning"],
        ["unknown_result", "warning"], ["unknown", "warning"],
        ["running", "neutral"], ["completed", "neutral"], ["future_status", "neutral"],
    ])("%s의 기존 의미 색을 보존한다", (status, variant) => {
        const html = renderToStaticMarkup(createElement(StatusBadge, { status, children: "현재 상태" }));
        expect(html).toContain(`data-variant="${variant}"`);
        expect(html).toContain("현재 상태");
    });
});
