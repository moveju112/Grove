import * as stylex from "@stylexjs/stylex";
import { useLayoutEffect, useRef, type HTMLAttributes } from "react";
import { TextArea } from "../design/Fields";
import { composerStyles } from "./composer.stylex";
import { useComposerAutosize } from "./useComposerAutosize";

type Shared = Pick<HTMLAttributes<HTMLElement>, "aria-autocomplete" | "aria-controls" | "aria-activedescendant"
    | "onBlur" | "onFocus" | "onKeyDown" | "onCompositionStart" | "onCompositionEnd" | "enterKeyHint">;
type Props = Shared & {
    value: string;
    onChange: (value: string) => void;
    onFiles: (files: File[]) => void;
    placeholder: string;
    isDisabled: boolean;
};

const label = "메시지 입력";

export function ComposerInput(props: Props) {
    // Android 브라우저는 서식 있는 편집 요소에서만 키보드에 이미지 MIME을 알린다.
    return /Android/.test(navigator.userAgent) ? <AndroidInput {...props} /> : <PlainInput {...props} />;
}

function PlainInput({ onFiles, ...props }: Props) {
    const input = useComposerAutosize();
    return <TextArea {...props} label={label} isLabelHidden rows={1} ref={input}
        data-composer-input controlXstyle={composerStyles.inputControl}
        onDragOver={(e) => { if (e.dataTransfer.types.includes("Files")) e.preventDefault(); }}
        onDrop={(e) => { if (e.dataTransfer.files.length) { e.preventDefault(); onFiles(Array.from(e.dataTransfer.files)); } }}
        onPaste={(e) => { if (e.clipboardData.files.length) { e.preventDefault(); onFiles(Array.from(e.clipboardData.files)); } }} />;
}

function AndroidInput({ onFiles, value, onChange, isDisabled, placeholder, ...props }: Props) {
    const input = useRef<HTMLDivElement>(null);
    const domValue = useRef<string | null>(null);
    useLayoutEffect(() => {
        // 브라우저가 입력한 DOM을 다시 쓰지 않아 조합 상태, 선택 영역과 실행 취소를 보존한다.
        if (domValue.current === value) return;
        input.current!.textContent = value;
        domValue.current = value;
    }, [value]);

    return <div {...props} {...stylex.props(composerStyles.inputControl, composerStyles.androidInput)}
        ref={input} data-composer-input data-placeholder={value ? undefined : placeholder}
        role="textbox" aria-label={label} aria-multiline="true" aria-placeholder={placeholder}
        aria-disabled={isDisabled || undefined} tabIndex={isDisabled ? -1 : 0} contentEditable={!isDisabled}
        onInput={(e) => {
            if (isDisabled) return;
            const text = e.currentTarget.innerText;
            domValue.current = text;
            onChange(text);
        }}
        onPaste={(e) => {
            // 이미지와 파일은 첨부로, 글은 서식 없는 본문으로만 넣는다.
            e.preventDefault();
            if (isDisabled) return;
            const { files } = e.clipboardData;
            if (files.length) onFiles(Array.from(files));
            else {
                const text = e.clipboardData.getData("text/plain");
                // 브라우저의 선택 영역과 실행 취소 이력을 사용한다.
                if (text) document.execCommand("insertText", false, text);
            }
        }}
        onDragOver={(e) => { if (e.dataTransfer.types.includes("Files")) e.preventDefault(); }}
        onDrop={(e) => {
            e.preventDefault();
            if (!isDisabled && e.dataTransfer.files.length) onFiles(Array.from(e.dataTransfer.files));
        }} />;
}
