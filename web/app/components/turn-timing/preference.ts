import { useSyncExternalStore } from "react";

export const TIMING_PREF_KEY = "grove.device.turn-timing";
const EVENT = "grove-turn-timing";

export function timingEnabled(): boolean {
    try {
        return localStorage.getItem(TIMING_PREF_KEY) !== "off";
    } catch {
        return true;
    }
}

export function saveTimingEnabled(enabled: boolean): void {
    localStorage.setItem(TIMING_PREF_KEY, enabled ? "on" : "off");
    window.dispatchEvent(new Event(EVENT));
}

function subscribe(notify: () => void): () => void {
    const storage = (e: StorageEvent) => {
        if (e.key === TIMING_PREF_KEY || e.key === null) notify();
    };
    window.addEventListener(EVENT, notify);
    window.addEventListener("storage", storage);
    return () => {
        window.removeEventListener(EVENT, notify);
        window.removeEventListener("storage", storage);
    };
}

export function useTimingEnabled(): boolean {
    return useSyncExternalStore(subscribe, timingEnabled, () => true);
}
