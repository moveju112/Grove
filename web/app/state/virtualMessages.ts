// 실제 측정 높이를 우선하고 아직 보지 않은 행만 추정한다. 범위의 end는 exclusive다.
export function messageOffsets(messages: readonly { id: string }[], heights: ReadonlyMap<string, number>, estimate = 112): number[] {
    const offsets = [0];
    for (const message of messages) offsets.push(offsets.at(-1)! + (heights.get(message.id) ?? estimate));
    return offsets;
}

export function messageRange(offsets: readonly number[], top: number, bottom: number, overscan = 8): { start: number; end: number } {
    const count = offsets.length - 1;
    if (count <= 0) return { start: 0, end: 0 };
    const at = (position: number) => {
        let low = 0, high = count;
        while (low < high) {
            const mid = Math.floor((low + high) / 2);
            if (offsets[mid + 1]! <= position) low = mid + 1;
            else high = mid;
        }
        return Math.min(low, count - 1);
    };
    return { start: Math.max(0, at(Math.max(0, top)) - overscan), end: Math.min(count, at(Math.max(0, bottom - 0.001)) + 1 + overscan) };
}
