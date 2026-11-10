// SSE 프레임 파싱과 이벤트 cursor 상태(순수 로직, Vitest 대상).

export type Frame = { event: string; data: string; id?: string };

export class FrameParser {
    private buf = "";
    push(chunk: string): Frame[] {
        this.buf += chunk;
        const out: Frame[] = [];
        let idx: number;
        while ((idx = this.buf.indexOf("\n\n")) >= 0) {
            const raw = this.buf.slice(0, idx);
            this.buf = this.buf.slice(idx + 2);
            let event = "message";
            let id: string | undefined;
            const data: string[] = [];
            for (const line of raw.split("\n")) {
                if (line.startsWith(":")) continue;
                const c = line.indexOf(":");
                const field = c < 0 ? line : line.slice(0, c);
                let value = c < 0 ? "" : line.slice(c + 1);
                if (value.startsWith(" ")) value = value.slice(1);
                if (field === "event") event = value;
                else if (field === "data") data.push(value);
                else if (field === "id") id = value;
            }
            if (data.length > 0) out.push({ event, data: data.join("\n"), id });
        }
        return out;
    }
}

/// 이미 적용한 seq는 다시 적용하지 않는다(NET-007).
export class Cursor {
    constructor(public seq: number | null = null) {}
    accept(seq: number): boolean {
        if (this.seq !== null && seq <= this.seq) return false;
        this.seq = seq;
        return true;
    }
}

/// 지수 backoff + jitter(NET-011).
export function backoff(attempt: number, random: () => number = Math.random): number {
    const base = Math.min(30_000, 500 * 2 ** Math.min(attempt, 6));
    return Math.round(base / 2 + random() * (base / 2));
}
