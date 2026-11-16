import { Stack } from "@astryxdesign/core/Stack";
import { Select } from "../design/Select";
import { DraftInput } from "../design/Fields";
import { Text } from "@astryxdesign/core/Text";
import { Button } from "../design/Button";
import { useState } from "react";
import type { ModelCapabilities, ModelProfile } from "../api/generated";
import { useCapability } from "../state/capabilities";
import { HelpTip, SentenceText } from "./HelpTip";
import { useProfileDraft } from "./settings/useProfileDraft";
import { AutosaveStatus } from "./settings/AutosaveStatus";

const FEATURES = [
    ["images", "이미지 입력"], ["tools", "Grove 도구 루프"],
    ["effort", "추론"], ["temperature", "temperature"],
] as const;
const status = (value: boolean | null | undefined) => value == null ? "미확인" : value ? "지원" : "미지원";

export function CapabilitySummary({ capabilities: c }: { capabilities?: ModelCapabilities }) {
    return <Text type="supporting" color="secondary" data-testid="model-capabilities">
        context {c?.context_tokens ?? "미확인"} · 출력 상한 {c?.max_output_tokens ?? "미확인"} ·{" "}
        {FEATURES.map(([key, label]) => `${label} ${status(c?.[key])}`).join(" · ")}
        {c?.native_tools && " · CLI 자체 편집·실행 지원"} · native PDF {status(c?.pdf)} · fast {status(c?.fast)}
    </Text>;
}

function draft(profile: ModelProfile) {
    const options = profile.options as Record<string, unknown>;
    return { options, context: String(options.context_window ?? ""), output: String(profile.capabilities?.max_output_tokens ?? ""),
        requested: String(options.max_tokens ?? ""), temperature: String(options.temperature ?? ""),
        features: Object.fromEntries(FEATURES.map(([key]) => [key, profile.capabilities?.[key] == null ? "" : String(profile.capabilities[key])])) as Record<typeof FEATURES[number][0], string> };
}

export function ProfileCapabilities({ profile }: { profile: ModelProfile }) {
    const supported = useCapability("model_capabilities_v1");
    const [editing, setEditing] = useState(false);
    if (supported === false) return null;
    return <Stack gap={2} role="group" aria-label={`${profile.name} 모델 기능`}>
        <CapabilitySummary capabilities={profile.capabilities} />
        {editing ? <CapabilitiesEditor profile={profile} /> : <Button type="button" variant="secondary" density="compact" onClick={() => setEditing(true)}>모델 기능 설정</Button>}
    </Stack>;
}

function CapabilitiesEditor({ profile }: { profile: ModelProfile }) {
    const cli = profile.protocol === "claude_code" || profile.protocol === "codex_cli";
    const state = useProfileDraft("capabilities", profile, draft, (draft) => {
        const options = { ...draft.options };
        const caps = { ...(options.capabilities as Record<string, unknown> | undefined) };
        for (const [key] of FEATURES) caps[key] = draft.features[key] === "" ? null : draft.features[key] === "true";
        if (draft.output) caps.max_output_tokens = Number(draft.output); else delete caps.max_output_tokens;
        options.capabilities = caps;
        for (const [key, value] of [["context_window", draft.context], ["max_tokens", draft.requested], ["temperature", draft.temperature]] as const) {
            if (value) options[key] = Number(value); else delete options[key];
        }
        return options;
    }, ["model_capabilities_v1"]);
    const value = state.value;
    return <Stack as="form" ref={state.formRef} onInputCapture={state.validate} onSubmit={(event) => event.preventDefault()} gap={2}>
        <Stack direction="horizontal" align="center" gap={1.5}>모델 기능 <HelpTip label="모델 기능 도움말">
            <SentenceText text="소유자가 확인한 값만 입력하세요. Fast는 Codex 모델이 제공한 속도 목록에서 선택합니다. native PDF는 지원하지 않습니다." />
        </HelpTip></Stack>
        <DraftInput type="number" min={1} step={1} label="context token 수" value={value.context} onChange={(context) => state.change({ ...value, context })} onBlur={state.blur} />
        <DraftInput type="number" min={1} max={4294967295} step={1} label="모델 출력 상한" value={value.output} isDisabled={cli} onChange={(output) => state.change({ ...value, output })} onBlur={state.blur} />
        <DraftInput type="number" min={1} max={4294967295} step={1} label="요청 출력 token 수" value={value.requested} isDisabled={cli} onChange={(requested) => state.change({ ...value, requested })} onBlur={state.blur} />
        <DraftInput type="number" min={0} max={2} step="any" label="요청 temperature" value={value.temperature} isDisabled={cli} onChange={(temperature) => state.change({ ...value, temperature })} onBlur={state.blur} />
        {FEATURES.map(([key, label]) => <Select key={key} label={`${label} 지원 여부`} value={value.features[key]} disabled={cli && key !== "effort" && key !== "images"}
            onChange={(next) => { state.change({ ...value, features: { ...value.features, [key]: next } }); state.commit(); }}
            options={[{ value: "", label: "미확인" }, { value: "true", label: "지원" }, { value: "false", label: "미지원" }]} />)}
        <AutosaveStatus state={state} />
    </Stack>;
}
