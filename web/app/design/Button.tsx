import { Button as AstryxButton, type ButtonVariant, type ButtonProps as AstryxButtonProps } from "@astryxdesign/core/Button";
import { HStack } from "@astryxdesign/core/Stack";
import type { ButtonHTMLAttributes, Ref } from "react";
import * as stylex from "@stylexjs/stylex";

// 앱이 추출한 Astryx atomic CSS보다 테마의 여백 선언이 뒤로 밀리지 않도록 같은 경로에서 합친다.
const styles = stylex.create({
    flush: { paddingBlock: 0, paddingInline: 0 },
});

const APPEARANCE = {
    link: "inline-link",
    icon: "icon",
    navigation: "navigation",
    choice: "choice",
    settings: "settings-menu",
    menu: "menu",
    disclosure: "disclosure",
    send: "send",
} as const;

const DEFAULT_WIDTH: Partial<Record<keyof typeof APPEARANCE, AstryxButtonProps["width"]>> = {
    navigation: "100%", settings: "100%", icon: 32, menu: 32,
};

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
    ref?: Ref<HTMLButtonElement>;
    variant?: ButtonVariant;
    density?: "compact" | "touch";
    appearance?: keyof typeof APPEARANCE;
    xstyle?: AstryxButtonProps["xstyle"];
    width?: AstryxButtonProps["width"];
};

/** 폼 제출·취소·native disabled·ref 계약을 보존하는 Astryx 어댑터. */
export function Button({ children, disabled, type = "submit", ref, variant, density, appearance, width, xstyle, ...props }: ButtonProps) {
    const quiet = appearance !== undefined;
    const iconOnly = appearance === "icon" || appearance === "send";
    const resolvedVariant = appearance ? APPEARANCE[appearance] : variant ?? "primary";
    const native = { disabled };
    return <AstryxButton {...props} {...native} ref={ref} type={type}
        data-grove-button-layout={appearance === "navigation" || appearance === "settings" ? "fill" : undefined}
        xstyle={[(appearance === "link" || appearance === "disclosure") && styles.flush, xstyle]}
        label={props["aria-label"] ?? (typeof children === "string" ? children : "")}
        variant={resolvedVariant} size={density === "touch" ? "lg" : density === "compact" ? "sm" : "md"}
        width={width ?? (appearance ? DEFAULT_WIDTH[appearance] : undefined)} isDisabled={disabled}
        isIconOnly={iconOnly} icon={iconOnly ? children : undefined}>
        {iconOnly ? null : <HStack as="span" data-grove-button-content="" width="100%" gap={2} vAlign="center" hAlign={quiet ? "start" : "center"}>{children}</HStack>}
    </AstryxButton>;
}
