import { Stack as GroveStack } from "@astryxdesign/core/Stack";
import { Text as GroveText } from "@astryxdesign/core/Text";
import type { ReactNode } from "react";
import { InfoTip } from "@astryxdesign/core/InfoTip";

/** 앱 안내문만 문장 단위로 나눈다. 코드·URL·사용자 콘텐츠에는 적용하지 않는다. */
export function SentenceText({ text }: { text: string }) {
    return <GroveText type="inherit" color="inherit">{text.split(/(?<=[.!?。！？])\s+/u).map((sentence, index) => <GroveText type="inherit" color="inherit" display="block" key={index}>{sentence}</GroveText>)}</GroveText>;
}

export function HelpTip({ label, children }: { label: string; children: ReactNode }) {
    return <InfoTip label={label} content={<GroveStack gap={0}>{children}</GroveStack>} />;
}
