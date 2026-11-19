// 경과 시간·예산 카운트다운이 하나의 타이머를 공유한다. 표시 중인 구독자가 없으면 멈춘다.
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | undefined;

export function subscribeSecondTick(tick: () => void): () => void {
    const listener = () => tick();
    listeners.add(listener);
    timer ??= setInterval(() => { for (const run of [...listeners]) run(); }, 1000);
    tick();
    return () => {
        listeners.delete(listener);
        if (!listeners.size && timer !== undefined) {
            clearInterval(timer);
            timer = undefined;
        }
    };
}
