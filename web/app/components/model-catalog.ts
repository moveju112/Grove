import type { AvailableModel, ModelProfile } from "../api/generated";

export function catalogModel(models: readonly AvailableModel[] | undefined, profile: ModelProfile | undefined, model?: string | null) {
    return models?.find((entry) => entry.id === (model ?? profile?.model))
        ?? (profile?.model === "default" && !model ? models?.find((entry) => entry.is_default) : undefined);
}

export function modelEfforts(profile: ModelProfile | undefined, model: AvailableModel | undefined) {
    return model?.reasoning_efforts ?? (profile?.protocol === "codex_cli" || profile?.protocol === "codex_oauth" ? [] : ["low", "medium", "high"]);
}

function version(model: AvailableModel): number[] {
    const match = model.name.match(/\d+(?:[.-]\d+)*/) ?? model.id.match(/\d+(?:[.-]\d+)*/);
    return match ? match[0].split(/[.-]/).map(Number) : [];
}

export function sortModels(models: readonly AvailableModel[]): AvailableModel[] {
    return [...models].sort((a, b) => {
        const left = version(a);
        const right = version(b);
        if (!left.length || !right.length) {
            if (left.length !== right.length) return left.length ? -1 : 1;
        }
        for (let i = 0; i < Math.max(left.length, right.length); i++) {
            const difference = (right[i] ?? 0) - (left[i] ?? 0);
            if (difference) return difference;
        }
        return a.name.localeCompare(b.name, "en", { numeric: true })
            || a.id.localeCompare(b.id, "en", { numeric: true });
    });
}

/// 기기에서 최근 고른 모델 프로필. 로그아웃 정리 접두사(grove.composer.options) 아래에 둔다.
export const RECENT_PROFILES_KEY = "grove.composer.options.recent-profiles";
const RECENT_LIMIT = 4;

export function readRecentProfiles(): string[] {
    try {
        const value: unknown = JSON.parse(localStorage.getItem(RECENT_PROFILES_KEY) ?? "[]");
        return Array.isArray(value) ? value.filter((id): id is string => typeof id === "string").slice(0, RECENT_LIMIT) : [];
    } catch { return []; }
}

export function rememberRecentProfile(id: string) {
    try { localStorage.setItem(RECENT_PROFILES_KEY, JSON.stringify([id, ...readRecentProfiles().filter((item) => item !== id)].slice(0, RECENT_LIMIT))); }
    catch { /* 저장하지 못해도 다음 메뉴에서 미리 조회만 생략된다. */ }
}

/// 모델 메뉴를 열 때 하위 메뉴보다 먼저 목록을 받아 둘 프로필. 최근 사용 → 즐겨찾기 순, 현재 프로필과 꺼진 프로필은 뺀다.
export function prefetchProfiles(profiles: readonly ModelProfile[], currentId: string | null, recent: readonly string[],
    favorites: readonly string[], limit = 3): ModelProfile[] {
    const result: ModelProfile[] = [];
    for (const id of [...recent, ...favorites]) {
        if (result.length >= limit) break;
        const profile = profiles.find((item) => item.id === id);
        if (profile?.enabled && id !== currentId && !result.includes(profile)) result.push(profile);
    }
    return result;
}
