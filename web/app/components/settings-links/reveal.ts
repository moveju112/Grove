export type SettingLinkReady = (key: string, element: HTMLElement | null) => void;

export function settingLinkKey(hash: string): string | null {
    if (!hash.startsWith("#setting-")) return null;
    try {
        return decodeURIComponent(hash.slice(9)) || null;
    } catch {
        return null;
    }
}

// 행 준비 신호는 현재 인스턴스의 실제 anchor만 소비하고, 완료·취소 뒤에는 무시한다.
export function createSettingReveal(root: HTMLElement | null, key: string) {
    let pending = true;
    return {
        cancel() { pending = false; },
        ready(candidate: string, element: HTMLElement | null): "ignored" | "revealed" | "unavailable" {
            if (!pending || candidate !== key) return "ignored";
            if (element && (!root?.contains(element) || element.dataset.settingKey !== key)) return "ignored";
            pending = false;
            if (!element || !element.isConnected) return "unavailable";
            if (element.getClientRects().length === 0) return "unavailable";
            element.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" });
            return "revealed";
        },
    };
}
