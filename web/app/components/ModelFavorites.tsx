import { Stack } from "@astryxdesign/core/Stack";
import * as stylex from "@stylexjs/stylex";
import { Text } from "@astryxdesign/core/Text";
import { useId, useRef } from "react";
import { api } from "../api/client";
import type { ModelFavorite, ModelProfile } from "../api/generated";
import { parseContract } from "../api/validation";
import { Button } from "../design/Button";
import { useQuery } from "../state/store";
import { composerStyles } from "./composer.stylex";
import { Icon } from "./icons";
import { useAutosave } from "./settings/useAutosave";
import { useTouchOrder } from "./useTouchOrder";
import { touchOrderStyles } from "./touchOrder.stylex";
import { ProviderMark } from "./usage/ProviderMark";

const CHIP = "[data-favorite-key]";
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

// 공급자 열은 Claude → Codex → 그 밖의 API 순으로 고정한다. 열 안의 순서는 저장된 순서를 따른다.
const GROUPS = [
    { id: "claude", label: "Claude", mark: "claude_code", protocols: ["claude_code", "anthropic"] },
    { id: "codex", label: "Codex", mark: "codex_cli", protocols: ["codex_cli", "codex_oauth"] },
    { id: "api", label: "API", mark: "", protocols: [] },
] satisfies { id: string; label: string; mark: string; protocols: string[] }[];
const groupOf = (protocol: string) => (GROUPS.find((group) => group.protocols.includes(protocol)) ?? GROUPS[2]!).id;

type FavoritesProps = {
    favorites: ReturnType<typeof useModelFavorites>;
    current: ModelFavorite | null;
    profiles: ModelProfile[];
    currentName: string;
    labelFor: (favorite: ModelFavorite) => string;
    onApply: (favorite: ModelFavorite) => void;
};

export function FavoriteChips({ favorites: { shared, state }, current, profiles, currentName, labelFor, onApply }: FavoritesProps) {
    const grid = useRef<HTMLDivElement>(null);
    const headingId = useId();
    const rows = state.value.filter((item) => profiles.some((profile) => profile.id === item.profile_id));
    const group = new Map(rows.map((item) => [favoriteKey(item), groupOf(profiles.find((p) => p.id === item.profile_id)!.protocol)]));
    const columns = GROUPS.map((column) => ({ ...column, rows: rows.filter((item) => group.get(favoriteKey(item)) === column.id) }))
        .filter((column) => column.rows.length);
    const drag = useTouchOrder<string>({
        enabled: shared && rows.length > 1 && (state.phase === "idle" || state.phase === "saved"),
        mouse: true, selector: CHIP, idFor: (chip) => chip.dataset.favoriteKey!,
        viewportFor: (chip) => {
            if (!grid.current?.contains(chip)) return null;
            for (let parent: HTMLElement | null = grid.current; parent; parent = parent.parentElement) {
                if (/^(auto|scroll)$/.test(getComputedStyle(parent).overflowY) && parent.scrollHeight > parent.clientHeight) return parent;
            }
            return grid.current;
        },
        targetAt: ({ id, x, y }) => {
            const chip = document.elementFromPoint(x, y)?.closest<HTMLElement>(CHIP);
            const target = chip && grid.current?.contains(chip) ? chip.dataset.favoriteKey! : null;
            return target && target !== id && group.get(target) === group.get(id) ? target : null; // 순서는 같은 공급자 열 안에서만 바꾼다.
        },
        onDrop: (source, target) => {
            const next = [...state.value];
            const from = next.findIndex((item) => favoriteKey(item) === source);
            const to = next.findIndex((item) => favoriteKey(item) === target);
            if (from < 0 || to < 0 || from === to) return;
            const [moved] = next.splice(from, 1);
            next.splice(to, 0, moved!);
            state.change(next);
            state.commit();
        },
    });
    if (!shared) return null;
    const selectedKey = current && favoriteKey(current);
    const failed = state.phase === "conflict" || state.phase === "uncertain" || state.phase === "error";
    if (!rows.length && !failed && state.phase !== "saving") return null;
    return <Stack as="section" gap={1} paddingBlockEnd={2} xstyle={composerStyles.favoritesSection} aria-label="즐겨찾기">
        {!!columns.length && <div ref={grid} {...stylex.props(composerStyles.favoriteColumns)}
            style={{ gridTemplateColumns: `repeat(${columns.length}, minmax(0, 1fr))` }} data-testid="model-favorite-grid">
            {columns.map((column) => <Stack key={column.id} gap={1} role="group" aria-labelledby={`${headingId}-${column.id}`}
                xstyle={composerStyles.favoriteColumn} data-favorite-group={column.id}>
                <Text id={`${headingId}-${column.id}`} type="supporting" weight="semibold" xstyle={composerStyles.favoriteHeading}>
                    {column.mark && <ProviderMark protocol={column.mark} />}{column.label}
                </Text>
                {column.rows.map((item) => {
                    const key = favoriteKey(item);
                    const active = key === selectedKey;
                    const profile = profiles.find((p) => p.id === item.profile_id)!;
                    const label = active ? currentName : labelFor(item);
                    const meta = `${item.effort} · Fast ${item.fast ? "켜짐" : "꺼짐"}`;
                    return <Button key={key} type="button" appearance="navigation" width="100%"
                        data-favorite-key={key} data-order-dragging={drag?.id === key || undefined}
                        data-order-drop={drag?.target === key || undefined}
                        xstyle={[composerStyles.favoriteChip, touchOrderStyles.handle, active && composerStyles.activeFavoriteChip,
                            drag?.target === key && composerStyles.favoriteDrop, drag?.id === key && touchOrderStyles.lift(drag.dx, drag.dy)]}
                        aria-label={`${label} · ${profile.name} · ${meta}`} aria-pressed={active} disabled={!profile.enabled}
                        onClick={() => onApply(item)}>
                        <Stack as="span" gap={0} align="start" xstyle={composerStyles.favoriteChipText}>
                            <Text as="span" type="label" maxLines={1}>{label}</Text>
                            <Text as="span" type="supporting" color="secondary" maxLines={1}>{meta}</Text>
                        </Stack>
                        {active && <Icon name="check" size={14} />}
                    </Button>;
                })}
            </Stack>)}
        </div>}
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
            state.change(active ? rows.filter((item) => favoriteKey(item) !== key) : [...rows, current]); // 새 즐겨찾기는 맨 아래에 붙인다.
            state.commit();
        }}>
        <Icon name={active ? "starFilled" : "star"} size={18} />
    </Button>;
}
