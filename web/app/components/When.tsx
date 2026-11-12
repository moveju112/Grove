import { useEffect, useState } from "react";
import { usePrefs } from "../state/device";
import { absoluteTime, displayTime, type TimePart } from "../state/time";

/// 시각 표시. 상대 표시는 30초마다 갱신하고, 정확한 시각은 title로 항상 확인할 수 있다.
export function When({ at, absolute = false, part = "datetime" }: { at: string; absolute?: boolean; part?: TimePart }) {
    const prefs = usePrefs();
    const live = prefs.timeStyle === "relative" && !absolute;
    const [now, setNow] = useState(() => Date.now());
    useEffect(() => {
        if (!live) return;
        setNow(Date.now());
        const timer = setInterval(() => setNow(Date.now()), 30_000);
        return () => clearInterval(timer);
    }, [live]);
    return (
        <time dateTime={at} title={absoluteTime(at, prefs, part)}>
            {displayTime(at, prefs, now, { absolute, part })}
        </time>
    );
}
