import { Selector, SelectorOption, type SelectorOptionData, type SelectorProps } from "@astryxdesign/core/Selector";
import { Stack } from "@astryxdesign/core/Stack";
import type { Ref } from "react";

export type SelectProps = Omit<SelectorProps<SelectorOptionData>,
    "ref" | "value" | "onChange" | "isDisabled" | "isLabelHidden" | "hasClear" | "renderOption"> & {
    ref?: Ref<HTMLButtonElement>;
    value: string;
    onChange: (value: string) => void;
    disabled?: boolean;
    hideLabel?: boolean;
};

/** 선택 표면은 Astryx가 소유하고, 실행 차단 시 native disabled 계약도 유지한다. */
export function Select({ ref, value, onChange, disabled = false, hideLabel = false, size = "sm",
    presentation = "popover", ...props }: SelectProps) {
    return <Selector {...props} size={size} presentation={presentation}
        value={value} onChange={onChange} isDisabled={disabled} isLabelHidden={hideLabel}
        data-selected-value={value}
        renderOption={(option) => <Stack data-option-value={option.value}>
            <SelectorOption label={option.label ?? option.value}
                description={option.description} icon={option.icon} />
        </Stack>}
        ref={(node) => {
            if (node) node.disabled = disabled;
            if (typeof ref === "function") return ref(node);
            if (ref) ref.current = node;
        }} />;
}
