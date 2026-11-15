import { TextInput as AstryxTextInput, type TextInputProps as AstryxTextInputProps } from "@astryxdesign/core/TextInput";
import { TextArea as AstryxTextArea, type TextAreaProps as AstryxTextAreaProps } from "@astryxdesign/core/TextArea";
import type { InputHTMLAttributes, TextareaHTMLAttributes } from "react";

type TextInputProps = AstryxTextInputProps & Pick<InputHTMLAttributes<HTMLInputElement>, "minLength" | "maxLength" | "pattern">;
type TextAreaProps = AstryxTextAreaProps & Pick<TextareaHTMLAttributes<HTMLTextAreaElement>, "autoComplete">;

/** Astryx 입력 표면에 기존 폼의 native 차단·길이·패턴 검증을 결합한다. */
export function TextInput({ ref, isDisabled = false, minLength, maxLength, pattern, ...props }: TextInputProps) {
    return <AstryxTextInput {...props} aria-label={props["aria-label"] ?? props.label} isDisabled={isDisabled} ref={(node) => {
        if (node) {
            node.disabled = isDisabled;
            node.required = node.getAttribute("aria-required") === "true";
            if (minLength === undefined) node.removeAttribute("minlength");
            else node.minLength = minLength;
            if (maxLength === undefined) node.removeAttribute("maxlength");
            else node.maxLength = maxLength;
            if (pattern === undefined) node.removeAttribute("pattern");
            else node.pattern = pattern;
        }
        if (typeof ref === "function") return ref(node);
        if (ref) ref.current = node;
    }} />;
}

export function TextArea({ ref, isDisabled = false, autoComplete, ...props }: TextAreaProps) {
    return <AstryxTextArea {...props} aria-label={props["aria-label"] ?? props.label} isDisabled={isDisabled} ref={(node) => {
        if (node) {
            node.disabled = isDisabled;
            node.required = node.getAttribute("aria-required") === "true";
            if (autoComplete === undefined) node.removeAttribute("autocomplete");
            else node.setAttribute("autocomplete", autoComplete);
        }
        if (typeof ref === "function") return ref(node);
        if (ref) ref.current = node;
    }} />;
}
