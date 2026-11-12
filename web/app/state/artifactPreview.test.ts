import { describe, expect, it } from "vitest";
import { isArtifact } from "./artifactPreview";

describe("산출물 파일 분류", () => {
    it("정적 문서·시각 산출물의 확장자만 고른다", () => {
        for (const path of ["out/page.HTML", "diagram.svg", "note.md", "note.markdown", "book.pdf", "readme.txt"]) expect(isArtifact(path)).toBe(true);
        for (const path of ["run.js", "app.exe", "note.md.sh", "image.png", "folder/html"]) expect(isArtifact(path)).toBe(false);
    });
});
