import { Text as GroveText } from "@astryxdesign/core/Text";
import { useMemo } from "react";
import { artifactDocument } from "../state/artifactPreview";
import { Markdown } from "./Markdown";
import { DetailDialog } from "./ui/Controls";

export function ArtifactPreview({ path, text, dirty }: { path: string; text: string; dirty: boolean }) {
    const html = /\.(html?|svg)$/i.test(path);
    return <DetailDialog className="artifact-preview" data-testid="artifact-preview" label="산출물 미리보기" title={`산출물 미리보기${dirty ? " · 저장 전 편집 사본" : ""}`}>
        <GroveText as="p" display="block" type="supporting" color="secondary">현재 파일 기준입니다. 스크립트·폼·외부 자원·로컬 파일 접근은 실행하지 않습니다.</GroveText>
        <PreviewBody path={path} text={text} html={html} />
    </DetailDialog>;
}

function PreviewBody({ path, text, html }: { path: string; text: string; html: boolean }) {
    const document = useMemo(() => html ? artifactDocument(text) : "", [html, text]);
    return html ? <iframe title={`${path} 산출물 미리보기`} className="artifact-frame" sandbox=""
        referrerPolicy="no-referrer" allow="camera 'none'; microphone 'none'; geolocation 'none'" srcDoc={document} />
        : /\.md$|\.markdown$/i.test(path) ? <Markdown text={text} /> : <pre>{text}</pre>;
}
