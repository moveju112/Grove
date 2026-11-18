import { Stack as GroveStack } from "@astryxdesign/core/Stack";
import { DisabledGroup } from "../../design/DisabledGroup";
import { Text as GroveText } from "@astryxdesign/core/Text";
import type { ExecSettingDef } from "../../api/execSettings";
import { ScopedSettings, type SettingsTarget } from "../ScopedSettings";
import type { SettingLinkReady } from "../settings-links/reveal";

export function ExecSettings({ defs, target, linkedKey, onLinkReady }: {
    defs: ExecSettingDef[]; target: SettingsTarget; linkedKey?: string; onLinkReady?: SettingLinkReady;
}) {
    return <GroveStack gap={0} data-testid="exec-settings">
        <GroveText as="p" display="block" type="supporting" color="secondary">다음 실행부터 적용</GroveText>
        {defs.map((def) => <GroveStack gap={0} key={def.key}>
            <DisabledGroup disabled={Boolean(def.disabled_reason)}>
                <ScopedSettings defs={[def]} target={target} linkedKey={linkedKey} onLinkReady={onLinkReady} />
            </DisabledGroup>
            {def.disabled_reason && <GroveText as="p" display="block" type="inherit" color="warning" role="status">{def.disabled_reason}</GroveText>}
        </GroveStack>)}
        <GroveText as="p" display="block" type="supporting" color="warning">프로세스 트리만 정리하며 파일·네트워크 접근은 제한하지 않아요.</GroveText>
    </GroveStack>;
}
