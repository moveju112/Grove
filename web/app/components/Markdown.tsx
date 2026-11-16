import { Stack } from "@astryxdesign/core/Stack";
import { Heading } from "@astryxdesign/core/Heading";
import { List as GroveList, ListItem as GroveListItem } from "@astryxdesign/core/List";
import { Text as GroveText } from "@astryxdesign/core/Text";
import { Table, TableHeader, TableBody, TableRow, TableHeaderCell, TableCell } from "@astryxdesign/core/Table";
import { Link } from "@astryxdesign/core/Link";
import { Divider } from "@astryxdesign/core/Divider";
import { Code } from "@astryxdesign/core/Code";
import { ScrollableArea } from "@astryxdesign/core/ScrollableArea";
import { contentStyles } from "../design/content.stylex";
import { CodeBlock as DisplayCodeBlock } from "../design/CodeBlock";
// 모델 답 표시(UI-010·011). 문법 트리를 React 요소로만 그린다: HTML 문자열을 넣지 않으므로 답 안의 <script>·onerror 등은 글자로 보인다.
import { Button as GroveButton } from "../design/Button";
import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import { fileRef, parseMarkdown, type Block, type Inline } from "../state/markdown";

/// 답 안의 `경로:줄` 참조를 눌렀을 때(UI-011). 없으면 평범한 코드로 보인다.
export const FileRefContext = createContext<((path: string, line?: number) => void) | null>(null);

function InlineCode({ v }: { v: string }) {
    const onRef = useContext(FileRefContext);
    const r = onRef ? fileRef(v) : null;
    if (!r || !onRef) return <Code size="inherit">{v}</Code>;
    return (
        <GroveButton appearance="link" xstyle={contentStyles.inlineLink} data-testid="file-ref" title="파일 열기" onClick={() => onRef(r.path, r.line)}>
            <Code size="inherit">{v}</Code>
        </GroveButton>
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
                    <Link type="inherit" key={k} href={x.href} target="_blank" rel="noopener noreferrer nofollow" tooltip={x.href}>
                        {inl(x.c)}
                        <GroveText type="supporting" color="inherit" data-testid="link-dest"> ↗ {dest}</GroveText>
                    </Link>
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
    return <DisplayCodeBlock data-testid="md-code" code={text} language={lang || "plaintext"}
        title={lang || "code"} isWrapped={false} endContent={<GroveButton variant="secondary" density="compact"
            onClick={() => void navigator.clipboard?.writeText(text).then(() => {
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
            }, () => setCopied(false))}>
            {copied ? "복사됨" : "복사"}
        </GroveButton>} />;
}

function block(b: Block, k: number): ReactNode {
    switch (b.t) {
        case "p":
            return <GroveText as="p" display="block" type="inherit" color="inherit" key={k}>{inl(b.c)}</GroveText>;
        case "h": {
            const level = Math.min(6, b.level + 2) as 3 | 4 | 5 | 6;
            return <Heading level={level} color="inherit" key={k}>{inl(b.c)}</Heading>;
        }
        case "code":
            return <CodeBlock key={k} lang={b.lang} text={b.text} />;
        case "ul":
            return (
                <GroveList density="compact" edge="flush" listStyle="disc" key={k}>
                    {b.items.map((it, j) => (
                        <GroveListItem key={j} align="first-line" label={inl(it)} />
                    ))}
                </GroveList>
            );
        case "ol":
            return (
                <GroveList density="compact" edge="flush" listStyle="decimal" key={k}>
                    {b.items.map((it, j) => (
                        <GroveListItem key={j} align="first-line" label={inl(it)} />
                    ))}
                </GroveList>
            );
        case "quote":
            return <Stack as="blockquote" gap={2} paddingInlineStart={3} xstyle={contentStyles.quote} key={k}>{b.blocks.map(block)}</Stack>;
        case "table":
            return (
                <ScrollableArea axis="inline" label="답변 표" maxWidth="100%" key={k} data-swipe-blocked="true" data-testid="md-table">
                    <Table density="compact">
                        <TableHeader>
                            <TableRow isHeaderRow>
                                {b.head.map((h, j) => (
                                    <TableHeaderCell scope="col" key={j}>{inl(h)}</TableHeaderCell>
                                ))}
                            </TableRow>
                        </TableHeader>
                        <TableBody>
                            {b.rows.map((r, j) => (
                                <TableRow key={j}>
                                    {r.map((c, n) => (
                                        <TableCell key={n}>{inl(c)}</TableCell>
                                    ))}
                                </TableRow>
                            ))}
                        </TableBody>
                    </Table>
                </ScrollableArea>
            );
        case "hr":
            return <Divider key={k} />;
    }
}

export function Markdown({ text }: { text: string }) {
    const blocks = useMemo(() => parseMarkdown(text), [text]);
    return <Stack gap={2} width="100%" maxWidth="100%" xstyle={contentStyles.markdown} data-testid="markdown">{blocks.map(block)}</Stack>;
}
