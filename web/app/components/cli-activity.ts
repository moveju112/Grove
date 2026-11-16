export type CliActivity = {
    kind: string;
    name: string;
    input?: unknown;
    status?: string | null;
    exit_code?: number | null;
};

// 호출 기록은 그대로 두고 제목만 집계한다. 종류가 많아도 거부·실패 건수는 숨기지 않는다.
export function cliActivitySummary(items: readonly CliActivity[]): string {
    const counts = new Map<string, number>();
    let denied = 0;
    let failed = 0;
    for (const item of items) {
        counts.set(item.name, (counts.get(item.name) ?? 0) + 1);
        if (item.kind === "denied") denied++;
        else if (item.status === "failed" || (typeof item.exit_code === "number" && item.exit_code !== 0)) failed++;
    }
    const groups = [...counts].slice(0, 3).map(([name, count]) => `${name} ${count}회`);
    if (counts.size > groups.length) groups.push(`외 ${counts.size - groups.length}종`);
    return [
        `CLI 도구 ${items.length}회`,
        ...(groups.length ? [groups.join(", ")] : []),
        ...(denied ? [`거부 ${denied}회`] : []),
        ...(failed ? [`실패 ${failed}회`] : []),
    ].join(" · ");
}
