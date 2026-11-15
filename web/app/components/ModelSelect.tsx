import { Stack as GroveStack } from "@astryxdesign/core/Stack";
import { Popover } from "@astryxdesign/core/Popover";
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Select } from "../design/Select";
import { Text as GroveText } from "@astryxdesign/core/Text";
import { Button } from "../design/Button";
import { Icon } from "./icons";
import { composerStyles } from "./composer.stylex";
import type { ModelCatalog, ModelProfile } from "../api/generated";
import { api } from "../api/client";
import { useQuery } from "../state/store";
import { useCapability } from "../state/capabilities";

export function useModelCatalog(profile: ModelProfile | undefined, bound = false) {
    const supported = useCapability("turn_model_selection_v1");
    return useQuery<ModelCatalog>(supported === false || bound || !profile?.enabled ? null : `models:${profile.id}:${profile.revision}`,
        () => api.getContract("ModelCatalog", `/model-profiles/${profile!.id}/available-models`, { requires: ["turn_model_selection_v1"], timeoutMs: 35_000 }));
}

export function ModelSelect({ profiles, profileId, model, ready, bound, save, onChange, children, onExpandedChange }: {
    profiles: ModelProfile[]; profileId: string | null; model?: string | null;
    ready: boolean; bound: boolean; save: boolean;
    onChange: (profileId: string, model: string | null) => void;
    children?: ReactNode;
    onExpandedChange: (expanded: boolean) => void;
}) {
    const [open, setOpen] = useState(false);
    const trigger = useRef<HTMLButtonElement>(null!);
    const measurement = useRef<HTMLSpanElement>(null);
    const profile = profiles.find((p) => p.id === profileId);
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
    const selected = catalog.data?.models.find((m) => m.id === (model ?? profile?.model))
        ?? (profile?.model === "default" && !model ? catalog.data?.models.find((m) => m.is_default) : undefined);
    const summary = save ? "메시지만 저장" : selected?.name ?? model
        ?? (profile?.model === "default" ? `${profile.name} · 기본 모델` : profile?.model)
        ?? (profileId ? "선택한 프로필 없음" : "모델 선택");
    // 버튼의 자연 폭으로 판단한다. 두 줄 배치에서도 같은 폭을 재므로 크기 경계에서 왕복하지 않는다.
    useLayoutEffect(() => {
        const probe = measurement.current;
        const bar = probe?.closest<HTMLElement>('[data-testid="composer-bar"]');
        if (!probe || !bar) return;
        const measure = () => {
            const fixed = [...bar.querySelectorAll<HTMLElement>("[data-composer-fixed]")];
            const gap = parseFloat(getComputedStyle(bar).columnGap);
            const available = bar.clientWidth - fixed.reduce((sum, node) => sum + node.getBoundingClientRect().width, 0) - gap * fixed.length;
            onExpandedChange(probe.getBoundingClientRect().width > available);
        };
        const observer = new ResizeObserver(measure);
        observer.observe(bar);
        observer.observe(probe);
        measure();
        return () => observer.disconnect();
    }, [summary, onExpandedChange]);
    return <GroveStack gap={0} width="100%" xstyle={composerStyles.modelControl}>
        <Button ref={trigger} type="button" appearance="disclosure" width="100%" aria-label="모델 설정" title={summary} xstyle={composerStyles.modelTrigger}>
            <GroveText as="span" type="inherit" xstyle={composerStyles.modelName} data-testid="model-summary">{summary}</GroveText>
            <Icon name="chevronDown" size={16} />
            <GroveText as="span" type="inherit" ref={measurement} aria-hidden="true" xstyle={composerStyles.modelMeasurement}>{summary}<Icon name="chevronDown" size={16} /></GroveText>
        </Button>
        <Popover anchorRef={trigger} label="모델 설정" data-testid="model-settings" placement="above" alignment="start"
            presentation="adaptive" width={360} padding={3} isOpen={open} onOpenChange={setOpen}
            content={<GroveStack gap={3}>
                <GroveStack direction="horizontal" align="center" justify="between" gap={2}>
                    <GroveText type="supporting" color="secondary">모델 설정</GroveText>
                    <Button type="button" appearance="icon" aria-label="모델 설정 닫기" onClick={() => setOpen(false)}><Icon name="close" size={16} /></Button>
                </GroveStack>
        <Select label="모델 프로필" width="100%"
            value={value} disabled={!ready || bound} onChange={(value) => {
                if (value === "__reload__") { catalog.reload(); return; }
                const choice = choices.find((c) => c.value === value);
                if (choice) onChange(choice.profileId, choice.model);
            }} options={[
                ...(save ? [{ value: "__save__", label: "메시지만 저장", disabled: true }] : []),
                ...(!choices.some((c) => c.value === value) && !save
                    ? [{ value, label: model ?? (profileId ? "선택한 프로필 없음" : "모델 선택"), disabled: true }] : []),
                ...choices.map((c) => ({ value: c.value, label: `${c.name}${c.disabled ? " · 비활성" : ""}`, disabled: c.disabled })),
                ...(catalog.loading ? [{ value: "__loading__", label: "모델 목록 조회 중…", disabled: true }] : []),
                ...(!catalog.loading && supported !== false && !bound && profile?.enabled
                    ? [{ value: "__reload__", label: "모델 목록 새로고침" }] : []),
            ]} />
        {catalog.error instanceof Error && <GroveText type="supporting" color="error" role="alert">{catalog.error.message}</GroveText>}
        {bound && <GroveText type="supporting" color="secondary">모델은 봇 설정에서 변경해요.</GroveText>}
        {children}
            </GroveStack>} />
    </GroveStack>;
}
