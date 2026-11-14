import { Button as AstryxButton } from "@astryxdesign/core/Button";
import { HStack } from "@astryxdesign/core/Stack";
import type { ButtonHTMLAttributes, Ref } from "react";

/** 폼 제출·취소·native disabled·ref 계약을 보존하는 Astryx 어댑터. */
export function Button({ children, className = "", disabled, type = "submit", ref, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { ref?: Ref<HTMLButtonElement> }) {
    const quiet = /(?:^|\s)(?:link|icon-btn|side-item|chip|settings-menu-item|menu-trigger|detail-trigger)(?:\s|$)/.test(className);
    const secondary = /(?:^|\s)ghost(?:\s|$)/.test(className);
    const native = { disabled };
    return <AstryxButton {...props} {...native} ref={ref} type={type}
        label={props["aria-label"] ?? (typeof children === "string" ? children : "")}
        variant={quiet ? "ghost" : secondary ? "secondary" : "primary"}
        size={className.includes("small") ? "sm" : "md"}
        className={`grove-button ${className}`} isDisabled={disabled}>
        <HStack as="span" gap={2} vAlign="center" hAlign={quiet ? "start" : "center"}>{children}</HStack>
    </AstryxButton>;
}
