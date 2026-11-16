export type Timing = {
    total_ms: number;
    approval_wait_ms: number;
    tool_ms: number;
    model_and_other_ms: number;
    provider_ms?: number | null;
    other_ms?: number | null;
    running: boolean;
};

export type TimingSample = { timing: Timing; receivedAt: number };

// 서버가 계산한 시작~종료(진행 중이면 조회 시각) 차이만 사용한다.
// 이후 화면 갱신도 Date.now 대신 단조 시계로 계산하므로 기기 시각 변경에 영향받지 않는다.
export function elapsedMs(sample: TimingSample, monotonicNow: number, advance: boolean): number {
    return Math.max(0, sample.timing.total_ms) + (advance && sample.timing.running ? Math.max(0, monotonicNow - sample.receivedAt) : 0);
}

export function seconds(ms: number): string {
    return `${Math.floor(Math.max(0, ms) / 1000)}초`;
}

export function startTimingTimer(enabled: boolean, tick: () => void): () => void {
    if (!enabled) return () => {};
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
}
