import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ExternalEditorControls, type ExternalEditorControlsProps } from "./ExternalEditor";
import { openExternalEditor } from "../../api/externalEditor";
import { api } from "../../api/client";

const props: ExternalEditorControlsProps = {
    listing: { available: true, reason: null, editors: [{ id: "vscode", name: "VS Code" }, { id: "zed", name: "Zed" }] },
    selected: "vscode", disabled: false, busy: false, onSelect: () => {}, onOpen: () => {},
};
const render = (changes: Partial<ExternalEditorControlsProps> = {}) =>
    renderToStaticMarkup(createElement(ExternalEditorControls, { ...props, ...changes }));

describe("외부 편집기", () => {
    it("설치된 목록만 보여 주고 저장되지 않은 내용은 전달하지 않는다고 안내한다", () => {
        const html = render();
        expect(html).toContain("VS Code");
        expect(html).toContain("Zed");
        expect(html).toContain("저장하지 않은 편집은 전달하지 않습니다");
        expect(html).not.toContain("disabled");
    });
    it("PC capability가 없으면 이유만 표시하고 열기 버튼은 숨긴다", () => {
        const html = render({ listing: { available: false, reason: "GUI 없음 <script>", editors: [] } });
        expect(html).toContain("GUI 없음 &lt;script&gt;");
        expect(html).not.toContain("<button");
        expect(html).not.toContain("<select");
    });
    it("실행 중·잠김·목록 밖 선택은 실행할 수 없다", () => {
        for (const changes of [{ busy: true }, { disabled: true }, { selected: "arbitrary" }]) {
            expect(render(changes)).toMatch(/<button[^>]+disabled/);
        }
    });
    it("실행 API는 ID·상대 경로와 같은 요청 키만 보낸다", async () => {
        const post = vi.spyOn(api, "post").mockResolvedValue({ launched: true });
        try {
            await openExternalEditor("p/a", "zed", "한 글;$(literal).txt", "fixed-key");
            expect(post).toHaveBeenCalledWith("/projects/p%2Fa/external-editor",
                { editor_id: "zed", path: "한 글;$(literal).txt" }, { requires: ["external_editor_v1"], key: "fixed-key" });
        } finally { post.mockRestore(); }
    });
});
