import { Stack } from "@astryxdesign/core/Stack";
import { terminalLayout } from "./terminal-layout.stylex";
import { Text as GroveText } from "@astryxdesign/core/Text";
import { Button as GroveButton } from "../../design/Button";
import { AUXILIARY_KEYS, type Modifiers } from "./input";

type Props = {
    modifiers: Modifiers;
    blockedReason?: string | null;
    onToggle: (key: keyof Modifiers) => void;
    onReset: () => void;
    onKey: (data: string) => void;
};

export function TerminalKeys({ modifiers, blockedReason, onToggle, onReset, onKey }: Props) {
    const active = modifiers.ctrl || modifiers.alt;
    return (
        <Stack gap={2} xstyle={terminalLayout.keys}>
            <Stack direction="horizontal" wrap="wrap" gap={1} role="group" aria-label="보조 키"
                onPointerDown={(event) => event.preventDefault()}>
                {(["ctrl", "alt"] as const).map((key) => (
                    <GroveButton key={key} appearance="choice" density="touch"
                        disabled={!!blockedReason} title={blockedReason ?? undefined}
                        aria-pressed={modifiers[key]}
                        onClick={() => onToggle(key)}>{key === "ctrl" ? "Ctrl" : "Alt"}</GroveButton>
                ))}
                {AUXILIARY_KEYS.map(([label, seq]) => (
                    <GroveButton key={label} appearance="choice" density="touch"
                        disabled={!!blockedReason} title={blockedReason ?? undefined}
                        aria-label={label === "↑" ? "위 화살표" : label === "↓" ? "아래 화살표"
                            : label === "←" ? "왼쪽 화살표" : label === "→" ? "오른쪽 화살표" : label}
                        onClick={() => onKey(seq)}>{label}</GroveButton>
                ))}
                {active && <GroveButton appearance="choice" onClick={onReset}>보조키 해제</GroveButton>}
            </Stack>
            <GroveText type="supporting" color="secondary" role="status">
                {active ? `${[modifiers.ctrl && "Ctrl", modifiers.alt && "Alt"].filter(Boolean).join("+")} · 다음 키 한 번에 적용` : "보조키는 다음 키 한 번에 적용"}
            </GroveText>
        </Stack>
    );
}
