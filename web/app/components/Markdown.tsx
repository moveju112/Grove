// 모델 답 표시(UI-010·011). 문법 트리를 React 요소로만 그린다: HTML 문자열을 넣지 않으므로 답 안의 <script>·onerror 등은 글자로 보인다.
import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import { fileRef, parseMarkdown, type Block, type Inline } from "../state/markdown";

/// 답 안의 `경로:줄` 참조를 눌렀을 때(UI-011). 없으면 평범한 코드로 보인다.
export const FileRefContext = createContext<((path: string, line?: number) => void) | null>(null);

function InlineCode({ v }: { v: string }) {
    const onRef = useContext(FileRefContext);
    const r = onRef ? fileRef(v) : null;
    if (!r || !onRef) return <code>{v}</code>;
    return (
        <button className="link file-ref" data-testid="file-ref" title="파일 열기" onClick={() => onRef(r.path, r.line)}>
            <code>{v}</code>
        </button>
    );
}

function inl(c: Inline[]): ReactNode[] {
    return c.map((x, k) => {
        switch (x.t) {
            case "text":
                return x.v;
            case "code":
                return <InlineCode key={k} v={x.v} />;
            case "b":
                return <strong key={k}>{inl(x.c)}</strong>;
            case "i":
                return <em key={k}>{inl(x.c)}</em>;
            case "a": {
                // 새 창으로 열고 opener·referrer를 넘기지 않는다. 그럴듯한 문구로 다른 곳을 여는 일을 막기 위해 실제 목적지를 함께 보인다(UI-031).
                const dest = linkDest(x.href);
                return (
                    <a key={k} href={x.href} target="_blank" rel="noopener noreferrer nofollow" title={x.href}>
                        {inl(x.c)}
                        <span className="link-dest" data-testid="link-dest"> ↗ {dest}</span>
                    </a>
                );
            }
            case "br":
                return <br key={k} />;
        }
    });
}

/// 링크 목적지 표시: http(s)는 host, mailto는 주소.
function linkDest(href: string): string {
    if (href.toLowerCase().startsWith("mailto:")) return href.slice(7);
    try {
        return new URL(href).host;
    } catch {
        return href;
    }
}

function CodeBlock({ lang, text }: { lang: string; text: string }) {
    const [copied, setCopied] = useState(false);
    return (
        <div className="md-code" data-testid="md-code">
            <div className="md-code-bar">
                <span className="muted small">{lang || "code"}</span>
                <button
                    className="ghost small"
                    onClick={() =>
                        void navigator.clipboard?.writeText(text).then(
                            () => {
                                setCopied(true);
                                setTimeout(() => setCopied(false), 1500);
                            },
                            () => setCopied(false),
                        )
                    }
                >
                    {copied ? "복사됨" : "복사"}
                </button>
            </div>
            <pre>
                <code>{text}</code>
            </pre>
        </div>
    );
}

function block(b: Block, k: number): ReactNode {
    switch (b.t) {
        case "p":
            return <p key={k}>{inl(b.c)}</p>;
        case "h": {
            const H = `h${Math.min(6, b.level + 2)}` as "h3";
            return <H key={k}>{inl(b.c)}</H>;
        }
        case "code":
            return <CodeBlock key={k} lang={b.lang} text={b.text} />;
        case "ul":
            return (
                <ul key={k}>
                    {b.items.map((it, j) => (
                        <li key={j}>{inl(it)}</li>
                    ))}
                </ul>
            );
        case "ol":
            return (
                <ol key={k}>
                    {b.items.map((it, j) => (
                        <li key={j}>{inl(it)}</li>
                    ))}
                </ol>
            );
        case "quote":
            return <blockquote key={k}>{b.blocks.map(block)}</blockquote>;
        case "table":
            return (
                <div key={k} className="md-table">
                    <table>
                        <thead>
                            <tr>
                                {b.head.map((h, j) => (
                                    <th key={j}>{inl(h)}</th>
                                ))}
                            </tr>
                        </thead>
                        <tbody>
                            {b.rows.map((r, j) => (
                                <tr key={j}>
                                    {r.map((c, n) => (
                                        <td key={n}>{inl(c)}</td>
                                    ))}
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            );
        case "hr":
            return <hr key={k} />;
    }
}

export function Markdown({ text }: { text: string }) {
    const blocks = useMemo(() => parseMarkdown(text), [text]);
    return <div className="text md">{blocks.map(block)}</div>;
}
