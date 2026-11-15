import { CodeBlock as AstryxCodeBlock, type CodeBlockProps as AstryxCodeBlockProps } from "@astryxdesign/core/CodeBlock";

type Props = Omit<AstryxCodeBlockProps, "code"> & { code?: string | null };

/** 로그·diff는 읽기 전용 원문으로, 추가 조작 없이 같은 높이 안에서 표시한다. */
export function CodeBlock({
    code, hasCopyButton = false, hasLanguageLabel = false, isWrapped = true,
    maxHeight = "24em", width = "100%", size = "sm", ...props
}: Props) {
    return <AstryxCodeBlock {...props} code={code ?? ""} hasCopyButton={hasCopyButton}
        hasLanguageLabel={hasLanguageLabel} isWrapped={isWrapped} maxHeight={maxHeight} width={width} size={size} />;
}
