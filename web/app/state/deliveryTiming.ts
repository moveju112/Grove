// OBS-005: SSE 수신 이후 cache 조회·React commit까지 잰다. 서버/기기 벽시계나 편도 네트워크 추정은 쓰지 않는다.
type Sample = { sessionId: string; receivedAt: number; appliedMs?: number };

export class DeliveryTiming {
    private viewers = new Map<string, number>();
    private samples = new Map<string, Sample>();

    constructor(private now: () => number = () => performance.now()) {}

    watch(sessionId: string): () => void {
        this.viewers.set(sessionId, (this.viewers.get(sessionId) ?? 0) + 1);
        return () => {
            const count = (this.viewers.get(sessionId) ?? 1) - 1;
            if (count > 0) this.viewers.set(sessionId, count);
            else {
                this.viewers.delete(sessionId);
                for (const [id, sample] of this.samples) if (sample.sessionId === sessionId) this.samples.delete(id);
            }
        };
    }

    receive(sessionId: string, turnId: string) {
        if (!this.viewers.has(sessionId) || this.samples.has(turnId)) return;
        this.samples.set(turnId, { sessionId, receivedAt: this.now() });
        if (this.samples.size > 200) this.samples.delete(this.samples.keys().next().value!);
    }

    applied(turnId: string): number | null {
        const sample = this.samples.get(turnId);
        if (!sample) return null;
        sample.appliedMs ??= Math.max(0, this.now() - sample.receivedAt);
        return sample.appliedMs;
    }

    clear() {
        this.samples.clear();
    }
}

export const deliveryTiming = new DeliveryTiming();
