import { Stack as GroveStack } from "@astryxdesign/core/Stack";
import { DisabledGroup } from "../../design/DisabledGroup";
import { List, ListItem } from "@astryxdesign/core/List";
import { Text as GroveText } from "@astryxdesign/core/Text";
import type { ExecSettingDef } from "../../api/execSettings";
import { ScopedSettings, type SettingsTarget } from "../ScopedSettings";
import type { SettingLinkReady } from "../settings-links/reveal";

export function ExecSettings({ defs, target, linkedKey, onLinkReady }: {
    defs: ExecSettingDef[]; target: SettingsTarget; linkedKey?: string; onLinkReady?: SettingLinkReady;
}) {
    return <GroveStack gap={0} data-testid="exec-settings">
        <GroveText as="p" display="block" type="supporting" color="secondary">다음 실행 계획부터 적용 · 기존 계획·승인은 유지</GroveText>
        {defs.map((def) => <GroveStack gap={0} key={def.key}>
            <DisabledGroup disabled={Boolean(def.disabled_reason)}>
                <ScopedSettings defs={[def]} target={target} linkedKey={linkedKey} onLinkReady={onLinkReady} />
            </DisabledGroup>
            {def.disabled_reason && <GroveText as="p" display="block" type="inherit" color="warning" role="status">{def.disabled_reason}</GroveText>}
            {def.unavailable_options && def.unavailable_options.length > 0 && <DisabledGroup disabled aria-disabled="true">
                <legend>{def.label} 미지원 선택지</legend>
                <List density="compact" edge="flush">
                    {def.unavailable_options.map((option) => <ListItem key={option.value} label={`${option.value} · ${option.reason}`} />)}
                </List>
            </DisabledGroup>}
            {def.key === "exec.default_cwd" && <GroveText as="p" display="block" type="inherit" color="warning" role="status">
                새 모델 셸·대화 작업에만 적용 · 명시한 cwd 우선 · 실제 실행 root 기준
            </GroveText>}
        </GroveStack>)}
        <GroveText as="p" display="block" type="supporting" color="warning">프로세스 트리 격리는 파일·네트워크 sandbox가 아닙니다. 자원 한도 0은 제한 없음입니다.</GroveText>
    </GroveStack>;
}
