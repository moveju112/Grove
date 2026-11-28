import { Stack as GroveStack } from "@astryxdesign/core/Stack";
import { usePopover } from "@astryxdesign/core/Popover";
import { useCallback, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuDivider, DropdownMenuItem, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSubMenu } from "@astryxdesign/core/DropdownMenu";
import { Text as GroveText } from "@astryxdesign/core/Text";
import { Button } from "../design/Button";
import { Icon } from "./icons";
import { composerStyles } from "./composer.stylex";
import type { AvailableModel, ModelCatalog, ModelFavorite, ModelProfile } from "../api/generated";
import { api } from "../api/client";
import { useQuery } from "../state/store";
import { useCapability } from "../state/capabilities";
import { loadPrefs, savePrefs, usePrefs } from "../state/device";
import { latestModels, prefetchProfiles, readRecentProfiles, rememberRecentProfile, sortModels } from "./model-catalog";
import type { SendOptions } from "../state/sendOptions";
import { FavoriteChips, FavoriteStar, useModelFavorites } from "./ModelFavorites";
import { providerIcon } from "./usage/ProviderMark";

export function useModelCatalog(profile: ModelProfile | undefined, bound = false) {
    const supported = useCapability("turn_model_selection_v1");
    return useQuery<ModelCatalog>(supported === false || bound || !profile?.enabled ? null : `models:${profile.id}:${profile.revision}`,
        () => api.getContract("ModelCatalog", `/model-profiles/${profile!.id}/available-models`, { requires: ["turn_model_selection_v1"], timeoutMs: 35_000 }));
}

/// 모델 설정을 여는 동안 하위 메뉴와 같은 cache key로 목록을 미리 받아 둔다.
function CatalogPrefetch({ profile }: { profile: ModelProfile }) {
    useModelCatalog(profile);
    return null;
}

function isAutomatic(profile: ModelProfile | undefined) {
    return profile?.model === "default" && ["codex_oauth", "codex_cli", "claude_code"].includes(profile.protocol);
}

type ProfileModelChoice = {
    profileId: string | null; model?: string | null; includeDefault?: boolean;
    onChange: (profileId: string, model: string | null) => void;
};

export function ProfileModelMenus({ profiles, ...choice }: ProfileModelChoice & { profiles: ModelProfile[] }) {
    const [menus, setMenus] = useState<{ open: string | null; versions: Record<string, number> }>({ open: null, versions: {} });
    const onOpenChange = (id: string, expanded: boolean) => setMenus((current) => {
        const previous = current.open;
        if (!expanded) return previous === id ? { ...current, open: null } : current;
        if (previous === id) return current;
        // Astryx 하위 메뉴는 자체적으로 열리므로 이전 메뉴만 다시 마운트해 닫는다.
        const versions = previous === null ? current.versions
            : { ...current.versions, [previous]: (current.versions[previous] ?? 0) + 1 };
        return { open: id, versions };
    });
    return profiles.map((profile) => <ProfileModels key={`${profile.id}:${menus.versions[profile.id] ?? 0}`}
        profile={profile} {...choice} expanded={menus.open === profile.id}
        onOpenChange={(expanded) => onOpenChange(profile.id, expanded)} />);
}

function ProfileModels({ profile, profileId, model, onChange, includeDefault = false, expanded, onOpenChange }: ProfileModelChoice & {
    profile: ModelProfile; expanded: boolean; onOpenChange: (expanded: boolean) => void;
}) {
    const { showAllModels } = usePrefs();
    const supported = useCapability("turn_model_selection_v1");
    const catalog = useModelCatalog(profile, !expanded);
    const automatic = isAutomatic(profile);
    const accountModel = ["codex_oauth", "codex_cli", "claude_code"].includes(profile.protocol);
    const models: AvailableModel[] = (catalog.data?.models ?? []).filter((item) => !accountModel || item.id !== "default");
    if (!automatic && !models.some((item) => item.id === profile.model)) {
        models.unshift({ id: profile.model, name: profile.model });
    }
    const selected = profileId === profile.id
        ? model ?? (automatic ? models.find((item) => item.is_default)?.id : profile.model)
        : undefined;
    const sorted = sortModels(models);
    // 이전 버전을 숨겨도 지금 고른 모델과 연결 기본 모델은 목록에 남긴다.
    const latest = latestModels(sorted, [selected, profile.model]);
    const older = sorted.length - latest.length;
    return <DropdownMenuSubMenu label={profile.name} icon={providerIcon(profile.protocol)} isDisabled={!profile.enabled}
        data-profile-id={profile.id} onOpenChange={onOpenChange} hasSpinner={catalog.loading}
        menuDataTestId={`model-profile-models-${profile.id}`}>
        <DropdownMenuRadioGroup label={`${profile.name} 모델`} value={includeDefault && !model && profileId === profile.id ? "__profile_default__" : selected}
            onChange={(id) => onChange(profile.id, id === "__profile_default__" || !includeDefault && !automatic && id === profile.model ? null : id)}>
            {includeDefault && <DropdownMenuRadioItem value="__profile_default__" label={`연결 기본 모델 · ${profile.model}`} data-option-value={profile.id} />}
            {(showAllModels ? sorted : latest).map((item) => <DropdownMenuRadioItem key={item.id} value={item.id} label={item.name}
                data-option-value={!includeDefault && !automatic && item.id === profile.model
                    ? profile.id : JSON.stringify([profile.id, item.id])} />)}
        </DropdownMenuRadioGroup>
        {older > 0 && <DropdownMenuDivider />}
        {older > 0 && <DropdownMenuCheckboxItem label="전체 모델 보기" value={showAllModels}
            endContent={showAllModels ? undefined : <GroveText as="span" type="supporting" color="secondary">+{older}</GroveText>}
            onChange={(next) => savePrefs({ ...loadPrefs(), showAllModels: next })} />}
        {!catalog.loading && !catalog.error && models.length === 0 && <DropdownMenuItem
            label={supported === false ? "이 서버는 모델 목록 조회를 지원하지 않아요." : "사용 가능한 모델이 없어요."} isDisabled />}
        {catalog.error instanceof Error && <DropdownMenuItem isDisabled
            label={<GroveText type="supporting" color="error" role="alert">{catalog.error.message}</GroveText>} />}
        {supported !== false && <DropdownMenuItem label="모델 목록 새로고침"
            isDisabled={catalog.loading} hasCloseOnSelect={false} onClick={() => catalog.reload()} />}
    </DropdownMenuSubMenu>;
}

function ModelSummary({ name, protocol, effort, fast, measuring = false }: {
    name: string; protocol?: string; effort?: SendOptions["effort"]; fast: boolean; measuring?: boolean;
}) {
    return <GroveStack as="span" direction="horizontal" align="center" wrap="wrap" gap={1} xstyle={composerStyles.modelName}>
        {providerIcon(protocol)}
        <GroveText as="span" type="inherit" data-testid={measuring ? undefined : "model-summary"}>{name}</GroveText>
        {effort && <GroveText as="span" type="inherit" color="secondary" data-testid={measuring ? undefined : "model-effort"}>· {effort}</GroveText>}
        {fast && <GroveStack as="span" direction="horizontal" align="center" gap={0} role="img" aria-label="Fast 켜짐">
            <Icon name="fast" size={14} color="blue" />
        </GroveStack>}
    </GroveStack>;
}

export function ModelSelect({ profiles, profileId, model, effort, fast = false, ready, bound, save, onChange, onFavorite, children, onExpandedChange }: {
    profiles: ModelProfile[]; profileId: string | null; model?: string | null;
    effort?: SendOptions["effort"]; fast?: boolean;
    ready: boolean; bound: boolean; save: boolean;
    onChange: (profileId: string, model: string | null) => void;
    onFavorite: (favorite: ModelFavorite) => void;
    children?: ReactNode;
    onExpandedChange: (expanded: boolean) => void;
}) {
    // 터치 등장 애니메이션의 투명 가림막 없이 Astryx의 바깥 탭·Escape·초점 복귀를 유지한다.
    const popover = usePopover({ dialogLabel: "모델 설정", closeButtonLabel: "모델 설정 닫기", padding: 3 });
    const [menuClearance, setMenuClearance] = useState(0);
    const trigger = useRef<HTMLButtonElement>(null);
    const { triggerRef } = popover;
    const attachTrigger = useCallback((node: HTMLButtonElement | null) => {
        trigger.current = node;
        triggerRef(node);
    }, [triggerRef]);
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
    const shownEffort = save ? undefined : effort;
    const shownFast = !save && fast;
    const shownProtocol = save ? undefined : profile?.protocol;
    const favorites = useModelFavorites(ready && !bound);
    const concreteModel = selected?.id ?? model ?? (!automatic ? profile?.model : null);
    const currentFavorite = !save && profile?.enabled && concreteModel
        ? { profile_id: profile.id, model: concreteModel, effort: effort ?? "auto", fast: shownFast } : null;
    // 하위 메뉴를 열기 전, 최근 사용·즐겨찾기 공급자의 모델 목록을 병렬로 받아 둔다.
    const prefetch = popover.isOpen && !bound && ready
        ? prefetchProfiles(profiles, profileId, readRecentProfiles(), favorites.state.value.map((item) => item.profile_id)) : [];
    const choose = (id: string, next: string | null) => {
        rememberRecentProfile(id);
        onChange(id, next);
    };
    const description = [summary, shownEffort, shownFast ? "Fast" : null].filter(Boolean).join(" · ");
    // 버튼의 자연 폭으로 판단한다. 두 줄 배치에서도 같은 폭을 재므로 크기 경계에서 왕복하지 않는다.
    useLayoutEffect(() => {
        const probe = measurement.current;
        const bar = probe?.closest<HTMLElement>('[data-testid="composer-bar"]');
        if (!probe || !bar) return;
        const composer = bar.closest<HTMLElement>('[data-testid="composer"]');
        const measure = () => {
            // 메뉴는 도구 줄이 아니라 입력 카드 위에 간격을 두고 띄운다.
            if (composer && trigger.current) setMenuClearance(Math.max(0,
                trigger.current.getBoundingClientRect().top - composer.getBoundingClientRect().top));
            const fixed = [...bar.querySelectorAll<HTMLElement>("[data-composer-fixed]")];
            const gap = parseFloat(getComputedStyle(bar).columnGap);
            const available = bar.clientWidth - fixed.reduce((sum, node) => sum + node.getBoundingClientRect().width, 0) - gap * fixed.length;
            onExpandedChange(probe.getBoundingClientRect().width > available);
        };
        const observer = new ResizeObserver(measure);
        observer.observe(bar);
        observer.observe(probe);
        if (composer) observer.observe(composer);
        measure();
        return () => observer.disconnect();
    }, [summary, shownProtocol, shownEffort, shownFast, onExpandedChange]);
    return <GroveStack gap={0} width="fit-content" maxWidth="100%" xstyle={composerStyles.modelControl}>
        <Button {...popover.triggerProps} ref={attachTrigger}
            onClick={popover.toggle} type="button" appearance="disclosure" width="100%" aria-label="모델 설정" title={description} xstyle={composerStyles.modelTrigger}>
            <ModelSummary name={summary} protocol={shownProtocol} effort={shownEffort} fast={shownFast} />
            <GroveText as="span" type="inherit" ref={measurement} aria-hidden="true" xstyle={composerStyles.modelMeasurement}>
                <ModelSummary name={summary} protocol={shownProtocol} effort={shownEffort} fast={shownFast} measuring />
            </GroveText>
        </Button>
        {prefetch.map((item) => <CatalogPrefetch key={item.id} profile={item} />)}
        {popover.render(<GroveStack gap={1} data-testid="model-settings">
                {!bound && <FavoriteChips favorites={favorites} current={currentFavorite} profiles={profiles} currentName={summary}
                    labelFor={(item) => (item.profile_id === profileId ? catalog.data?.models.find((m) => m.id === item.model)?.name : undefined) ?? item.model}
                    onApply={(favorite) => { rememberRecentProfile(favorite.profile_id); onFavorite(favorite); }} />}
                <GroveStack direction="horizontal" align="center" justify="between" gap={2} minHeight={44}>
                    <GroveText type="inherit" color="secondary">모델</GroveText>
                    <GroveStack direction="horizontal" align="center" justify="end" gap={1} xstyle={composerStyles.modelControl}>
                    <DropdownMenu placement="above" alignment="end"
                        renderTrigger={(props) => <Button {...props} type="button" appearance="disclosure"
                            style={{ minWidth: 0, minHeight: 44, fontSize: "inherit" }} title={detail}
                            aria-label="모델 프로필" data-selected-value={value} data-selected-profile={profileId ?? ""}
                            disabled={!ready || bound}>
                            {providerIcon(shownProtocol)}
                            <GroveText type="inherit" maxLines={1}>{summary}</GroveText>
                            {detail !== summary && <GroveStack gap={0} maxWidth="35%" style={{ minWidth: 0, flexShrink: 2 }}>
                                <GroveText type="supporting" color="secondary" maxLines={1}>{" · "}{profile!.name}</GroveText>
                            </GroveStack>}
                            <Icon name="chevronDown" size={16} />
                        </Button>}>
                        <ProfileModelMenus profiles={profiles} profileId={profileId} model={model} onChange={choose} />
                    </DropdownMenu>
                    {!bound && <FavoriteStar favorites={favorites} current={currentFavorite} profiles={profiles} />}
                    </GroveStack>
                </GroveStack>
                {catalog.error instanceof Error && <GroveText type="supporting" color="error" role="alert">{catalog.error.message}</GroveText>}
                {bound && <GroveText type="supporting" color="secondary">모델은 봇 설정에서 변경해요.</GroveText>}
                {children}
            </GroveStack>, {
            placement: "above", alignment: "start",
            offset: `calc(${menuClearance}px + var(--spacing-2))`,
            style: { inlineSize: "min(304px, calc(100vw - 2 * var(--spacing-3)))" },
        })}
    </GroveStack>;
}
