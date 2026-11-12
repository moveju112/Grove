import { describe, expect, it } from "vitest";
import { retryIntent } from "./recentPatch";

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
});
