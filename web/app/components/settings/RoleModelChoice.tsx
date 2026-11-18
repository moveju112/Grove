import { Stack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { useLayoutEffect, useRef } from "react";
import { api } from "../../api/client";
import type { Definition } from "../../api/generated";
import { HelpTip, SentenceText } from "../HelpTip";
import { ProfileChoice, profileChoiceValue, ROLE_DISABLED, useSettingAutosave,
    type SettingDef, type SettingItem } from "../ScopedSettings";
import type { SettingLinkReady } from "../settings-links/reveal";
import { AutosaveStatus } from "./AutosaveStatus";
import { APPLIES } from "./constants";
import { useAutosave } from "./useAutosave";

export function RoleModelChoice({ role, d, settings, linkedKey, onLinkReady }: {
    role: Definition; d: SettingDef; linkedKey?: string; onLinkReady?: SettingLinkReady;
    settings: { data?: { items: SettingItem[] }; error?: unknown; loading: boolean; reload: () => void };
}) {
    const root = useRef<HTMLDivElement>(null);
    const item = settings.data?.items.find((item) => item.key === d.key);
    useLayoutEffect(() => {
        if (linkedKey !== d.key) return;
        if (settings.error) return onLinkReady?.(d.key, null);
        if (!settings.loading && settings.data) onLinkReady?.(d.key, item ? root.current : null);
    }, [linkedKey, d.key, item, settings.data, settings.error, settings.loading, onLinkReady]);
    return <Stack ref={root} gap={1} data-testid={`setting-${d.key}`} data-setting-key={d.key} data-settings-target="서버 전체">
        {item && <RoleModelValue role={role} d={d} item={item} reload={settings.reload} />}
    </Stack>;
}

function RoleModelValue({ role, d, item, reload }: {
    role: Definition; d: SettingDef; item: SettingItem; reload: () => void;
}) {
    const enabled = useAutosave({
        id: `definition-enabled:${role.id}`, value: role.enabled, revision: role.revision,
        save: async (value, revision, key) => {
            const updated = await api.put<Definition>(`/definitions/agent/${role.id}`, { expected_revision: revision, enabled: value }, { key });
            return { value: updated.enabled, revision: updated.revision };
        },
    });
    const enable = () => { enabled.change(true); enabled.commit(); };
    const model = useSettingAutosave({ d, it: item, t: {}, scope: "server", reload,
        onSaved: () => {
            if (!enabled.value) enable();
        },
    });
    const blocked = [model.phase, enabled.phase].some((phase) => phase === "saving" || phase === "uncertain" || phase === "conflict" || phase === "error");
    const saveModel = (value: unknown) => { model.change(value); model.commit(); };
    const choose = (value: unknown) => {
        if (value === ROLE_DISABLED) {
            enabled.change(false); enabled.commit();
        } else if (profileChoiceValue(value) === profileChoiceValue(model.value) && !model.dirty) {
            enable();
        } else {
            saveModel(value);
        }
    };
    return <>
        <Stack direction="horizontal" align="center" wrap="wrap" gap={1}>
            <ProfileChoice d={d} value={model.value} roleEnabled={enabled.value || model.dirty} disabled={blocked}
                edit={choose} onEffortChange={saveModel} />
            <HelpTip label={`모델 선택 도움말: ${d.label}`}>
                <SentenceText text={d.description} />
                <Text type="supporting">모델과 역할의 사용 여부는 서버 전체에 적용해요.</Text>
            </HelpTip>
        </Stack>
        {d.key === "session.title_profile" && !profileChoiceValue(model.value) &&
            <Text type="supporting" color="secondary">모델을 선택하기 전에는 기존 제목이 유지돼요.</Text>}
        <AutosaveStatus state={model} applies={APPLIES[d.applies]} />
        <AutosaveStatus state={enabled} />
    </>;
}
