import { Children, createElement, isValidElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ApiError } from "../../api/client";
import { SkillEditor, draftMutation, type SkillDraft } from "./SkillEditor";
import { uncertainSkillResult } from "./SessionSkills";

const selection = { id: "skill_safe", source: { kind: "global" as const, root_id: "approved" }, revision: "old-revision" };
const draft: SkillDraft = { kind: "save", selection, text: "<script>not executable</script>" };
type Props = { children?: ReactNode; disabled?: boolean; onClick?: () => void };
function buttons(node: ReactNode): Props[] {
    const found: Props[] = [];
    Children.forEach(node, (child) => {
        if (!isValidElement<Props>(child)) return;
        if (child.type === "button") found.push(child.props);
        found.push(...buttons(child.props.children));
    });
    return found;
}

describe("Grove 스킬 저장과 결과 불명", () => {
    it("편집 시작 binding을 expected revision으로 그대로 전달한다", () => {
        expect(draftMutation(draft)).toEqual({ op: "save", selection, text: draft.text });
        expect(draftMutation({ kind: "add", scope: "project", name: "review", text: "body" }))
            .toEqual({ op: "add", scope: "project", name: "review", text: "body" });
        const sent: unknown[] = [];
        const editor = SkillEditor({ draft, busy: false, onChange: () => {}, onSubmit: (value) => sent.push(value), onCancel: () => {} });
        editor.props.onSubmit({ preventDefault: () => {} });
        expect(sent).toEqual([draftMutation(draft)]);
    });
    it("원문을 이스케이프하고 자동 재선택하지 않는 규칙을 표시한다", () => {
        const html = renderToStaticMarkup(createElement(SkillEditor, {
            draft, busy: false, onChange: () => {}, onSubmit: () => {}, onCancel: () => {},
        }));
        expect(html).toContain("&lt;script&gt;not executable&lt;/script&gt;");
        expect(html).not.toContain("<script>");
        expect(html).toContain("old-revision");
        expect(html).toContain("기존 세션 선택을 갱신하지 않습니다");
        expect(html).toContain("원본 Claude/Codex 정의는 변경하지 않습니다");
    });
    it("pending 중에는 초안 수정·닫기·새 저장을 막는다", () => {
        const sent: unknown[] = [];
        const editor = SkillEditor({ draft, busy: true, onChange: () => {}, onSubmit: (value) => sent.push(value), onCancel: () => {} });
        editor.props.onSubmit({ preventDefault: () => {} });
        expect(sent).toEqual([]);
        expect(buttons(editor).every((button) => button.disabled)).toBe(true);
    });
    it("결과 불명 receipt와 전송 중단은 같은 key로 확인하고 revision 충돌은 새 저장으로 재시도하지 않는다", () => {
        for (const error of [
            new TypeError("response lost"), new ApiError(0, "network", "lost"),
            new ApiError(409, "result_unknown", "interrupted receipt"),
            new ApiError(408, "request_timeout", "timeout"), new ApiError(499, "cancelled", "cancelled"),
            new ApiError(503, "unavailable", "unavailable"),
        ]) expect(uncertainSkillResult(error)).toBe(true);
        for (const error of [
            new ApiError(409, "skill_changed", "conflict"), new ApiError(403, "forbidden", "read only"),
            new ApiError(401, "unauthorized", "expired"),
        ]) expect(uncertainSkillResult(error)).toBe(false);
    });
});
