import { useEffect, useState } from "react";
import { Stack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { TextInput } from "../../design/Fields";
import { Select } from "../../design/Select";
import {
    SHORTCUT_ACTIONS, conflictingShortcut, formatShortcut, macShortcuts, parseShortcut, shortcutBinding,
    type KeyboardShortcuts, type ShortcutAction,
} from "../../state/shortcuts";

export function ShortcutSettings({ value, onChange }: { value: KeyboardShortcuts; onChange: (value: KeyboardShortcuts) => void }) {
    const [mac, setMac] = useState(false);
    const [drafts, setDrafts] = useState<Partial<Record<ShortcutAction, string>>>({});
    const [error, setError] = useState<{ action: ShortcutAction; message: string } | null>(null);
    useEffect(() => { setMac(macShortcuts()); }, []);
    const commit = (action: ShortcutAction) => {
        const text = drafts[action];
        if (text === undefined) return;
        const binding = parseShortcut(text);
        if (binding === undefined) { setError({ action, message: "Ctrl·Alt·Cmd와 키를 +로 이어 입력해줘. 예: Ctrl+Shift+K" }); return; }
        const conflict = binding && conflictingShortcut(value, action, binding, mac);
        if (conflict) { setError({ action, message: `‘${SHORTCUT_ACTIONS.find((item) => item.id === conflict)!.label}’에서 이미 쓰는 조합이야. 먼저 그 항목을 비워줘.` }); return; }
        onChange({ preset: "custom", bindings: { ...value.bindings, [action]: binding } });
        setDrafts((current) => { const next = { ...current }; delete next[action]; return next; });
        setError(null);
    };
    return <Stack gap={3} data-testid="shortcut-settings">
        <Select label="단축키 프리셋" value={value.preset} onChange={(preset) => {
            setDrafts({}); setError(null);
            onChange({ preset: preset as KeyboardShortcuts["preset"], bindings: preset === "default" ? {} : value.bindings });
        }} options={[{ value: "default", label: "기본" }, { value: "custom", label: "사용자 지정" }, { value: "off", label: "사용 안 함" }]} />
        <Text as="p" type="supporting" color="secondary">설치형 PWA에서 동작해. 브라우저·OS가 먼저 처리하는 조합은 사용할 수 없을 수 있어.</Text>
        <Text as="p" type="supporting" color="secondary">Ctrl+Shift+K처럼 입력하고 포커스를 옮기면 저장해. 비우면 해제하고, ‘기본’을 고르면 기본값으로 돌아가. 탭 닫기는 화면만 닫고 작업은 계속해.</Text>
        {SHORTCUT_ACTIONS.map(({ id, label }) => <Stack key={id} gap={1}><TextInput label={`${label} 단축키`} isDisabled={value.preset === "off"} maxLength={64}
            value={drafts[id] ?? formatShortcut(shortcutBinding(value, id), mac)} placeholder="지정 안 함"
            onChange={(text) => { setDrafts((current) => ({ ...current, [id]: text })); setError(null); }}
            onBlur={() => commit(id)}
            onKeyDown={(event) => {
                if (event.key === "Enter" && !event.nativeEvent.isComposing) { event.preventDefault(); event.currentTarget.blur(); }
                if (event.key === "Escape" && drafts[id] !== undefined) {
                    event.preventDefault(); event.stopPropagation();
                    setDrafts((current) => { const next = { ...current }; delete next[id]; return next; });
                    setError(null);
                }
            }} />
            {error?.action === id && <Text as="p" type="supporting" color="warning" role="alert">{error.message}</Text>}
        </Stack>)}
    </Stack>;
}
