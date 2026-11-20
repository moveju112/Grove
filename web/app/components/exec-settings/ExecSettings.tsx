import { Stack as GroveStack } from "@astryxdesign/core/Stack";
import { Text as GroveText } from "@astryxdesign/core/Text";
import { ScopedSettings, type SettingDef, type SettingsTarget } from "../ScopedSettings";
import type { SettingLinkReady } from "../settings-links/reveal";

export function ExecSettings({ defs, target, linkedKey, onLinkReady }: {
    defs: SettingDef[]; target: SettingsTarget; linkedKey?: string; onLinkReady?: SettingLinkReady;
}) {
    return <GroveStack gap={0} data-testid="exec-settings">
        <GroveText as="p" display="block" type="supporting" color="secondary">다음 실행부터 적용</GroveText>
        <ScopedSettings defs={defs} target={target} linkedKey={linkedKey} onLinkReady={onLinkReady} />
        <GroveText as="p" display="block" type="supporting" color="warning">프로세스 트리만 정리하며 파일·네트워크 접근은 제한하지 않아요.</GroveText>
    </GroveStack>;
}
