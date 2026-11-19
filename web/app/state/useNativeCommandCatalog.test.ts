import { describe, expect, it } from "vitest";
import { NATIVE_COMMANDS_TTL_MS, nativeCommandsNeedRefresh } from "./useNativeCommandCatalog";

describe("CLI 명령 목록 재사용 기간", () => {
    it("기간 안의 목록은 다시 받지 않고, 지난 목록과 실패한 조회만 다시 받는다", () => {
        expect(nativeCommandsNeedRefresh(1_000, false, 1_000 + NATIVE_COMMANDS_TTL_MS - 1)).toBe(false);
        expect(nativeCommandsNeedRefresh(1_000, false, 1_000 + NATIVE_COMMANDS_TTL_MS)).toBe(true);
        expect(nativeCommandsNeedRefresh(undefined, true, 0)).toBe(true);
    });

    it("첫 조회가 끝나기 전에는 중복 요청하지 않는다", () => {
        expect(nativeCommandsNeedRefresh(undefined, false, Number.MAX_SAFE_INTEGER)).toBe(false);
    });
});
