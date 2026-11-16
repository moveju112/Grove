import { describe, expect, it } from "vitest";
import { cliActivitySummary, type CliActivity } from "./cli-activity";

describe("CLI 도구 요약", () => {
    it("같은 도구의 호출을 이름별 횟수로 묶고 원본 기록을 변경하지 않는다", () => {
        const items = Array.from({ length: 21 }, (_, index) => Object.freeze({
            kind: "command", name: "shell", input: `command-${index}`, status: "completed", exit_code: 0,
        }));
        expect(cliActivitySummary(Object.freeze(items))).toBe("CLI 도구 21회 · shell 21회");
        expect(items.map((item) => item.input)).toEqual(Array.from({ length: 21 }, (_, index) => `command-${index}`));
    });
    it("이름의 첫 등장 순서와 도구별 호출 수를 보존한다", () => {
        expect(cliActivitySummary([
            { kind: "tool", name: "Read" }, { kind: "command", name: "shell" }, { kind: "tool", name: "Read" },
        ])).toBe("CLI 도구 3회 · Read 2회, shell 1회");
    });
    it("긴 목록은 접어도 거부·실패·비정상 종료를 제목에 남긴다", () => {
        const items: CliActivity[] = [
            { kind: "tool", name: "Read" }, { kind: "tool", name: "Write" }, { kind: "tool", name: "Edit" },
            { kind: "denied", name: "shell" },
            { kind: "command", name: "shell", status: "completed", exit_code: 2 },
            { kind: "file_change", name: "file_change", status: "failed" },
        ];
        expect(cliActivitySummary(items)).toBe("CLI 도구 6회 · Read 1회, Write 1회, Edit 1회, 외 2종 · 거부 1회 · 실패 2회");
    });
    it("빈 기록이나 미확정 종료를 실패로 추정하지 않는다", () => {
        expect(cliActivitySummary([])).toBe("CLI 도구 0회");
        expect(cliActivitySummary([{ kind: "command", name: "shell", status: "in_progress", exit_code: null }]))
            .toBe("CLI 도구 1회 · shell 1회");
    });
});
