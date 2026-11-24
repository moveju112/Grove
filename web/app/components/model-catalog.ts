import type { AvailableModel, ModelProfile } from "../api/generated";

export function catalogModel(models: readonly AvailableModel[] | undefined, profile: ModelProfile | undefined, model?: string | null) {
    return models?.find((entry) => entry.id === (model ?? profile?.model))
        ?? (profile?.model === "default" && !model ? models?.find((entry) => entry.is_default) : undefined);
}

export function modelEfforts(profile: ModelProfile | undefined, model: AvailableModel | undefined) {
    return model?.reasoning_efforts ?? (profile?.protocol === "codex_cli" || profile?.protocol === "codex_oauth" ? [] : ["low", "medium", "high"]);
}

const VERSION = /\d+(?:[.-]\d+)*/;
// 끝의 날짜(-20251001, -2024-08-06, -05-06, -0613)는 같은 모델의 고정본 표시로 본다.
const SNAPSHOT = /[-_@ ](?:\d{4}-\d{2}-\d{2}|\d{8}|\d{2}-\d{2}|\d{4})$/;
// 날짜 없는 별칭은 같은 버전의 최신 고정본을 가리키므로 고정본보다 높게 둔다.
const ALIAS = Number.MAX_SAFE_INTEGER;

/// 표시 이름에 버전이 없으면 모델 ID에서 버전을 읽는다.
function versionSource(model: AvailableModel) {
    return VERSION.test(model.name) ? model.name : model.id;
}

function version(model: AvailableModel): number[] {
    const match = versionSource(model).match(VERSION);
    return match ? match[0].split(/[.-]/).map(Number) : [];
}

function compareVersion(left: readonly number[], right: readonly number[]) {
    for (let i = 0; i < Math.max(left.length, right.length); i++) {
        const difference = (left[i] ?? 0) - (right[i] ?? 0);
        if (difference) return difference;
    }
    return 0;
}

export function sortModels(models: readonly AvailableModel[]): AvailableModel[] {
    return [...models].sort((a, b) => {
        const left = version(a);
        const right = version(b);
        if (!left.length || !right.length) {
            if (left.length !== right.length) return left.length ? -1 : 1;
        }
        return compareVersion(right, left)
            || a.name.localeCompare(b.name, "en", { numeric: true })
            || a.id.localeCompare(b.id, "en", { numeric: true });
    });
}

type Lineage = { family: string; version: number[]; snapshot: number };

/// 버전 숫자를 뺀 이름을 계열로 삼는다(`Opus 4.7`·`Opus 5.5` → `opus-#`). 버전이 없으면 비교하지 않는다.
function lineage(model: AvailableModel): Lineage | null {
    const source = versionSource(model);
    const snapshot = source.match(SNAPSHOT);
    const base = snapshot ? source.slice(0, snapshot.index) : source;
    const match = base.match(VERSION);
    if (!match) return null;
    const family = `${base.slice(0, match.index)}#${base.slice(match.index! + match[0].length)}`.toLowerCase().replace(/[\s_-]+/g, "-");
    return { family, version: match[0].split(/[.-]/).map(Number), snapshot: snapshot ? Number(snapshot[0].replace(/\D/g, "")) : ALIAS };
}

function compareLineage(left: Lineage, right: Lineage) {
    return compareVersion(left.version, right.version) || left.snapshot - right.snapshot;
}

/// 계열마다 가장 높은 버전만 남기고 순서는 유지한다.
/// 버전을 알 수 없는 모델, 공급자 기본 모델, `keep`에 든 모델(현재 선택 등)은 항상 남긴다.
export function latestModels(models: readonly AvailableModel[], keep: readonly (string | null | undefined)[] = []): AvailableModel[] {
    const lineages = models.map(lineage);
    const best = new Map<string, Lineage>();
    for (const item of lineages) {
        const current = item && best.get(item.family);
        if (item && (!current || compareLineage(item, current) > 0)) best.set(item.family, item);
    }
    return models.filter((model, index) => {
        const item = lineages[index];
        return !item || model.is_default || keep.includes(model.id) || compareLineage(item, best.get(item.family)!) === 0;
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
