import { Select } from "../design/Select";

/** 설정의 boolean 값과 명시적 확인을 동일한 드롭다운으로 표시한다. */
export function BooleanSelect({ label, value, onChange, disabled = false, help, hideLabel = false,
    trueLabel = "사용", falseLabel = "사용 안 함" }: {
    label: string; value: boolean; onChange: (value: boolean) => void; disabled?: boolean;
    help?: string; hideLabel?: boolean; trueLabel?: string; falseLabel?: string;
}) {
    return <Select label={label} value={String(value)} disabled={disabled} hideLabel={hideLabel}
        labelTooltip={help} width="100%" onChange={(value) => onChange(value === "true")}
        options={[{ value: "false", label: falseLabel }, { value: "true", label: trueLabel }]} />;
}
