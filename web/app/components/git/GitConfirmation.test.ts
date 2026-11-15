import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { GitConfirmation } from "./GitConfirmation";
import { confirmationBody, type GitReview } from "./types";

const review: GitReview = {
    action: { operation: "discard", paths: ["선택한 파일.txt"] },
    paths: ["선택한 파일.txt"],
    summary: "선택한 파일.txt | 2 +-\nindex 변경도 버림",
    expected_fingerprint: "reviewed-state",
};

function render(data = review) {
    return renderToStaticMarkup(createElement(GitConfirmation, {
        projectId: "project-reviewed", review: data, onCancel: () => {}, onConfirm: () => {},
    }));
}

describe("Git 명시적 확인", () => {
    it("discard 대상·요약·index 영향·untracked 보존과 취소를 보여 준다", () => {
        const html = render();
        for (const text of ["<dialog", 'aria-label="파일 변경 버리기 확인"', "취소", "선택한 파일.txt", "index 변경도 버림",
            "project-reviewed", "index·작업 트리", "untracked 파일은 삭제하지 않습니다", "확인하고 변경 버리기", "상태가 바뀌면 실행하지 않습니다"]) {
            expect(html).toContain(text);
        }
    });

    it("pop의 정확한 OID·경로·충돌 보존·성공 시 삭제를 보여 준다", () => {
        const html = render({ ...review, action: { operation: "stash_pop", stash_oid: "selected-stash-oid" } });
        for (const text of ["selected-stash-oid", "선택한 파일.txt", "성공하면 목록에서 삭제", "stash를 보존", "자동으로 되돌리지 않습니다", "확인하고 stash pop"]) {
            expect(html).toContain(text);
        }
    });

    it("확인된 action과 fingerprint만 실행 요청에 유지한다", () => {
        expect(confirmationBody(review)).toEqual({
            action: { operation: "discard", paths: ["선택한 파일.txt"] },
            expected_fingerprint: "reviewed-state",
            confirmed: true,
        });
    });

    it("파일명과 요약을 HTML로 실행하지 않는다", () => {
        const html = render({ ...review, paths: ["<script>bad()</script>"], summary: "<img src=x onerror=bad()>" });
        expect(html).not.toContain("<script>");
        expect(html).not.toContain("<img");
        expect(html).toContain("&lt;script&gt;");
    });
});
