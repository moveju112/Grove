#!/usr/bin/env node
// E2E 전용 CLI: 실제 child process·stdin·JSONL·resume·취소 경로를 쓰되 외부 모델은 호출하지 않는다.
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { watch } from "node:fs";
import { basename, join } from "node:path";
import { createInterface } from "node:readline";

const args = process.argv.slice(2);
const directory = process.env.CLI_FIXTURE_DIR;
if (!directory) throw new Error("fixture directory missing");
const provider = basename(process.argv[1]) === "claude" ? "claude" : "codex";
const authPath = join(directory, `${provider}-auth`);
if (args[0] === "auth" || args[0] === "login" || args[0] === "logout") {
    const action = provider === "claude" ? args[1] : args[0] === "logout" ? "logout" : args[1] === "status" ? "status" : "login";
    if (action === "status") {
        let authenticated = false;
        try { authenticated = (await readFile(authPath, "utf8")) === "in"; }
        catch (error) { if (error.code !== "ENOENT") throw error; }
        console.log(provider === "claude" ? JSON.stringify({ loggedIn: authenticated, email: "must-not-be-returned@fixture.invalid" })
            : authenticated ? "Logged in using ChatGPT" : "Not logged in");
        process.exit(authenticated ? 0 : 1);
    }
    if (action === "logout") {
        await writeFile(authPath, "out");
        process.exit(0);
    }
    await writeFile(join(directory, `${provider}-login-pid`), String(process.pid));
    await writeFile(join(directory, `${provider}-login-start`), String(Date.now()));
    if (provider === "codex") {
        console.log("https://auth.openai.com/codex/device\nABCD-12345\n");
        await new Promise((resolve) => {
            const watcher = watch(directory, (_event, name) => {
                if (name === "approve-codex") { watcher.close(); resolve(); }
            });
        });
    } else {
        console.log("https://claude.com/cai/oauth/authorize?state=fixture\nPaste code here if prompted >");
        for await (const line of createInterface({ input: process.stdin })) {
            if (line !== "fixture-code") { console.error("private-provider-error"); process.exit(1); }
            break;
        }
    }
    await writeFile(authPath, "in");
    process.exit(0);
}
const emit = (event) => process.stdout.write(JSON.stringify(event) + "\n");
if (args.includes("--version")) {
    console.log("codex-cli fixture");
    process.exit(0);
}
if (!args.includes('sandbox_mode="read-only"') || !args.includes('approval_policy="never"')) {
    emit({ type: "turn.failed", error: { message: "fixture: read-only policy missing" } });
    process.exit(1);
}
let input = "";
for await (const bytes of process.stdin) input += bytes.toString();
const resume = args.includes("resume");
const id = resume ? args.at(-2) : randomUUID();
if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error("fixture session ID invalid");
const path = join(directory, id + ".json");
const state = resume ? JSON.parse(await readFile(path, "utf8")) : { turns: 0 };
state.turns++;
await writeFile(path, JSON.stringify(state));
await writeFile(join(directory, "last-pid"), String(process.pid));
emit({ type: "thread.started", thread_id: id });
const item = { id: "answer", type: "agent_message" };
emit({ type: "item.started", item: { ...item, text: "" } });
if (input.includes("fixture-hold")) {
    emit({ type: "item.updated", item: { ...item, text: "중단 대기 중" } });
    setInterval(() => {}, 60_000);
} else {
    const text = `에이전트 답변 ${state.turns}`;
    emit({ type: "item.updated", item: { ...item, text: "에이전트" } });
    emit({ type: "item.completed", item: { ...item, text } });
    emit({ type: "turn.completed", usage: { input_tokens: 10, output_tokens: 5 } });
}
