// 작은 Markdown 파서(UI-010, SEC-020). 결과는 문법 트리이고, 화면은 React 요소로만 그린다(innerHTML 없음 → HTML 삽입 불가).
// 지원: 문단·줄바꿈, 제목, 코드 블록(``` 닫힘 없으면 끝까지), 인라인 코드, 굵게·기울임, 링크(http·https·mailto만),
// 목록(-·*·1.), 인용, 표(| 구분 + 구분선), 구분선. 그 밖의 문법은 글자 그대로 보인다.

export type Inline =
    | { t: "text"; v: string }
    | { t: "code"; v: string }
    | { t: "b"; c: Inline[] }
    | { t: "i"; c: Inline[] }
    | { t: "a"; href: string; c: Inline[] }
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
        } else if ((m = rest.match(/^\[([^\]]+)\]\(([^)\s]+)\)/))) {
            const href = safeHref(m[2]!);
            if (href) {
                flush();
                out.push({ t: "a", href, c: parseInline(m[1]!) });
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

export function parseMarkdown(src: string): Block[] {
    const lines = src.replace(/\r\n?/g, "\n").split("\n");
    const out: Block[] = [];
    let i = 0;
    while (i < lines.length) {
        const line = lines[i]!;
        let m: RegExpMatchArray | null;
        if ((m = line.match(/^\s*(```|~~~)\s*([\w+-]*)\s*$/))) {
            const fence = m[1]!;
            const body: string[] = [];
            i += 1;
            while (i < lines.length && !lines[i]!.trim().startsWith(fence)) body.push(lines[i++]!);
            i += 1; // 닫는 줄(없으면 끝)
            out.push({ t: "code", lang: m[2] ?? "", text: body.join("\n") });
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
        const para: string[] = [];
        while (
            i < lines.length &&
            lines[i]!.trim() &&
            !/^\s*(```|~~~)/.test(lines[i]!) &&
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
    return m[2] ? { path, line: Number(m[2]) } : { path };
}
