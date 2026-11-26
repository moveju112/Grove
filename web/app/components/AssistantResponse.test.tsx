import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { AssistantResponse } from "./AssistantResponse";

const render = (text: string, live = true) =>
    renderToStaticMarkup(<AssistantResponse content={{ text }} live={live} />);

describe("스트리밍 답변 Markdown", () => {
    it("시각이 기록돼도 진행 중에는 제목과 설명만 표시한다", () => {
        const html = renderToStaticMarkup(<AssistantResponse live content={{
            response_parts: ["첫 설명", "두 번째 설명", "기록 없는 설명", "답변"],
            response_part_times: ["2026-01-12T01:23:45Z", "2026-01-12T01:24:56Z", null, "2026-01-12T01:25:57Z"],
        }} />);
        expect(html).toMatch(/>진행 설명<\/span>/);
        expect(html).not.toContain("<time");
        expect(html).toContain("기록 없는 설명");
    });

    it("진행 시각 기록이 없으면 제목만 표시한다", () => {
        const html = renderToStaticMarkup(<AssistantResponse live content={{ response_parts: ["설명", "답변"] }} />);
        expect(html).toContain("진행 설명");
        expect(html).not.toContain("· 최근");
        expect(html).not.toContain("<time");
    });

    it("진행 설명을 가려도 답변은 스트리밍한다", () => {
        const html = renderToStaticMarkup(<AssistantResponse live showProgress={false}
            content={{ response_parts: ["파일을 확인할게.", "확인했어."] }} />);
        expect(html).toContain("확인했어.");
        expect(html).not.toContain("진행 설명");
        expect(html).not.toContain("파일을 확인할게.");
    });

    it("완료 전에도 제목·굵게·표·닫히지 않은 코드 블록을 렌더링한다", () => {
        const html = render("# 제목\n\n**강조**\n\n| 항목 | 값 |\n|---|---|\n| 상태 | 수신 중 |\n\n```ts\nconst value = 1;");
        expect(html).toContain("응답 중");
        expect(html).toMatch(/<h3\b[^>]*>제목<\/h3>/);
        expect(html).toContain("<strong>강조</strong>");
        expect(html).toContain("<table");
        expect(html).toContain("수신 중");
        expect(html.replace(/<[^>]+>/g, "")).toContain("const value = 1;");
        expect(html).toContain("복사");
    });

    it("누적 답변의 문법이 완성되면 서식을 반영하고 이후 내용도 유지한다", () => {
        const partial = render("앞부분 **강");
        expect(partial).toContain("앞부분 **강");
        expect(partial).not.toContain("<strong>");

        const formatted = render("앞부분 **강조**");
        expect(formatted).toContain("<strong>강조</strong>");

        const extended = render("앞부분 **강조** 뒷부분");
        expect(extended).toContain("<strong>강조</strong> 뒷부분");
        expect(extended).toContain("응답 중");
    });

    it("스트리밍과 완료 답변에 같은 서식과 HTML 안전 처리를 적용한다", () => {
        const text = "**답변** <script>alert(1)</script> [위험](javascript:alert(1))";
        const live = render(text);
        const completed = render(text, false);
        expect(live.replace("partial-answer", "msg-answer").replace("응답 중", "답변")).toBe(completed);
        expect(live).toContain("<strong>답변</strong>");
        expect(live).toContain("&lt;script&gt;");
        expect(live).not.toContain("<script");
        expect(live).not.toContain('href="javascript:');
    });
});
