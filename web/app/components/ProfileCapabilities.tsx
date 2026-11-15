import { Stack as GroveStack } from "@astryxdesign/core/Stack";
import { Select } from "../design/Select";
import { DraftInput } from "../design/Fields";
import { Text as GroveText } from "@astryxdesign/core/Text";
import { Button as GroveButton } from "../design/Button";
import { useState } from "react";
import { api } from "../api/client";
import type { ModelCapabilities, ModelProfile } from "../api/generated";
import { useCapability } from "../state/capabilities";
import { ServerActionButton } from "./pwa/ServerActionButton";
import { HelpTip, SentenceText } from "./HelpTip";

const FEATURES = [
    ["images", "이미지 입력"], ["tools", "Grove 도구 루프"],
    ["effort", "추론"], ["temperature", "temperature"],
] as const;
const status = (value: boolean | null | undefined) => value == null ? "미확인" : value ? "지원" : "미지원";

export function CapabilitySummary({ capabilities: c }: { capabilities?: ModelCapabilities }) {
    return <GroveText type="supporting" color="secondary" data-testid="model-capabilities">
        context {c?.context_tokens ?? "미확인"} · 출력 상한 {c?.max_output_tokens ?? "미확인"} ·{" "}
        {FEATURES.map(([key, label]) => `${label} ${status(c?.[key])}`).join(" · ")} · native PDF {status(c?.pdf)} · fast {status(c?.fast)}
    </GroveText>;
}

type Draft = {
    revision: number; options: Record<string, unknown>; context: string; output: string;
    requested: string; temperature: string; features: Record<typeof FEATURES[number][0], string>;
};

function draft(profile: ModelProfile): Draft {
    const options = profile.options as Record<string, unknown>;
    return {
        revision: profile.revision, options,
        context: String(options.context_window ?? ""), output: String(profile.capabilities?.max_output_tokens ?? ""),
        requested: String(options.max_tokens ?? ""), temperature: String(options.temperature ?? ""),
        features: Object.fromEntries(FEATURES.map(([key]) => [key, profile.capabilities?.[key] == null ? "" : String(profile.capabilities[key])])) as Draft["features"],
    };
}

export function ProfileCapabilities({ profile }: { profile: ModelProfile }) {
    const supported = useCapability("model_capabilities_v1");
    const [editing, setEditing] = useState<Draft | null>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const cli = profile.protocol === "claude_code" || profile.protocol === "codex_cli";
    if (supported === false) return null;
    const save = async () => {
        if (!editing) return;
        setBusy(true);
        setError(null);
        try {
            const options = { ...editing.options };
            const caps: Record<string, unknown> = {};
            for (const [key] of FEATURES) caps[key] = editing.features[key] === "" ? null : editing.features[key] === "true";
            if (editing.output) caps.max_output_tokens = Number(editing.output);
            options.capabilities = caps;
            for (const [key, value] of [
                ["context_window", editing.context], ["max_tokens", editing.requested], ["temperature", editing.temperature],
            ]) {
                if (value) options[key!] = Number(value); else delete options[key!];
            }
            await api.put(`/model-profiles/${profile.id}`, { expected_revision: editing.revision, options }, { requires: ["model_capabilities_v1"] });
            setEditing(null);
        } catch (error) {
            setError(error instanceof Error ? error.message : "모델 기능 저장 실패");
        } finally {
            setBusy(false);
        }
    };
    return <GroveStack gap={0} role="group" aria-label={`${profile.name} 모델 기능`}>
        <CapabilitySummary capabilities={profile.capabilities} />
        {!editing && <GroveButton type="button" variant="secondary" density="compact" onClick={() => { setEditing(draft(profile)); setError(null); }}>모델 기능 설정</GroveButton>}
        {editing && <GroveStack as="form" gap={2} onSubmit={(event) => { event.preventDefault(); void save(); }}>
            <GroveStack direction="horizontal" align="center" gap={1.5}>모델 기능 <HelpTip label="모델 기능 도움말">
                <SentenceText text="소유자가 확인한 값만 입력하세요. Fast는 Codex 모델이 제공한 속도 목록에서 선택합니다. native PDF는 지원하지 않습니다." />
            </HelpTip></GroveStack>
            <DraftInput type="number" min="1" step="1" label="context token 수" value={editing.context} onChange={(value) => setEditing({ ...editing, context: value })} />
            <DraftInput type="number" min="1" max="4294967295" step="1" label="모델 출력 상한" value={editing.output} isDisabled={cli} onChange={(value) => setEditing({ ...editing, output: value })} />
            <DraftInput type="number" min="1" max="4294967295" step="1" label="요청 출력 token 수" value={editing.requested} isDisabled={cli} onChange={(value) => setEditing({ ...editing, requested: value })} />
            <DraftInput type="number" min="0" max="2" step="any" label="요청 temperature" value={editing.temperature} isDisabled={cli} onChange={(value) => setEditing({ ...editing, temperature: value })} />
            {FEATURES.map(([key, label]) => <Select key={key} label={`${label} 지원 여부`}
                value={editing.features[key]} disabled={cli && key !== "effort"}
                onChange={(value) => setEditing({ ...editing, features: { ...editing.features, [key]: value } })}
                options={[{ value: "", label: "미확인" }, { value: "true", label: "지원" }, { value: "false", label: "미지원" }]} />)}
            <GroveStack direction="horizontal" align="center" gap={1.5}>
                <ServerActionButton type="submit" disabled={busy}>{busy ? "저장 중…" : "모델 기능 저장"}</ServerActionButton>
                <GroveButton type="button" variant="secondary" disabled={busy} onClick={() => setEditing(null)}>취소</GroveButton>
                {editing.revision !== profile.revision && <GroveButton type="button" variant="secondary" disabled={busy} onClick={() => { setEditing(draft(profile)); setError(null); }}>현재 서버 값 불러오기</GroveButton>}
            </GroveStack>
            {editing.revision !== profile.revision && <GroveText as="p" display="block" type="inherit" color="warning" role="status">프로필 변경 감지 · 입력 보존 · 저장 시 revision 충돌 확인</GroveText>}
        </GroveStack>}
        {error && <GroveText as="p" display="block" type="inherit" color="error" role="alert">{error}</GroveText>}
    </GroveStack>;
}
