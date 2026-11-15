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
if (args[0] === "app-server" || args.includes("--input-format")) {
    for await (const line of createInterface({ input: process.stdin })) {
        const request = JSON.parse(line);
        if (provider === "claude") {
            emit({ type: "control_response", response: { request_id: request.request_id, subtype: "success",
                response: { models: [{ value: "fixture-claude", displayName: "Fixture Claude" }] } } });
            break;
        }
        if (request.method === "initialize") emit({ id: request.id, result: {} });
        if (request.method === "model/list") {
            emit({ id: request.id, result: { data: [
                { model: "fixture-codex", displayName: "Fixture Codex", isDefault: true, defaultReasoningEffort: "medium",
                    supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max", "ultra"].map((reasoningEffort) => ({ reasoningEffort })),
                    serviceTiers: [{ id: "priority", name: "Fast", description: "Faster processing, increased usage" }] },
                { model: "fixture-light", displayName: "Fixture Light",
                    supportedReasoningEfforts: ["low", "medium", "high"].map((reasoningEffort) => ({ reasoningEffort })), serviceTiers: [] },
            ] } });
            break;
        }
    }
    process.exit(0);
}
if (provider === "codex" && (!args.includes('sandbox_mode="workspace-write"') || !args.includes('approval_policy="never"')
    || !args.includes("sandbox_workspace_write.writable_roots=[]") || !args.includes("sandbox_workspace_write.network_access=false"))) {
    emit({ type: "turn.failed", error: { message: "fixture: workspace coding policy missing" } });
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
await writeFile(join(directory, "last-request.json"), JSON.stringify({ args, resume }));
emit({ type: "thread.started", thread_id: id });
const item = { id: "answer", type: "agent_message" };
if (input.includes("fixture-response-boundaries")) {
    emit({ type: "item.completed", item: { id: "reasoning", type: "reasoning", text: "링크 대상을 확인한다.\n" + "추론 내용을 생략하지 않고 표시한다.\n".repeat(120) } });
    emit({ type: "item.completed", item: { id: "progress", type: "agent_message", text: "심볼릭 링크인지, 실제로 어느 파일을 가리키는지 확인할게." } });
    emit({ type: "item.completed", item: { id: "tool", type: "command_execution", command: "readlink example", status: "completed", exit_code: 0 } });
    emit({ type: "item.started", item: { ...item, text: "" } });
    await new Promise((resolve) => {
        const watcher = watch(directory, (_event, name) => {
            if (name === `response-release-${process.pid}`) { watcher.close(); resolve(); }
        });
        writeFile(join(directory, `response-ready-${process.pid}`), "").catch((error) => { watcher.close(); throw error; });
    });
    emit({ type: "item.completed", item: { ...item, text: "맞아. 확인 결과 심볼릭 링크야." } });
    await new Promise((resolve) => {
        const watcher = watch(directory, (_event, name) => {
            if (name === `response-finish-${process.pid}`) { watcher.close(); resolve(); }
        });
        writeFile(join(directory, `response-answer-ready-${process.pid}`), "").catch((error) => { watcher.close(); throw error; });
    });
    emit({ type: "turn.completed", usage: { input_tokens: 10, output_tokens: 5 } });
    process.exit(0);
}
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
