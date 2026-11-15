import { Text, type TextProps } from "@astryxdesign/core/Text";
import { Tooltip } from "@astryxdesign/core/Tooltip";
import { useRef } from "react";

type Props = Omit<TextProps, "ref"> & { hint?: string | null };

/** 텍스트의 native title을 대체하되, 추가 DOM 경계·터치 조작·키보드 동선을 만들지 않는다. */
export function HintText({ hint, type = "inherit", color = "inherit", ...props }: Props) {
    const anchor = useRef<HTMLElement>(null);
    return <>
        <Text {...props} ref={anchor} type={type} color={color} />
        <Tooltip anchorRef={anchor} content={hint ?? ""} isEnabled={Boolean(hint)}
            hasHoverIndication={false} touchTrigger="none" focusTrigger="never" />
    </>;
}
