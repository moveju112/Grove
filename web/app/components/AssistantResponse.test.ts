import { describe, expect, it } from "vitest";
import { splitResponse } from "./AssistantResponse";

describe("진행 설명의 응답 경계", () => {
    it("여러 문단을 한 설명으로 유지하고 최종 답변은 번호에서 제외한다", () => {
        const parts = ["첫 설명\n\n같은 설명의 두 번째 문단", "두 번째 설명", "세 번째 설명", "네 번째 설명", "최종 답변"];
        expect(splitResponse({ text: parts.join("\n\n"), response_parts: parts })).toEqual({
            progress: parts.slice(0, 4), answer: "최종 답변",
        });
    });
    it("도구 호출 중인 개별 설명도 합치지 않는다", () => {
        expect(splitResponse({ text: "첫 설명\n\n두 번째 설명", response_parts: ["첫 설명", "두 번째 설명"], tool_calls: [{}] })).toEqual({
            progress: ["첫 설명", "두 번째 설명"], answer: "",
        });
    });
    it("작업을 기다리는 동안의 설명도 모두 유지한다", () => {
        expect(splitResponse({ text: "첫 설명\n\n두 번째 설명", response_parts: ["첫 설명", "두 번째 설명"], pending_work: {} })).toEqual({
            progress: ["첫 설명", "두 번째 설명"], answer: "",
        });
    });
    it("빈 응답은 번호를 만들지 않고 같은 문구의 별도 응답은 합치지 않는다", () => {
        expect(splitResponse({ response_parts: ["반복 확인", "", " \n", "반복 확인", "답변"] })).toEqual({
            progress: ["반복 확인", "반복 확인"], answer: "답변",
        });
    });
    it("경계가 없는 예전 설명은 문단을 임의로 나누지 않는다", () => {
        const text = "첫 문단\n\n두 번째 문단";
        expect(splitResponse({ text, tool_calls: [{}] })).toEqual({ progress: [text], answer: "" });
    });
    it("설명이 없는 일반 답변은 그대로 유지한다", () => {
        expect(splitResponse({ text: "일반 답변" })).toEqual({ progress: [], answer: "일반 답변" });
        expect(splitResponse({ response_parts: ["단일 답변"] })).toEqual({ progress: [], answer: "단일 답변" });
        expect(splitResponse({})).toEqual({ progress: [], answer: "" });
    });
});
