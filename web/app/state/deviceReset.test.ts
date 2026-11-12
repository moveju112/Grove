import { describe, expect, it } from "vitest";
import { defaultPrefs, restoredPrefs } from "./device";

describe("기기 표시 설정의 선택 복원", () => {
    it("선택한 항목만 기본값으로 바꾸고 이후 바뀐 다른 항목을 보존한다", () => {
        const before = { ...defaultPrefs, theme: "dark" as const };
        const latest = { ...before, fontSize: 20, answerOnly: true };
        const result = restoredPrefs(latest, before, ["theme"]);
        expect(result).toEqual({ ...latest, theme: defaultPrefs.theme });
        expect(latest.theme).toBe("dark");
    });
    it("확인한 항목이 바뀌면 일부만 복원하지 않고 거절한다", () => {
        const before = { ...defaultPrefs, theme: "dark" as const, fontSize: 20 };
        const latest = { ...before, fontSize: 17 };
        expect(() => restoredPrefs(latest, before, ["theme", "fontSize"])).toThrow("다시 비교");
        expect(latest).toEqual({ ...before, fontSize: 17 });
    });
    it("전체 복원도 입력 외의 ID·배치·다른 저장 key를 다루지 않는다", () => {
        const before = { ...defaultPrefs, theme: "soft" as const, reasoning: "expanded" as const, answerOnly: true, expandTools: true, enterToSend: true, fontSize: 20 };
        expect(restoredPrefs(before, before, Object.keys(defaultPrefs) as (keyof typeof defaultPrefs)[])).toEqual(defaultPrefs);
    });
});
