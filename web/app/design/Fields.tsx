import { TextInput as AstryxTextInput, type TextInputProps as AstryxTextInputProps } from "@astryxdesign/core/TextInput";
import { TextArea as AstryxTextArea, type TextAreaProps as AstryxTextAreaProps } from "@astryxdesign/core/TextArea";
import { FileInput as AstryxFileInput, type FileInputProps as AstryxFileInputProps } from "@astryxdesign/core/FileInput";
import type { InputHTMLAttributes, TextareaHTMLAttributes } from "react";

type NativeDraftType = "number" | "time" | "datetime-local";
type TextInputProps = Omit<AstryxTextInputProps, "type"> & Pick<InputHTMLAttributes<HTMLInputElement>, "minLength" | "maxLength" | "pattern"> & {
    type?: AstryxTextInputProps["type"] | NativeDraftType;
};
type TextAreaProps = AstryxTextAreaProps & Pick<TextareaHTMLAttributes<HTMLTextAreaElement>, "autoComplete">;
type DraftInputProps = Omit<TextInputProps, "type"> & Pick<InputHTMLAttributes<HTMLInputElement>, "min" | "max" | "step"> & {
    type: NativeDraftType;
};

/** 숫자·시각의 미완성 초안은 앱이 소유한다. blur 때 clamp하거나 값을 확정하지 않는다. */
export function DraftInput({ type, min, max, step, ref, ...props }: DraftInputProps) {
    return <TextInput {...props} type={type} ref={(node) => {
        if (node) {
            for (const [name, value] of Object.entries({ min, max, step })) {
                if (value === undefined) node.removeAttribute(name);
                else node.setAttribute(name, String(value));
            }
        }
        if (typeof ref === "function") return ref(node);
        if (ref) ref.current = node;
    }} />;
}

export function FileInput({ ref, capture, isDisabled = false, ...props }:
    AstryxFileInputProps & Pick<InputHTMLAttributes<HTMLInputElement>, "capture">) {
    return <AstryxFileInput {...props} isDisabled={isDisabled} ref={(node) => {
        if (node) {
            node.disabled = isDisabled;
            if (capture === undefined || capture === false) node.removeAttribute("capture");
            else node.setAttribute("capture", capture === true ? "" : capture);
        }
        if (typeof ref === "function") return ref(node);
        if (ref) ref.current = node;
    }} />;
}

/** Astryx 입력 표면에 기존 폼의 native 차단·길이·패턴 검증을 결합한다. */
export function TextInput({ ref, isDisabled = false, minLength, maxLength, pattern, ...props }: TextInputProps) {
    // Astryx는 type을 native input에 그대로 전달한다. ref에서만 바꾸면 내부 재렌더 때 text로 돌아간다.
    return <AstryxTextInput {...props} type={props.type as AstryxTextInputProps["type"]} aria-label={props["aria-label"] ?? props.label} isDisabled={isDisabled} ref={(node) => {
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
