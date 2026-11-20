import { expect, test } from "@playwright/test";
import { mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { apiCall, state } from "./helpers";
import type { Turn } from "../app/api/generated";

test.skip(process.env.GROVE_E2E_FAKE_CLI !== "1", "격리된 CLI fixture로 검사");

test("Claude와 Codex를 전환하면 이력을 넘기고, 같은 CLI가 이어지면 재개한다", async () => {
    const root = mkdtempSync(join(state().projA, "cli-handoff-"));
    const project = await apiCall<{ id: string }>("POST", "/projects", { root_path: root });
    const session = await apiCall<{ id: string }>("POST", `/projects/${project.id}/sessions`, { title: "CLI handoff" });
    const profile = (protocol: string) => apiCall<{ id: string }>("POST", "/model-profiles", {
        name: `handoff-${protocol}`, protocol, base_url: "", model: "default",
    });
    const claude = await profile("claude_code");
    const codex = await profile("codex_cli");
    const send = async (id: string, text: string) => {
        const { turn } = await apiCall<{ turn: Turn }>("POST", `/sessions/${session.id}/turns`, { profile_id: id, text });
        await expect.poll(async () => (await apiCall<Turn>("GET", `/turns/${turn.id}`)).status).toBe("completed");
    };
    await send(claude.id, "첫 질문");
    await send(codex.id, "코덱스에게 전달한 정보");
    await send(claude.id, "전달한 정보가 뭐였지?");
    await send(claude.id, "바로 이어서 확인해 줘");

    const calls = readFileSync(join(state().cliDir!, "native-turns.jsonl"), "utf8").trim().split("\n")
        .map((line) => JSON.parse(line)).filter((item) => item.cwd === root);
    expect(calls.map((item) => item.provider)).toEqual(["claude", "codex", "claude", "claude"]);
    expect(calls[1].input[0].text).toContain('"text":"첫 질문"');
    expect(calls[2].threadId).not.toBe(calls[0].threadId);
    expect(calls[2].text).toContain('{"role":"user","text":"코덱스에게 전달한 정보"}\n{"role":"assistant","text":"에이전트 답변 1"}');
    expect(calls[2].text).toMatch(/<\/previous_conversation>\n\n전달한 정보가 뭐였지\?$/);
    expect(calls[3].threadId).toBe(calls[2].threadId);
    expect(calls[3].text).toBe("바로 이어서 확인해 줘");
});
