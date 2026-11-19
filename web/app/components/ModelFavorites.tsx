import { Stack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { api } from "../api/client";
import type { ModelFavorite, ModelProfile } from "../api/generated";
import { parseContract } from "../api/validation";
import { Button } from "../design/Button";
import { useQuery } from "../state/store";
import { composerStyles } from "./composer.stylex";
import { Icon } from "./icons";
import { useAutosave } from "./settings/useAutosave";

const KEY = "model.favorites";
const LIMIT = 24;
const EMPTY: ModelFavorite[] = [];
type Item = { key: string; effective: unknown; layers: { server: { revision: number } } };

function decode(item: Item) {
    if (!Array.isArray(item.effective)) throw new Error("즐겨찾기를 읽을 수 없습니다.");
    return { revision: item.layers.server.revision, value: item.effective.map((row) => parseContract("ModelFavorite", row)) };
}

export function useModelFavorites(enabled: boolean) {
    const shared = useQuery(enabled ? "settings:model-favorites" : null, async () => {
        const result = await api.get<{ items: Item[] }>("/settings/effective");
        const item = result.items.find((row) => row.key === KEY);
        return item ? decode(item) : null; // 구버전 데몬에 기기별 저장을 만들지 않는다.
    });
    const state = useAutosave({ id: KEY, value: shared.data?.value ?? EMPTY, revision: shared.data?.revision ?? 0,
        save: async (value, revision, key) => {
            try {
                const response = await api.put<{ item: Item }>(`/settings/server/-/${KEY}`, { value, expected_revision: revision }, { key });
                return decode(response.item);
            } finally { shared.reload(); }
        },
    });
    return { shared: !!shared.data, state };
}

export function favoriteKey(favorite: ModelFavorite) {
    return JSON.stringify([favorite.profile_id, favorite.model, favorite.effort, favorite.fast]);
}

type FavoritesProps = {
    favorites: ReturnType<typeof useModelFavorites>;
    current: ModelFavorite | null;
    profiles: ModelProfile[];
    currentName: string;
    labelFor: (favorite: ModelFavorite) => string;
    onApply: (favorite: ModelFavorite) => void;
};

export function FavoriteChips({ favorites: { shared, state }, current, profiles, currentName, labelFor, onApply }: FavoritesProps) {
    if (!shared) return null;
    const rows = state.value.filter((item) => profiles.some((profile) => profile.id === item.profile_id));
    const selectedKey = current && favoriteKey(current);
    const failed = state.phase === "conflict" || state.phase === "uncertain" || state.phase === "error";
    if (!rows.length && !failed && state.phase !== "saving") return null;
    return <Stack as="section" gap={1} paddingBlockEnd={2} xstyle={composerStyles.favoritesSection} aria-label="즐겨찾기">
        {!!rows.length && <>
            <Text type="supporting" color="secondary" weight="semibold">즐겨찾기</Text>
            <Stack gap={0} xstyle={composerStyles.favoriteGrid} data-testid="model-favorite-grid">
                {rows.map((item) => {
                    const key = favoriteKey(item);
                    const active = key === selectedKey;
                    const profile = profiles.find((p) => p.id === item.profile_id)!;
                    const label = active ? currentName : labelFor(item);
                    const meta = `${item.effort} · Fast ${item.fast ? "켜짐" : "꺼짐"}`;
                    return <Button key={key} type="button" appearance="navigation" width="100%"
                        xstyle={[composerStyles.favoriteChip, active && composerStyles.activeFavoriteChip]}
                        aria-label={`${label} · ${profile.name} · ${meta}`} aria-pressed={active} disabled={!profile.enabled}
                        onClick={() => onApply(item)}>
                        <Stack as="span" gap={0} align="start" xstyle={composerStyles.favoriteChipText}>
                            <Text as="span" type="label" maxLines={1}>{label}</Text>
                            <Text as="span" type="supporting" color="secondary" maxLines={1}>{meta}</Text>
                        </Stack>
                        {active && <Icon name="check" size={14} />}
                    </Button>;
                })}
            </Stack>
        </>}
        {state.phase === "saving" && <Text type="supporting" color="secondary" role="status">즐겨찾기 저장 중…</Text>}
        {failed && <Stack gap={1}>
            <Text type="supporting" color="error" role="alert">{state.phase === "conflict" ? "다른 기기에서 즐겨찾기를 변경했어요." : state.message ?? "즐겨찾기를 저장하지 못했어요."}</Text>
            <Button type="button" appearance="link" onClick={state.phase === "conflict" || !state.canRetry ? state.useRemote : state.retry}>
                {state.phase === "conflict" ? "동기화된 목록 보기" : state.phase === "uncertain" ? "저장 결과 확인" : "다시 시도"}
            </Button>
        </Stack>}
    </Stack>;
}

export function FavoriteStar({ favorites: { shared, state }, current, profiles }: Pick<FavoritesProps, "favorites" | "current" | "profiles">) {
    if (!shared || !current) return null;
    const key = favoriteKey(current);
    const active = state.value.some((item) => favoriteKey(item) === key);
    const rows = state.value.filter((item) => profiles.some((profile) => profile.id === item.profile_id));
    const full = !active && rows.length >= LIMIT;
    const label = active ? "현재 조합 즐겨찾기에서 삭제" : "현재 조합 즐겨찾기에 추가";
    return <Button type="button" appearance="icon" width={36} xstyle={[composerStyles.favoriteStar, active && composerStyles.activeFavoriteStar]}
        aria-label={label} title={full ? "즐겨찾기는 24개까지 저장할 수 있어요." : label} aria-pressed={active}
        disabled={full || !["idle", "saved"].includes(state.phase)} onClick={() => {
            state.change(active ? rows.filter((item) => favoriteKey(item) !== key) : [current, ...rows]);
            state.commit();
        }}>
        <Icon name={active ? "starFilled" : "star"} size={18} />
    </Button>;
}
