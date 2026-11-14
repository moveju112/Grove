import type { ReactNode } from "react";
import { InfoTip } from "@astryxdesign/core/InfoTip";

/** 안내문만 문장 경계에서 나눈다. 사용자 콘텐츠·코드·URL을 임의로 바꾸지 않는다. */
export function SentenceText({ text }: { text: string }) {
    return <span className="sentence-lines">{text.split(/(?<=[.!?。！？])\s+/u).map((sentence, index) => <span key={index}>{sentence}</span>)}</span>;
}

export function HelpTip({ label, children }: { label: string; children: ReactNode }) {
    return <InfoTip label={label} content={children} />;
}
