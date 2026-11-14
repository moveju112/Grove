import type { ReactNode } from "react";
import { InfoTip } from "@astryxdesign/core/InfoTip";

/** 앱 안내문만 문장 단위로 나눈다. 코드·URL·사용자 콘텐츠에는 적용하지 않는다. */
export function SentenceText({ text }: { text: string }) {
    return <span className="sentence-lines">{text.split(/(?<=[.!?。！？])\s+/u).map((sentence, index) => <span key={index}>{sentence}</span>)}</span>;
}

export function HelpTip({ label, children }: { label: string; children: ReactNode }) {
    return <InfoTip label={label} content={children} />;
}
