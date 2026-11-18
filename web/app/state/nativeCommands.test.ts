import { describe, expect, it } from "vitest";
import { nativeSlashCommands } from "./nativeCommands";
import { parseSlash, suggest } from "./slash";
import { modelOptionCapabilities, sendOptionsSignature } from "./sendOptions";

describe("네이티브 CLI 명령", () => {
    it("Grove 명령과 중첩 namespace가 충돌해도 별도 식별자를 유지한다", () => {
        const local = [{ name: "model", description: "Grove profile" }];
        const commands = nativeSlashCommands([
            { id: "one", name: "model", description: "CLI model", argument_hint: "model" },
            { id: "two", name: "cli:model", description: "Plugin", argument_hint: "" },
            { id: "three", name: "review", description: "Review", argument_hint: "file" },
        ], local);
        expect(commands.map((command) => [command.name, command.nativeId])).toEqual([
            ["cli:model", "one"], ["cli:cli:model", "two"], ["review", "three"],
        ]);
        expect(parseSlash("/review file.rs", commands.map((command) => command.name))).toEqual({ kind: "command", name: "review", arg: "file.rs" });
        expect(suggest("/rev", commands).map((command) => command.name)).toEqual(["review"]);
    });
    it("다른 CLI의 목록을 합치지 않고 조회한 현재 목록만 제안한다", () => {
        expect(nativeSlashCommands([], [])).toEqual([]);
        expect(parseSlash("//review literal", [])).toEqual({ kind: "text", text: "/review literal" });
    });
    it("CLI 원래 이름의 대소문자를 유지하면서 자동완성은 대소문자 없이 찾는다", () => {
        const commands = nativeSlashCommands([{ id: "upper", name: "Inspect", description: "Find Issues", argument_hint: "" }], []);
        expect(suggest("/ins", commands).map((command) => command.name)).toEqual(["Inspect"]);
        expect(suggest("/issues", commands).map((command) => command.name)).toEqual(["Inspect"]);
    });
    it("네이티브 선택은 전송 서명과 기능 협상에 포함한다", () => {
        const options = { mode: "model" as const, profileId: "p", agentId: null, tools: false };
        const selected = { ...options, nativeCommand: `cmd_${"a".repeat(64)}` };
        expect(sendOptionsSignature(selected, [])).not.toBe(sendOptionsSignature(options, []));
        expect(modelOptionCapabilities(selected)).toContain("native_skills_v1");
    });
});
