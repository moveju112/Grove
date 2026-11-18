import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ContextMeter } from "./ContextMeter";

const state = vi.hoisted(() => ({
    usage: { context_window: 100_000 as number | null, percent: 25 as number | null, tokens: 25_000,
        estimated_tokens: 30_000, measured_input_tokens: null, basis: "native", reserve_tokens: 4096, available_tokens: 70_904 },
    partials: {} as Record<string, unknown>,
}));
vi.mock("../state/store", async (importOriginal) => ({
    ...await importOriginal<typeof import("../state/store")>(),
    useQuery: () => ({ data: state.usage, reload: vi.fn() }),
    useLive: (select: (live: { partials: Record<string, unknown> }) => unknown) => select({ partials: state.partials }),
}));
const render = () => renderToStaticMarkup(<ContextMeter sessionId="session" profileId="profile" activeTurnId="turn" busy={false} onError={() => {}} />);

beforeEach(() => {
    state.usage.context_window = 100_000;
    state.usage.percent = 25;
    state.usage.tokens = 25_000;
    state.partials = {};
});

describe("컨텍스트 게이지", () => {
    it("사용률만큼 채우고 100%를 넘으면 원 안에서 제한한다", () => {
        expect(render()).toContain('stroke-dasharray="25 75"');
        state.usage.percent = 125;
        expect(render()).toContain('stroke-dasharray="100 0"');
    });

    it("한도를 모르거나 0%이면 채움 없이 바탕 고리만 그린다", () => {
        for (const percent of [null, 0]) {
            state.usage.percent = percent;
            const html = render();
            expect(html.match(/<circle\b/g)).toHaveLength(1);
            expect(html).not.toContain("stroke-dasharray");
        }
        state.usage.context_window = null;
        state.usage.percent = null;
        expect(render()).toContain("컨텍스트 한도 미확인");
    });

    it("현재 대화·턴·프로필의 실시간 점유량만 반영한다", () => {
        const snapshot = { turn_id: "turn", profile_id: "profile", context_usage: { tokens: 75_000, context_window: 100_000 } };
        state.partials.other = snapshot;
        expect(render()).toContain('stroke-dasharray="25 75"');
        state.partials.session = { ...snapshot, turn_id: "old-turn" };
        expect(render()).toContain('stroke-dasharray="25 75"');
        state.partials.session = { ...snapshot, profile_id: "other-profile" };
        expect(render()).toContain('stroke-dasharray="25 75"');
        state.partials.session = snapshot;
        expect(render()).toContain('stroke-dasharray="75 25"');
        state.partials.session = { ...snapshot, context_usage: { tokens: 5000, context_window: 100_000 } };
        expect(render()).toContain('stroke-dasharray="5 95"');
    });
});
