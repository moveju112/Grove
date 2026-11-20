import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { fileLink, fileRef, imageFile, parseInline, parseMarkdown, safeHref } from "./markdown";
import { FileLinkContext, FileRefContext, Markdown } from "../components/Markdown";

const html = (s: string) => renderToStaticMarkup(createElement(Markdown, { text: s }));

describe("markdown", () => {
    it("parses blocks", () => {
        const b = parseMarkdown("# 제목\n\n문단 1\n둘째 줄\n\n- a\n- **b**\n\n1. x\n2. y\n\n```rust\nfn main() {}\n```\n\n> 인용\n\n---");
        expect(b.map((x) => x.t)).toEqual(["h", "p", "ul", "ol", "code", "quote", "hr"]);
        expect(b[1]).toEqual({ t: "p", c: [{ t: "text", v: "문단 1" }, { t: "br" }, { t: "text", v: "둘째 줄" }] });
        expect(b[4]).toEqual({ t: "code", lang: "rust", text: "fn main() {}" });
    });

    it("parses tables and unterminated fences", () => {
        const b = parseMarkdown("| a | b |\n|---|:-:|\n| 1 | `2` |\n\n```\n끝나지 않은 코드");
        expect(b[0]).toMatchObject({ t: "table", head: [[{ t: "text", v: "a" }], [{ t: "text", v: "b" }]] });
        expect((b[0] as { rows: unknown[][] }).rows[0]![1]).toEqual([{ t: "code", v: "2" }]);
        expect(b[1]).toEqual({ t: "code", lang: "", text: "끝나지 않은 코드" });
    });

    it("parses inline", () => {
        expect(parseInline("a **b** *c* `d` [e](https://x.y)")).toEqual([
            { t: "text", v: "a " },
            { t: "b", c: [{ t: "text", v: "b" }] },
            { t: "text", v: " " },
            { t: "i", c: [{ t: "text", v: "c" }] },
            { t: "text", v: " " },
            { t: "code", v: "d" },
            { t: "text", v: " " },
            { t: "a", href: "https://x.y", c: [{ t: "text", v: "e" }] },
        ]);
        // snake_case 안의 _는 기울임이 아니다
        expect(parseInline("file_name_here")).toEqual([{ t: "text", v: "file_name_here" }]);
    });

    // SEC-020: 모델·도구 출력의 HTML·스크립트·위험 URL은 실행되지 않고 글자로 보인다.
    it("never emits raw html or unsafe links", () => {
        expect(safeHref("javascript:alert(1)")).toBeNull();
        expect(safeHref("data:text/html,x")).toBeNull();
        expect(safeHref("https://ok.example/a?b=1")).toBe("https://ok.example/a?b=1");
        const out = html('<script>alert(1)</script> <img src=x onerror=alert(1)> [x](javascript:alert(1)) [y](https://ok.example)');
        expect(out).not.toContain("<script");
        expect(out).not.toContain("<img");
        expect(out).toContain("&lt;script&gt;");
        expect(out).not.toContain('href="javascript');
        expect(out).toContain('href="https://ok.example"');
        expect(out).toContain('rel="noopener noreferrer nofollow"');
    });

    it("detects project file references only", () => {
        expect(fileRef("src/app.ts")).toEqual({ path: "src/app.ts" });
        expect(fileRef("src/app.ts:42")).toEqual({ path: "src/app.ts", line: 42 });
        expect(fileRef("web/app/x.test.ts:3:7")).toEqual({ path: "web/app/x.test.ts", line: 3 });
        expect(fileRef("Cargo.toml")).toEqual({ path: "Cargo.toml" });
        expect(fileRef("dist/a.7z")).toEqual({ path: "dist/a.7z" });
        expect(fileRef("dist/legacy.com")).toEqual({ path: "dist/legacy.com" });
        expect(fileRef("legacy.com:2")).toEqual({ path: "legacy.com", line: 2 });
        for (const no of ["/etc/passwd", "../secret.txt", "a/../b.txt", "https://x.y/a.js", "foo()", "npm run build", "x", "v1.2", "3.14"]) {
            expect(fileRef(no), no).toBeNull();
        }
    });

    it("renders code blocks with a copy button", () => {
        const out = html("```js\nconst a = '<b>';\n```");
        expect(out).toContain("복사");
        expect(out.replace(/<[^>]+>/g, "")).toContain("const a = &#x27;&lt;b&gt;&#x27;;");
        expect(out).not.toContain("<b>");
    });

    it("parses local Markdown links including angle-wrapped paths with spaces", () => {
        expect(parseInline("[구현 코드](/project/src/app.rs:12) · [문서](<docs/my notes.md>)")).toEqual([
            { t: "file", href: "/project/src/app.rs:12", c: [{ t: "text", v: "구현 코드" }] },
            { t: "text", v: " · " },
            { t: "file", href: "docs/my notes.md", c: [{ t: "text", v: "문서" }] },
        ]);
        expect(fileLink("/project/src/app.rs:12:4", "/project/")).toEqual({ path: "src/app.rs", line: 12 });
        expect(fileLink("docs/my%20notes.md", "/project")).toEqual({ path: "docs/my notes.md" });
        expect(fileLink("/my project/docs/note.md", "/my project")).toEqual({ path: "docs/note.md" });
    });

    it("rejects links outside the project and encoded traversal or URL schemes", () => {
        for (const href of ["/etc/passwd", "/project-other/file.rs", "/project", "../secret.txt", "/project/../secret.txt",
            "docs/%2e%2e/secret.txt", "//example.com/file.rs", "javascript:alert(1)", "file:///project/app.rs",
            "data:text/html,x", "src/a.rs?x=1", "src/a.rs#x", "a%00.txt", "a%5cb.txt", "%ZZ", "a.rs:0", "a.rs:9007199254740992",
            "../secret.txt#L1", "docs/%2e%2e/secret.txt#L1", "/project-other/file.rs#L1", "//other/file.rs#L1",
            "a.rs%23L5", "a.rs#L0", "a.rs#L9-L3", "a.rs#L2-L9007199254740992", "a.rs:2#L3", "a.rs#L2#L3"]) {
            expect(fileLink(href, "/project"), href).toBeNull();
        }
    });

    it("renders source citations with GitHub-style line anchors as project file actions", () => {
        expect(fileLink("src/runner.rs#L449")).toEqual({ path: "src/runner.rs", line: 449 });
        expect(fileLink("/project/src/provider/cli.rs#L103-L117", "/project")).toEqual({ path: "src/provider/cli.rs", line: 103 });
        expect(safeHref("https://example.com/src/runner.rs#L449")).toBe("https://example.com/src/runner.rs#L449");
        const text = "[세션 재개 조건](src/runner.rs#L449)과 [프롬프트 구성](src/provider/cli.rs#L103)";
        const out = renderToStaticMarkup(createElement(FileRefContext.Provider, { value: () => undefined },
            createElement(FileLinkContext.Provider, { value: { projectId: "project", rootPath: "/project" } },
                createElement(Markdown, { text }))));
        expect(out.match(/data-testid="file-link"/g)).toHaveLength(2);
        expect(out).toContain("세션 재개 조건");
        expect(out).toContain("프롬프트 구성");
        expect(out).not.toContain("#L449");
        expect(out).not.toContain("#L103");
    });

    it("renders local links as actions only inside the matching project", () => {
        const text = "[구현 코드](/project/src/app.rs:12) · [외부 파일](/other/app.rs) · `grove.choondoggy.com` · [공개 웹](https://grove.choondoggy.com)";
        const out = renderToStaticMarkup(createElement(FileRefContext.Provider, { value: () => undefined },
            createElement(FileLinkContext.Provider, { value: { projectId: "project", rootPath: "/project" } },
                createElement(Markdown, { text }))));
        expect(out.match(/data-testid="file-link"/g)).toHaveLength(1);
        expect(out).toContain('title="src/app.rs 변경점"');
        expect(out).not.toContain('href="/project');
        expect(out).not.toContain('href="/other');
        expect(out).not.toContain('data-testid="file-ref"');
        expect(out).toContain('href="https://grove.choondoggy.com"');
        expect(html(text)).not.toContain('data-testid="file-link"');
    });

    it("parses images without interpreting alt text as HTML or formatting", () => {
        expect(parseInline('![**시안** <img>](/project/dark.png) ![](<light view.WEBP>)')).toEqual([
            { t: "image", href: "/project/dark.png", alt: "**시안** <img>" },
            { t: "text", v: " " },
            { t: "image", href: "light view.WEBP", alt: "" },
        ]);
        expect(parseInline("`![코드](dark.png)`")).toEqual([{ t: "code", v: "![코드](dark.png)" }]);
        for (const href of ["javascript:alert(1)", "data:image/png;base64,x", "../secret.png", "https://example.com/a.png"]) {
            expect(parseInline(`![위험](${href})`).every((node) => node.t === "text")).toBe(true);
        }
    });

    it("uses project boundaries and image MIME types for both image and file links", () => {
        expect(imageFile("/project/previews/dark.PNG", "/project")).toEqual({ path: "previews/dark.PNG", mime: "image/png" });
        expect(imageFile("light%20view.webp", "/project")).toEqual({ path: "light view.webp", mime: "image/webp" });
        for (const href of ["/other/dark.png", "../dark.png", "a.png:2", "a.txt", "a.constructor", "a.__proto__"]) {
            expect(imageFile(href, "/project"), href).toBeNull();
        }
        const text = "![다크 시안](/project/dark.png) [라이트 시안 보기](light.png) ![외부](/other/dark.png)";
        const out = renderToStaticMarkup(createElement(FileLinkContext.Provider,
            { value: { projectId: "project", rootPath: "/project" } }, createElement(Markdown, { text })));
        expect(out.match(/data-testid="markdown-image"/g)).toHaveLength(2);
        expect(out).toContain('aria-label="다크 시안 미리보기"');
        expect(out).toContain('aria-label="라이트 시안 보기 미리보기"');
        expect(out).not.toContain('data-testid="file-link"');
        expect(html(text)).not.toContain('data-testid="markdown-image"');
    });
});
