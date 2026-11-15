import { Text as GroveText } from "@astryxdesign/core/Text";
import type { ModelCatalog, ModelProfile } from "../api/generated";
import { api } from "../api/client";
import { useQuery } from "../state/store";
import { useCapability } from "../state/capabilities";

export function useModelCatalog(profile: ModelProfile | undefined, bound = false) {
    const supported = useCapability("turn_model_selection_v1");
    return useQuery<ModelCatalog>(supported === false || bound || !profile?.enabled ? null : `models:${profile.id}:${profile.revision}`,
        () => api.getContract("ModelCatalog", `/model-profiles/${profile!.id}/available-models`, { requires: ["turn_model_selection_v1"], timeoutMs: 35_000 }));
}

export function ModelSelect({ profiles, profileId, model, ready, bound, save, onChange }: {
    profiles: ModelProfile[]; profileId: string | null; model?: string | null;
    ready: boolean; bound: boolean; save: boolean;
    onChange: (profileId: string, model: string | null) => void;
}) {
    const profile = profiles.find((p) => p.id === profileId);
    const current = model ?? profile?.model ?? "default";
    const supported = useCapability("turn_model_selection_v1");
    const catalog = useModelCatalog(profile, bound);
    const choices = profiles.flatMap((p) => [
        { value: p.id, profileId: p.id, model: null as string | null, name: p.model === "default" ? `${p.name} · 기본 모델` : `${p.model} · ${p.name}`, disabled: !p.enabled },
        ...(p.id === profileId ? (catalog.data?.models ?? []).filter((m) => m.id !== p.model).map((m) => ({
            value: JSON.stringify([p.id, m.id]), profileId: p.id, model: m.id,
            name: `${m.name} · ${p.name}`, disabled: !p.enabled,
        })) : []),
    ]);
    const value = save ? "__save__" : model ? JSON.stringify([profileId, model]) : profileId ?? "";
    return <div className="composer-model">
        <select aria-label="모델 프로필" title={profile ? `${current} · ${profile.name}` : "모델 선택"}
            value={value} disabled={!ready || bound} onChange={(event) => {
                if (event.target.value === "__reload__") { catalog.reload(); return; }
                const choice = choices.find((c) => c.value === event.target.value);
                if (choice) onChange(choice.profileId, choice.model);
            }}>
            {save && <option value="__save__" disabled>메시지만 저장</option>}
            {!choices.some((c) => c.value === value) && !save && <option value={value} disabled>{model ?? (profileId ? "선택한 프로필 없음" : "모델 선택")}</option>}
            {choices.map((c) => <option key={c.value} value={c.value} disabled={c.disabled}>{c.name}{c.disabled ? " · 비활성" : ""}</option>)}
            {catalog.loading && <option disabled>모델 목록 조회 중…</option>}
            {!catalog.loading && supported !== false && !bound && profile?.enabled && <option value="__reload__">모델 목록 새로고침</option>}
        </select>
        {catalog.error instanceof Error && <GroveText type="supporting" color="error" role="alert">{catalog.error.message}</GroveText>}
    </div>;
}
