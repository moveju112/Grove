import { describe, expect, it } from "vitest";
import { addedFileDiff } from "./addedFileDiff";

describe("새 파일 diff", () => {
    it("모든 줄을 추가로 표시하고 빈 줄·마지막 개행을 보존한다", () => {
        expect(addedFileDiff("new notes.md", "first\n\nlast\n")).toBe(
            "diff --git a/new notes.md b/new notes.md\nnew file mode 100644\n"
            + "--- /dev/null\n+++ b/new notes.md\n@@ -0,0 +1,3 @@\n+first\n+\n+last\n",
        );
    });

    it("마지막 개행이 없거나 내용이 없는 새 파일도 구분한다", () => {
        expect(addedFileDiff("a.txt", "value")).toContain("+value\n\\ No newline at end of file\n");
        expect(addedFileDiff("empty.txt", "")).toBe("diff --git a/empty.txt b/empty.txt\nnew file mode 100644\n");
        expect(addedFileDiff("newline.txt", "\n")).toContain("@@ -0,0 +1,1 @@\n+\n");
    });
});
