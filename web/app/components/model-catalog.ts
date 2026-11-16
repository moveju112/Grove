import type { AvailableModel } from "../api/generated";

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
