import { describe, expect, it, vi } from "vitest";
import { ApiError, api } from "../api/client";
import { prepareRecentPatch, retryIntent } from "./recentPatch";

describe("최근 항목 동시 변경", () => {
    it("다른 기기가 이미 같은 값으로 바꿨으면 다시 보내지 않는다", () => {
        expect(retryIntent({ pinned: true, hidden: false, revision: 5 }, { pinned: true })).toBeNull();
    });
    it("다른 필드가 바뀌었으면 최신 revision으로 내 필드만 다시 적용한다", () => {
        expect(retryIntent({ pinned: true, hidden: false, revision: 5 }, { hidden: true })).toEqual({ expected_revision: 5, hidden: true });
    });
    it("같은 필드를 반대로 바꿨어도 사용자가 방금 누른 의도를 한 번 적용한다", () => {
        expect(retryIntent({ pinned: false, hidden: false, revision: 7 }, { pinned: true })).toEqual({ expected_revision: 7, pinned: true });
    });
    it("충돌로 다시 적용한 요청의 응답을 잃어도 같은 본문과 키로 확인한다", async () => {
        const patch = vi.spyOn(api, "patch")
            .mockRejectedValueOnce(new ApiError(409, "revision_conflict", "충돌", false,
                { current: { pinned: false, hidden: false, revision: 5 } }))
            .mockRejectedValueOnce(new ApiError(0, "network_error", "응답 유실", true, { result_unknown: true }))
            .mockResolvedValueOnce({});
        try {
            const hide = prepareRecentPatch({ id: "recent-id", revision: 3 }, { hidden: true });
            await expect(hide()).rejects.toThrow("응답 유실");
            expect(patch).toHaveBeenCalledTimes(2);
            await hide();
            const [initial, rebased, confirmed] = patch.mock.calls;
            expect(rebased![1]).toEqual({ expected_revision: 5, hidden: true });
            expect(initial![2]?.key).not.toBe(rebased![2]?.key);
            expect(confirmed).toEqual(rebased);
        } finally { patch.mockRestore(); }
    });
});
