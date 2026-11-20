import { expect, test } from "@playwright/test";
import { mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { apiCall, state } from "./helpers";

test.skip(process.env.GROVE_E2E_FAKE_CLI !== "1", "전용 CLI fixture로 실행: GROVE_E2E_FAKE_CLI=1");

test("Claude와 Codex를 왕복해도 최신 Grove 이력이 이어지고 연속 턴은 CLI를 재개한다", async () => {
    const root = mkdtempSync(join(state().projA, "cli-history-switch-"));
    const project = await apiCall<{ id: string }>("POST", "/projects", { root_path: root });
    const claude = await apiCall<{ id: string }>("POST", "/agent-backends/claude_code/connect");
    const codex = await apiCall<{ id: string }>("POST", "/agent-backends/codex_cli/connect");
    const session = await apiCall<{ id: string }>("POST", `/projects/${project.id}/sessions`, { title: "CLI history switch" });
    const path = `/sessions/${session.id}`;
    const prompts = ["claude initial", "claude consecutive", "codex first switch", "claude return", "codex return", "codex consecutive"];
    const profiles = [claude, claude, codex, claude, codex, codex];
    for (const [i, text] of prompts.entries()) {
        const { turn } = await apiCall<{ turn: { id: string } }>("POST", `${path}/turns`, {
            text, profile_id: profiles[i]!.id, tools: false,
        });
        await expect.poll(async () => (await apiCall<{ status: string }>("GET", `/turns/${turn.id}`)).status).toBe("completed");
    }

    type Wire = { cwd: string; provider: string; threadId: string; text?: string; input?: { text: string }[] };
    const calls = readFileSync(join(state().cliDir!, "native-turns.jsonl"), "utf8").trim().split("\n")
        .map((line) => JSON.parse(line) as Wire).filter((call) => call.cwd === root);
    expect(calls.map((call) => call.provider)).toEqual(["claude", "claude", "codex", "claude", "codex", "codex"]);
    const texts = calls.map((call) => call.text ?? call.input![0]!.text);
    expect(calls[1]!.threadId).toBe(calls[0]!.threadId);
    expect(texts[1]).toBe(prompts[1]);
    expect(calls[3]!.threadId).not.toBe(calls[0]!.threadId);
    expect(calls[4]!.threadId).not.toBe(calls[2]!.threadId);
    expect(calls[5]!.threadId).toBe(calls[4]!.threadId);
    expect(texts[5]).toBe(prompts[5]);

    for (const i of [2, 3, 4]) {
        const text = texts[i]!;
        const history = text.split("<previous_conversation>\n")[1]!.split("\n</previous_conversation>")[0]!;
        expect(history.split("\n").map((line) => JSON.parse(line))).toEqual(prompts.slice(0, i).flatMap((earlier, index) => [
            { role: "user", text: earlier },
            { role: "assistant", text: `에이전트 답변 ${index === 1 ? 2 : 1}` },
        ]));
        expect(text.endsWith(`</previous_conversation>\n\n${prompts[i]}`)).toBe(true);
    }
});
