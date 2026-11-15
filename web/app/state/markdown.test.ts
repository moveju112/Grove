import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { fileRef, parseInline, parseMarkdown, safeHref } from "./markdown";
import { Markdown } from "../components/Markdown";

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
});
