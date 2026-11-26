import type { Prefs } from "./device";

// 화면의 시각 표시. 서버 값(UTC RFC3339)은 바꾸지 않는다.
export type TimePrefs = Pick<Prefs, "clock" | "timeStyle">;
export type TimePart = "datetime" | "time" | "minute";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
// 상대 표시는 7일 이내의 지난 시각에만 쓴다. 오래된 시각은 날짜가 더 정확하다.
const RELATIVE_LIMIT = 7 * DAY;
// 서버와 기기 시계 차이로 방금 지난 시각이 약간 미래로 보이는 경우는 "방금 전"으로 둔다.
const CLOCK_SKEW = MINUTE;
export const UNKNOWN_TIME = "알 수 없는 시각";

function hour12(p: TimePrefs): boolean | undefined {
    return p.clock === "system" ? undefined : p.clock === "12h";
}

export function serverTimeZone(value: unknown): string {
    if (typeof value === "string") {
        try { return new Intl.DateTimeFormat(undefined, { timeZone: value }).resolvedOptions().timeZone; }
        catch { /* 지원하지 않는 서버 시간대 */ }
    }
    return "UTC";
}

export function absoluteTime(at: string, p: TimePrefs, part: TimePart = "datetime", timeZone?: string): string {
    const date = new Date(at);
    if (Number.isNaN(date.getTime())) return UNKNOWN_TIME;
    const options: Intl.DateTimeFormatOptions = { hour12: hour12(p), timeZone, timeZoneName: timeZone ? "short" : undefined };
    if (part === "minute") return date.toLocaleTimeString(undefined, { ...options, hour: "numeric", minute: "2-digit" });
    return part === "time" ? date.toLocaleTimeString(undefined, options) : date.toLocaleString(undefined, options);
}

/// absolute: 만료·예정·기준 시각처럼 상대 표시가 오해를 부르는 값은 항상 절대 시각으로 표시한다.
export function displayTime(at: string, p: TimePrefs, now: number, opts: { absolute?: boolean; compact?: boolean; part?: TimePart } = {}): string {
    const time = new Date(at).getTime();
    if (Number.isNaN(time)) return UNKNOWN_TIME;
    const ago = now - time;
    if (p.timeStyle !== "relative" || opts.absolute || ago < -CLOCK_SKEW || (!opts.compact && ago >= RELATIVE_LIMIT)) return absoluteTime(at, p, opts.part);
    if (opts.compact) {
        if (ago < HOUR) return `${Math.max(0, Math.floor(ago / MINUTE))}m`;
        if (ago < DAY) return `${Math.floor(ago / HOUR)}h`;
        return `${Math.floor(ago / DAY)}d`;
    }
    if (ago < MINUTE) return "방금 전";
    const format = new Intl.RelativeTimeFormat("ko", { numeric: "auto" });
    if (ago < HOUR) return format.format(-Math.floor(ago / MINUTE), "minute");
    if (ago < DAY) return format.format(-Math.floor(ago / HOUR), "hour");
    return format.format(-Math.floor(ago / DAY), "day");
}
