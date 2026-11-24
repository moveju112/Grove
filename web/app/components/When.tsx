import { useEffect, useState } from "react";
import { usePrefs } from "../state/device";
import { absoluteTime, displayTime, type TimePart } from "../state/time";

/// 시각 표시. 상대 표시는 30초마다 갱신하고, 정확한 시각은 title로 항상 확인할 수 있다.
/// relative: 최근 목록처럼 원래 경과 시간으로 보여 주던 자리는 설정과 무관하게 상대 시간으로 표시한다. compact는 날짜 대신 짧은 경과 단위를 유지한다.
export function When({ at, absolute = false, relative = false, compact = false, part = "datetime", titlePart = part }: { at: string; absolute?: boolean; relative?: boolean; compact?: boolean; part?: TimePart; titlePart?: TimePart }) {
    const device = usePrefs("clock", "timeStyle");
    const prefs = relative ? { ...device, timeStyle: "relative" as const } : device;
    const live = prefs.timeStyle === "relative" && !absolute;
    const [now, setNow] = useState(() => Date.now());
    useEffect(() => {
        if (!live) return;
        setNow(Date.now());
        const timer = setInterval(() => setNow(Date.now()), 30_000);
        return () => clearInterval(timer);
    }, [live]);
    return (
        <time dateTime={at} title={absoluteTime(at, prefs, titlePart)}>
            {displayTime(at, prefs, now, { absolute, compact, part })}
        </time>
    );
}
