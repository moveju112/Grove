import { describe, expect, it } from "vitest";
import { parseSlash, suggest } from "./slash";

const names = ["compact", "fork", "tools", "model"];
const cmds = names.map((name) => ({ name, description: `${name} 설명` }));

describe("slash commands", () => {
    it("separates commands, unknown commands and text", () => {
        expect(parseSlash("/compact", names)).toEqual({ kind: "command", name: "compact", arg: "" });
        expect(parseSlash("/Fork  history ", names)).toEqual({ kind: "command", name: "fork", arg: "history" });
        expect(parseSlash("/model 작은 모델\n둘째 줄", names)).toEqual({ kind: "command", name: "model", arg: "작은 모델\n둘째 줄" });
        expect(parseSlash("/compactx", names)).toEqual({ kind: "unknown", name: "compactx" });
        expect(parseSlash("//compact 는 명령이 아니다", names)).toEqual({ kind: "text", text: "/compact 는 명령이 아니다" });
        expect(parseSlash("경로 /usr/bin 은 글", names)).toEqual({ kind: "text", text: "경로 /usr/bin 은 글" });
        expect(parseSlash("/usr/bin/env", names)).toEqual({ kind: "text", text: "/usr/bin/env" });
        expect(parseSlash("그냥 글", names)).toEqual({ kind: "text", text: "그냥 글" });
    });

    it("suggests by prefix before the first space", () => {
        expect(suggest("/", cmds).map((c) => c.name)).toEqual(names);
        expect(suggest("/co", cmds).map((c) => c.name)).toEqual(["compact"]);
        expect(suggest("/od", cmds).map((c) => c.name)).toEqual(["model"]);
        expect(suggest("/compact ", cmds)).toEqual([]);
        expect(suggest("글 /co", cmds)).toEqual([]);
    });
});
