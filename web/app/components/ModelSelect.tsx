import { Stack as GroveStack } from "@astryxdesign/core/Stack";
import { Popover } from "@astryxdesign/core/Popover";
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { DropdownMenu, DropdownMenuItem, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSubMenu } from "@astryxdesign/core/DropdownMenu";
import { Text as GroveText } from "@astryxdesign/core/Text";
import { Button } from "../design/Button";
import { Icon } from "./icons";
import { composerStyles } from "./composer.stylex";
import type { AvailableModel, ModelCatalog, ModelProfile } from "../api/generated";
import { api } from "../api/client";
import { useQuery } from "../state/store";
import { useCapability } from "../state/capabilities";

export function useModelCatalog(profile: ModelProfile | undefined, bound = false) {
    const supported = useCapability("turn_model_selection_v1");
    return useQuery<ModelCatalog>(supported === false || bound || !profile?.enabled ? null : `models:${profile.id}:${profile.revision}`,
        () => api.getContract("ModelCatalog", `/model-profiles/${profile!.id}/available-models`, { requires: ["turn_model_selection_v1"], timeoutMs: 35_000 }));
}

function isAutomatic(profile: ModelProfile | undefined) {
    return profile?.model === "default" && (profile.protocol === "codex_cli" || profile.protocol === "claude_code");
}

function ProfileModels({ profile, profileId, model, onChange }: {
    profile: ModelProfile; profileId: string | null; model?: string | null;
    onChange: (profileId: string, model: string | null) => void;
}) {
    const [expanded, setExpanded] = useState(false);
    const supported = useCapability("turn_model_selection_v1");
    const catalog = useModelCatalog(profile, !expanded);
    const automatic = isAutomatic(profile);
    const cli = profile.protocol === "codex_cli" || profile.protocol === "claude_code";
    const models: AvailableModel[] = (catalog.data?.models ?? []).filter((item) => !cli || item.id !== "default");
    if (!automatic && !models.some((item) => item.id === profile.model)) {
        models.unshift({ id: profile.model, name: profile.model });
    }
    const selected = profileId === profile.id
        ? model ?? (automatic ? models.find((item) => item.is_default)?.id : profile.model)
        : undefined;
    return <DropdownMenuSubMenu label={profile.name} isDisabled={!profile.enabled}
        data-profile-id={profile.id} onOpenChange={setExpanded} hasSpinner={catalog.loading}
        menuDataTestId={`model-profile-models-${profile.id}`}>
        <DropdownMenuRadioGroup label={`${profile.name} 모델`} value={selected}
            onChange={(id) => onChange(profile.id, !automatic && id === profile.model ? null : id)}>
            {models.map((item) => <DropdownMenuRadioItem key={item.id} value={item.id} label={item.name}
                data-option-value={!automatic && item.id === profile.model
                    ? profile.id : JSON.stringify([profile.id, item.id])} />)}
        </DropdownMenuRadioGroup>
        {!catalog.loading && !catalog.error && models.length === 0 && <DropdownMenuItem
            label={supported === false ? "이 서버는 모델 목록 조회를 지원하지 않아요." : "사용 가능한 모델이 없어요."} isDisabled />}
        {catalog.error instanceof Error && <DropdownMenuItem isDisabled
            label={<GroveText type="supporting" color="error" role="alert">{catalog.error.message}</GroveText>} />}
        {supported !== false && <DropdownMenuItem label="모델 목록 새로고침"
            isDisabled={catalog.loading} hasCloseOnSelect={false} onClick={() => catalog.reload()} />}
    </DropdownMenuSubMenu>;
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
    const catalog = useModelCatalog(profile, bound);
    const automatic = isAutomatic(profile);
    const value = save ? "__save__" : model ? JSON.stringify([profileId, model]) : profileId ?? "";
    const selected = catalog.data?.models.find((m) => m.id === (model ?? profile?.model))
        ?? (automatic && !model ? catalog.data?.models.find((m) => m.is_default) : undefined);
    const summary = save ? "메시지만 저장" : selected?.name ?? model
        ?? (automatic ? bound ? profile?.name : "모델 선택" : profile?.model)
        ?? (profileId ? "선택한 프로필 없음" : "모델 선택");
    const detail = save || !profile || automatic && !selected && !model
        ? summary : `${summary} · ${profile.name}`;
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
        <DropdownMenu placement="above" alignment="start"
            renderTrigger={(props) => <Button {...props} type="button" variant="secondary" width="100%"
                aria-label="모델 프로필" data-selected-value={value} data-selected-profile={profileId ?? ""}
                disabled={!ready || bound}>{detail}<Icon name="chevronDown" size={16} /></Button>}>
            {profiles.map((item) => <ProfileModels key={item.id} profile={item} profileId={profileId}
                model={model} onChange={onChange} />)}
        </DropdownMenu>
        {catalog.error instanceof Error && <GroveText type="supporting" color="error" role="alert">{catalog.error.message}</GroveText>}
        {bound && <GroveText type="supporting" color="secondary">모델은 봇 설정에서 변경해요.</GroveText>}
        {children}
            </GroveStack>} />
    </GroveStack>;
}
