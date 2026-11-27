// 작은 Markdown 파서(UI-010, SEC-020). 결과는 문법 트리이고, 화면은 React 요소로만 그린다(innerHTML 없음 → HTML 삽입 불가).
// 지원: 문단·줄바꿈, 제목, 코드 블록(```·~~~ 3개 이상, 닫힘 없으면 끝까지), 인라인 코드, 굵게·기울임, 외부 링크·프로젝트 파일 링크·이미지,
// 목록(-·*·1.), 인용, 표(| 구분 + 구분선), 구분선. 그 밖의 문법은 글자 그대로 보인다.

export type Inline =
    | { t: "text"; v: string }
    | { t: "code"; v: string }
    | { t: "b"; c: Inline[] }
    | { t: "i"; c: Inline[] }
    | { t: "a"; href: string; c: Inline[] }
    | { t: "file"; href: string; c: Inline[] }
    | { t: "image"; href: string; alt: string }
    | { t: "br" };

export type Block =
    | { t: "p"; c: Inline[] }
    | { t: "h"; level: number; c: Inline[] }
    | { t: "code"; lang: string; text: string }
    | { t: "ul" | "ol"; items: Inline[][] }
    | { t: "quote"; blocks: Block[] }
    | { t: "table"; head: Inline[][]; rows: Inline[][][] }
    | { t: "hr" };

/// 안전한 링크만 허용한다(javascript:·data: 등은 글자로 남긴다).
export function safeHref(u: string): string | null {
    const s = u.trim();
    return /^(https?:\/\/|mailto:)/i.test(s) && !/[\s<>"]/.test(s) ? s : null;
}

export function parseInline(s: string): Inline[] {
    const out: Inline[] = [];
    let buf = "";
    const flush = () => {
        if (buf) out.push({ t: "text", v: buf });
        buf = "";
    };
    let i = 0;
    while (i < s.length) {
        const rest = s.slice(i);
        let m: RegExpMatchArray | null;
        if ((m = rest.match(/^`([^`]+)`/))) {
            flush();
            out.push({ t: "code", v: m[1]! });
        } else if ((m = rest.match(/^\*\*(.+?)\*\*/)) || (m = rest.match(/^__(.+?)__/))) {
            flush();
            out.push({ t: "b", c: parseInline(m[1]!) });
        } else if ((m = rest.match(/^\*([^*\s][^*]*?)\*/)) || (m = rest.match(/^_([^_\s][^_]*?)_(?![A-Za-z0-9])/))) {
            flush();
            out.push({ t: "i", c: parseInline(m[1]!) });
        } else if ((m = rest.match(/^!\[([^\]]*)\]\((?:<([^<>\r\n]+)>|([^\s)]+))\)/))) {
            const target = m[2] ?? m[3]!;
            if (imageFile(target)) {
                flush();
                out.push({ t: "image", href: target, alt: m[1]! });
            } else {
                buf += m[0];
            }
        } else if ((m = rest.match(/^\[([^\]]+)\]\((?:<([^<>\r\n]+)>|([^\s)]+))\)/))) {
            const target = m[2] ?? m[3]!;
            const href = safeHref(target);
            if (href || fileLink(target)) {
                flush();
                out.push({ t: href ? "a" : "file", href: href ?? target, c: parseInline(m[1]!) });
            } else {
                buf += m[0];
            }
        } else {
            buf += s[i];
            i += 1;
            continue;
        }
        i += m[0].length;
    }
    flush();
    return out;
}

const cells = (line: string) =>
    line
        .trim()
        .replace(/^\|/, "")
        .replace(/\|$/, "")
        .split("|")
        .map((c) => parseInline(c.trim()));

// CommonMark 펜스: 같은 문자 3개 이상. 백틱 펜스의 info에는 백틱이 올 수 없고(```a```는 인라인 코드),
// 닫는 줄은 같은 문자로 여는 길이 이상이며 뒤에 공백만 온다.
function fenceOpen(line: string): { fence: string; lang: string } | null {
    const m = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (!m || (m[1]![0] === "`" && m[2]!.includes("`"))) return null;
    return { fence: m[1]!, lang: m[2]!.trim().split(/\s+/)[0]!.replace(/^\{\.?|\}$/g, "") };
}

function fenceClose(line: string, fence: string): boolean {
    const m = line.match(/^ {0,3}(`{3,}|~{3,})\s*$/);
    return !!m && m[1]![0] === fence[0] && m[1]!.length >= fence.length;
}

export function parseMarkdown(src: string): Block[] {
    const lines = src.replace(/\r\n?/g, "\n").split("\n");
    const out: Block[] = [];
    let i = 0;
    while (i < lines.length) {
        const line = lines[i]!;
        let m: RegExpMatchArray | null;
        const open = fenceOpen(line);
        if (open) {
            const body: string[] = [];
            i += 1;
            while (i < lines.length && !fenceClose(lines[i]!, open.fence)) body.push(lines[i++]!);
            i += 1; // 닫는 줄(없으면 끝)
            out.push({ t: "code", lang: open.lang, text: body.join("\n") });
            continue;
        }
        if (!line.trim()) {
            i += 1;
            continue;
        }
        if ((m = line.match(/^(#{1,6})\s+(.*)$/))) {
            out.push({ t: "h", level: m[1]!.length, c: parseInline(m[2]!.replace(/\s+#+\s*$/, "")) });
            i += 1;
            continue;
        }
        if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
            out.push({ t: "hr" });
            i += 1;
            continue;
        }
        if (line.includes("|") && i + 1 < lines.length && /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/.test(lines[i + 1]!)) {
            const head = cells(line);
            const rows: Inline[][][] = [];
            i += 2;
            while (i < lines.length && lines[i]!.includes("|") && lines[i]!.trim()) rows.push(cells(lines[i++]!));
            out.push({ t: "table", head, rows });
            continue;
        }
        if (/^\s*>/.test(line)) {
            const body: string[] = [];
            while (i < lines.length && /^\s*>/.test(lines[i]!)) body.push(lines[i++]!.replace(/^\s*>\s?/, ""));
            out.push({ t: "quote", blocks: parseMarkdown(body.join("\n")) });
            continue;
        }
        const ul = /^\s*[-*+]\s+(.*)$/;
        const ol = /^\s*\d+[.)]\s+(.*)$/;
        if (ul.test(line) || ol.test(line)) {
            const kind = ul.test(line) ? "ul" : "ol";
            const re = kind === "ul" ? ul : ol;
            const items: Inline[][] = [];
            while (i < lines.length && re.test(lines[i]!)) items.push(parseInline(lines[i++]!.match(re)![1]!));
            out.push({ t: kind, items });
            continue;
        }
        // 문단: 빈 줄이나 다른 블록 시작까지. 줄바꿈은 그대로 보인다.
        // 첫 줄은 위 블록 규칙에 걸리지 않았으므로 항상 소비한다(진행 보장).
        const para: string[] = [lines[i++]!];
        while (
            i < lines.length &&
            lines[i]!.trim() &&
            !fenceOpen(lines[i]!) &&
            !/^#{1,6}\s/.test(lines[i]!) &&
            !/^\s*>/.test(lines[i]!) &&
            !ul.test(lines[i]!) &&
            !ol.test(lines[i]!)
        )
            para.push(lines[i++]!);
        const c: Inline[] = [];
        para.forEach((p, k) => {
            if (k > 0) c.push({ t: "br" });
            c.push(...parseInline(p));
        });
        out.push({ t: "p", c });
    }
    return out;
}

/// 인라인 코드가 프로젝트 파일 참조(`src/app.ts`, `src/app.ts:42`, `src/app.ts:42:7`)인가(UI-011).
/// 상대 경로만 받는다: 절대 경로·URL·`..`·공백은 링크로 만들지 않는다(서버도 프로젝트 경계를 다시 검사한다).
export function fileRef(code: string): { path: string; line?: number } | null {
    const m = code.trim().match(/^((?:[\w.@-]+\/)*[\w@-][\w.@-]*\.(?=[A-Za-z0-9]{0,9}[A-Za-z])[A-Za-z0-9]{1,10})(?::(\d+)(?::\d+)?)?$/);
    if (!m) return null;
    const path = m[1]!;
    if (path.split("/").some((p) => p === ".." || p === ".")) return null;
    // 파일명만으로는 어느 폴더를 가리키는지 알 수 없다. 명시한 Markdown 링크는 fileLink에서 처리한다.
    if (!m[2] && !path.includes("/")) return null;
    return m[2] ? { path, line: Number(m[2]) } : { path };
}

// 이미지도 기존 프로젝트 파일 경계를 사용한다. URL·data:·상위 경로는 파일 API로 보내지 않는다.
export function imageFile(href: string, rootPath?: string): { path: string; mime: string } | null {
    const ref = fileLink(href, rootPath);
    if (!ref || ref.line) return null;
    const ext = ref.path.split(".").pop()?.toLowerCase();
    const mime = ({ png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp",
        svg: "image/svg+xml", bmp: "image/bmp", ico: "image/x-icon", avif: "image/avif" } as Record<string, string>)[ext ?? ""];
    return typeof mime === "string" ? { path: ref.path, mime } : null;
}

/// Markdown 파일 링크. 절대 경로는 표시할 프로젝트 루트에 속할 때만 상대 경로로 바꾼다.
/// 브라우저 URL로 이동시키지 않으며 서버의 파일·Git API가 권한과 경계를 다시 검사한다.
export function fileLink(href: string, rootPath?: string): { path: string; line?: number } | null {
    // 소스 인용에서 쓰는 #L12, #L12-L18도 기존 단일 줄 열기에 연결한다.
    const fragment = href.match(/#L(\d+)(?:-L(\d+))?$/);
    const start = fragment ? Number(fragment[1]) : undefined;
    const end = fragment?.[2] ? Number(fragment[2]) : undefined;
    if (start !== undefined && (!Number.isSafeInteger(start) || start < 1 || (end !== undefined && (!Number.isSafeInteger(end) || end < start)))) return null;
    let value: string;
    try { value = decodeURIComponent(fragment ? href.slice(0, fragment.index) : href); } catch { return null; }
    if (!value || /[\x00-\x1f\x7f\\<>?#]/.test(value) || value.startsWith("//")) return null;
    const match = value.match(/^(.*?)(?::(\d+)(?::\d+)?)?$/);
    if (!match || (fragment && match[2])) return null;
    let path = match[1]!;
    if (path.includes(":")) return null;
    if (path.startsWith("/") && rootPath !== undefined) {
        const root = rootPath.replace(/\/+$/, "") + "/";
        if (!path.startsWith(root)) return null;
        path = path.slice(root.length);
    }
    const parts = path.replace(/^\//, "").split("/");
    if (parts.some((part) => !part || part === "." || part === "..") || path.startsWith("-")) return null;
    const line = match[2] ? Number(match[2]) : start;
    if (line !== undefined && (!Number.isSafeInteger(line) || line < 1)) return null;
    return { path, ...(line === undefined ? {} : { line }) };
}
