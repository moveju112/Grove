import { Text as GroveText } from "@astryxdesign/core/Text";
import type { ExecSettingDef } from "../../api/execSettings";
import { ScopedSettings, type SettingsTarget } from "../ScopedSettings";
import type { SettingLinkReady } from "../settings-links/reveal";

export function ExecSettings({ defs, target, linkedKey, onLinkReady }: {
    defs: ExecSettingDef[]; target: SettingsTarget; linkedKey?: string; onLinkReady?: SettingLinkReady;
}) {
    return <div data-testid="exec-settings">
        <GroveText as="p" display="block" type="inherit" color="inherit" className="scope">다음 실행 계획부터 적용 · 기존 계획·승인은 유지</GroveText>
        {defs.map((def) => <div key={def.key}>
            <fieldset disabled={Boolean(def.disabled_reason)} style={{ border: 0, padding: 0, margin: 0 }}>
                <ScopedSettings defs={[def]} target={target} linkedKey={linkedKey} onLinkReady={onLinkReady} />
            </fieldset>
            {def.disabled_reason && <GroveText as="p" display="block" type="inherit" color="warning" role="status">{def.disabled_reason}</GroveText>}
            {def.unavailable_options && def.unavailable_options.length > 0 && <fieldset disabled className="setting">
                <legend>{def.label} 미지원 선택지</legend>
                <select aria-label={`${def.label} 미지원 선택지`} disabled>
                    {def.unavailable_options.map((option) => <option key={option.value} value={option.value}>{option.value} · {option.reason}</option>)}
                </select>
            </fieldset>}
            {def.key === "exec.default_cwd" && <GroveText as="p" display="block" type="inherit" color="warning" role="status">
                새 모델 셸·대화 작업에만 적용 · 명시한 cwd 우선 · 실제 실행 root 기준
            </GroveText>}
        </div>)}
        <GroveText as="p" display="block" type="supporting" color="warning">프로세스 트리 격리는 파일·네트워크 sandbox가 아닙니다. 자원 한도 0은 제한 없음입니다.</GroveText>
    </div>;
}
