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
        <div className="term-keys" style={{ flexDirection: "column", alignItems: "stretch" }}>
            <div role="group" aria-label="보조 키"
                style={{ display: "flex", flexWrap: "wrap", gap: 4 }}
                onPointerDown={(event) => event.preventDefault()}>
                {(["ctrl", "alt"] as const).map((key) => (
                    <button key={key} className={modifiers[key] ? "chip on" : "chip"}
                        disabled={!!blockedReason} title={blockedReason ?? undefined}
                        style={{ minWidth: 44, minHeight: 44 }} aria-pressed={modifiers[key]}
                        onClick={() => onToggle(key)}>{key === "ctrl" ? "Ctrl" : "Alt"}</button>
                ))}
                {AUXILIARY_KEYS.map(([label, seq]) => (
                    <button key={label} className="chip" style={{ minWidth: 44, minHeight: 44 }}
                        disabled={!!blockedReason} title={blockedReason ?? undefined}
                        aria-label={label === "↑" ? "위 화살표" : label === "↓" ? "아래 화살표"
                            : label === "←" ? "왼쪽 화살표" : label === "→" ? "오른쪽 화살표" : label}
                        onClick={() => onKey(seq)}>{label}</button>
                ))}
                {active && <button className="chip" onClick={onReset}>보조키 해제</button>}
            </div>
            <span className="small muted" role="status">
                {active ? `${[modifiers.ctrl && "Ctrl", modifiers.alt && "Alt"].filter(Boolean).join("+")} · 다음 키 한 번에 적용` : "보조키는 다음 키 한 번에 적용"}
            </span>
        </div>
    );
}
