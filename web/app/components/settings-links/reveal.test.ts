import { describe, expect, it, vi } from "vitest";
import { createSettingReveal, settingLinkKey } from "./reveal";

function anchors() {
    const scrollIntoView = vi.fn();
    const element = {
        dataset: { settingKey: "context.input_reserve_tokens" },
        isConnected: true,
        getClientRects: () => [{}],
        scrollIntoView,
    } as unknown as HTMLElement;
    const root = { contains: (node: HTMLElement) => node === element } as unknown as HTMLElement;
    return { root, element, scrollIntoView };
}

describe("설정 직접 링크의 안전한 일회성 이동", () => {
    it("키를 그대로 decode하며 다른 hash·빈 키·잘못된 인코딩은 무시한다", () => {
        expect(settingLinkKey("#setting-context.input_reserve_tokens")).toBe("context.input_reserve_tokens");
        expect(settingLinkKey("#setting-a%22%5D%2Fb")).toBe('a"]/b');
        for (const hash of ["", "#other", "#setting-", "#setting-%E0%A4%A"]) expect(settingLinkKey(hash)).toBeNull();
    });
    it("다른 키·다른 pane의 anchor를 소비하지 않고 자기 행에서 한 번만 이동한다", () => {
        const { root, element, scrollIntoView } = anchors();
        const other = anchors().element;
        const reveal = createSettingReveal(root, element.dataset.settingKey!);
        expect(reveal.ready("other", element)).toBe("ignored");
        expect(reveal.ready(element.dataset.settingKey!, other)).toBe("ignored");
        expect(reveal.ready(element.dataset.settingKey!, element)).toBe("revealed");
        expect(reveal.ready(element.dataset.settingKey!, element)).toBe("ignored");
        expect(scrollIntoView).toHaveBeenCalledExactlyOnceWith({ block: "center", inline: "nearest", behavior: "instant" });
    });
    it("취소 뒤의 늦은 행 준비는 사용자 스크롤을 빼앗지 않는다", () => {
        const { root, element, scrollIntoView } = anchors();
        const reveal = createSettingReveal(root, element.dataset.settingKey!);
        reveal.cancel();
        expect(reveal.ready(element.dataset.settingKey!, element)).toBe("ignored");
        expect(scrollIntoView).not.toHaveBeenCalled();
    });
    it("조회 실패·누락·분리·숨겨진 행은 성공으로 처리하지 않고 종료한다", () => {
        for (const mode of ["missing", "detached", "hidden"] as const) {
            const { root, element, scrollIntoView } = anchors();
            if (mode === "detached") Object.assign(element, { isConnected: false });
            if (mode === "hidden") Object.assign(element, { getClientRects: () => [] });
            const key = element.dataset.settingKey!;
            const reveal = createSettingReveal(root, key);
            expect(reveal.ready(key, mode === "missing" ? null : element)).toBe("unavailable");
            expect(reveal.ready(key, element)).toBe("ignored");
            expect(scrollIntoView).not.toHaveBeenCalled();
        }
    });
});
