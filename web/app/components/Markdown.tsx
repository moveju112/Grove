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
import { createContext, memo, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import { fileLink, fileRef, imageFile, parseMarkdown, type Block, type Inline } from "../state/markdown";
import { CreationDialog } from "./create/CreationDialog";
import { FileChangePreview } from "./files/FileChangePreview";
import { ImageAttachment } from "./Attachments";
import { attachmentStyles } from "./attachments.stylex";

/// 답 안의 `경로:줄` 참조를 눌렀을 때(UI-011). 없으면 평범한 코드로 보인다.
export const FileRefContext = createContext<((path: string, line?: number) => void) | null>(null);
export const FileLinkContext = createContext<{ projectId: string; rootPath: string } | null>(null);

function MarkdownImage({ href, alt, inline = true }: { href: string; alt: string; inline?: boolean }) {
    const project = useContext(FileLinkContext);
    const ref = project ? imageFile(href, project.rootPath) : null;
    if (!project || !ref) return alt || "이미지";
    return <ImageAttachment name={alt || ref.path.split("/").pop() || "이미지"} inline={inline}
        projectFile={{ projectId: project.projectId, ...ref }} />;
}

function FileLink({ href, children, testId = "file-link" }: { href: string; children: ReactNode; testId?: string }) {
    const project = useContext(FileLinkContext);
    const open = useContext(FileRefContext);
    const [expanded, setExpanded] = useState(false);
    const ref = project ? fileLink(href, project.rootPath) : null;
    const label = <FileRefContext.Provider value={null}>{children}</FileRefContext.Provider>;
    if (!ref || !project || !open) return label;
    return <>
        <GroveButton appearance="link" xstyle={contentStyles.inlineLink} title={`${ref.path} 변경점`}
            aria-haspopup="dialog" aria-expanded={expanded} data-testid={testId} onClick={() => setExpanded(true)}>{label}</GroveButton>
        {expanded && <CreationDialog label={`${ref.path} 변경점`} onClose={() => setExpanded(false)} width="64em">
            <Stack as="header" direction="horizontal" align="center" justify="between" gap={2}>
                <Heading level={2}>{ref.path} · 현재 변경점</Heading>
                <GroveButton variant="secondary" density="compact" onClick={() => setExpanded(false)}>닫기</GroveButton>
            </Stack>
            <FileChangePreview projectId={project.projectId} path={ref.path}
                onOpen={() => { setExpanded(false); open(ref.path, ref.line); }} />
        </CreationDialog>}
    </>;
}

function InlineCode({ v }: { v: string }) {
    const onRef = useContext(FileRefContext);
    const project = useContext(FileLinkContext);
    const r = onRef ? fileRef(v) : null;
    if (!r || !onRef) return <Code size="inherit">{v}</Code>;
    if (project) return <FileLink href={v} testId="file-ref"><Code size="inherit">{v}</Code></FileLink>;
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
            case "file":
                if (imageFile(x.href)) return <MarkdownImage key={k} href={x.href} alt={inlineLabel(x.c)} />;
                return <FileLink key={k} href={x.href}>{inl(x.c)}</FileLink>;
            case "image":
                return <MarkdownImage key={k} href={x.href} alt={x.alt} />;
            case "br":
                return <br key={k} />;
        }
    });
}

function inlineLabel(nodes: Inline[]): string {
    return nodes.map((node) => node.t === "text" || node.t === "code" ? node.v
        : node.t === "image" ? node.alt : node.t === "br" ? " " : inlineLabel(node.c)).join("");
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
    const diff = lang === "diff" || lang.startsWith("diff-");
    const language = diff ? lang.slice(5) || "plaintext" : lang || "plaintext";
    return <DisplayCodeBlock data-testid="md-code" code={text} language={language} isDiff={diff}
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
        case "p": {
            const content = b.c.filter((node) => node.t !== "br" && !(node.t === "text" && !node.v.trim()));
            if (content.length && content.every((node) => node.t === "image" || (node.t === "file" && imageFile(node.href)))) {
                return <Stack direction="horizontal" gap={2} xstyle={attachmentStyles.strip} role="list" aria-label="답변 이미지"
                    data-swipe-blocked key={k}>{content.map((node, index) => node.t === "image" || node.t === "file"
                        ? <MarkdownImage key={index} href={node.href} alt={node.t === "image" ? node.alt : inlineLabel(node.c)} inline={false} /> : null)}</Stack>;
            }
            return <GroveText as="p" display="block" type="inherit" color="inherit" key={k}>{inl(b.c)}</GroveText>;
        }
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
                <ScrollableArea axis="inline" label="답변 표" maxWidth="100%" key={k} data-testid="md-table">
                    <Table density="compact" xstyle={contentStyles.markdownTable(b.head.length)}>
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

const MarkdownBlock = memo(function MarkdownBlock({ value }: { value: Block }) {
    return block(value, 0);
});

/// 응답이 이어서 도착하면 바뀌지 않은 앞 블록은 이전 객체를 그대로 넘겨 다시 그리지 않는다.
export const Markdown = memo(function Markdown({ text }: { text: string }) {
    const previous = useRef<{ blocks: Block[]; keys: string[] }>({ blocks: [], keys: [] });
    const blocks = useMemo(() => {
        const parsed = parseMarkdown(text);
        const keys = parsed.map((b) => JSON.stringify(b));
        const last = previous.current;
        const stable = parsed.map((b, i) => last.keys[i] === keys[i] ? last.blocks[i]! : b);
        previous.current = { blocks: stable, keys };
        return stable;
    }, [text]);
    return <Stack gap={2} width="100%" maxWidth="100%" xstyle={contentStyles.markdown} data-testid="markdown">
        {blocks.map((b, i) => <MarkdownBlock key={i} value={b} />)}
    </Stack>;
});
