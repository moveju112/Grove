#!/usr/bin/env node
// E2E 전용 CLI: 실제 child process·stdin·JSONL·resume·취소 경로를 쓰되 외부 모델은 호출하지 않는다.
import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { watch } from "node:fs";
import { basename, join } from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";

const args = process.argv.slice(2);
const directory = process.env.CLI_FIXTURE_DIR;
if (!directory) throw new Error("fixture directory missing");
const provider = basename(process.argv[1]) === "claude" ? "claude" : "codex";
const authPath = join(directory, `${provider}-auth`);
const authIndex = args[0] === "auth" ? 0 : args[0] === "--settings" ? args.indexOf("auth", 2) : -1;
if (authIndex >= 0 || args[0] === "login" || args[0] === "logout") {
    const action = provider === "claude" ? args[authIndex + 1] : args[0] === "logout" ? "logout" : args[1] === "status" ? "status" : "login";
    if (action === "status") {
        let authenticated = false;
        try { authenticated = (await readFile(authPath, "utf8")) === "in"; }
        catch (error) { if (error.code !== "ENOENT") throw error; }
        console.log(provider === "claude" ? JSON.stringify({ loggedIn: authenticated, authMethod: authenticated ? "claude.ai" : "none",
            apiProvider: "firstParty", subscriptionType: authenticated ? "max" : null, email: "must-not-be-returned@fixture.invalid" })
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
async function nativeSkills() {
    try { return JSON.parse(await readFile(join(process.cwd(), "native-skills.json"), "utf8"))[provider] ?? []; }
    catch (error) { if (error.code === "ENOENT") return []; throw error; }
}
async function nextAnswer(id) {
    const file = join(directory, `${id}.json`);
    let state;
    try { state = JSON.parse(await readFile(file, "utf8")); }
    catch (error) { if (error.code !== "ENOENT") throw error; state = { turns: 0 }; }
    state.turns++;
    await writeFile(file, JSON.stringify(state));
    await writeFile(join(directory, "last-pid"), String(process.pid));
    return `에이전트 답변 ${state.turns}`;
}
async function followupBoundary(text) {
    const marker = /fixture-followup-([0-9a-f-]{36})/.exec(text)?.[1];
    if (!marker) return;
    await new Promise((resolve, reject) => {
        const watcher = watch(directory, (_event, name) => {
            if (name === `followup-release-${marker}`) { watcher.close(); resolve(); }
        });
        writeFile(join(directory, `followup-ready-${marker}`), "").catch((error) => { watcher.close(); reject(error); });
    });
}
const responseReasoning = () => "링크 대상을 확인한다.\n" + "추론 내용을 생략하지 않고 표시한다.\n".repeat(120);
const responseProgress = "심볼릭 링크인지, 실제로 어느 파일을 가리키는지 확인할게.";
const responseAnswer = "맞아. 확인 결과 심볼릭 링크야.";
function scheduleAnswer(input) {
    if (!input.includes("fixture-schedule-")) return undefined;
    const action = /fixture-schedule-(read|write|denied|off)/.exec(input)?.[1];
    if (action === "off") return { answer: "예약 도구 꺼짐", tool: "", arguments_json: "" };
    if (input.includes('"role":"tool"')) {
        if (action === "read" && !input.includes("GROVE_SCHEDULE_FILE")) throw new Error("missing Grove read result");
        return { answer: "Grove 예약 완료", tool: "", arguments_json: "" };
    }
    const tool = action === "read" ? "read" : "write";
    return { answer: "", tool, arguments_json: JSON.stringify({ path: tool === "read" ? "cli-schedule-check.txt" : "cli-schedule-write.txt",
        ...(tool === "write" ? { content: "새 불필요 파일" } : {}) }) };
}
async function pauseResponse(signal, ready) {
    await new Promise((resolve, reject) => {
        const watcher = watch(directory, (_event, name) => {
            if (name === `${signal}-${process.pid}`) { watcher.close(); resolve(); }
        });
        writeFile(join(directory, `${ready}-${process.pid}`), "").catch((error) => { watcher.close(); reject(error); });
    });
}
async function claudeAnswer(input) {
    const session = args.indexOf("--session-id");
    const id = args.includes("--resume") ? args[args.indexOf("--resume") + 1] : session >= 0 ? args[session + 1] : randomUUID();
    await appendFile(join(directory, "native-turns.jsonl"), JSON.stringify({ provider, cwd: process.cwd(), text: input, args,
        pid: process.pid, threadId: id }) + "\n");
    const ordinary = await nextAnswer(id);
    const scheduled = scheduleAnswer(input);
    if (scheduled && (!args.includes("--safe-mode") || args.includes("--dangerously-skip-permissions")
        || !args.includes("--strict-mcp-config") || args[args.indexOf("--tools") + 1] !== "")) process.exit(1);
    const answer = scheduled?.answer ?? (input.includes("fixture-project-media")
        ? "결과를 첨부했어.\n\n```grove-media\npreview.gif\npreview.webm\n```"
        : ordinary);
    emit({ type: "system", subtype: "init", session_id: id });
    const context = /fixture-context-(\d+|unknown)/.exec(input)?.[1];
    const contextTokens = context === "unknown" ? 10_000 : Number(context) * 1_000;
    const usage = { input_tokens: contextTokens, output_tokens: 0 };
    if (context) emit({ type: "stream_event", event: { type: "message_start", message: { usage } } });
    await followupBoundary(input);
    emit({ type: "assistant", message: { content: [{ type: "text", text: answer }], ...(context ? { usage } : {}) } });
    emit({ type: "result", subtype: "success", session_id: id, result: answer,
        usage: context ? { input_tokens: 900_000, output_tokens: 100_000 } : { input_tokens: 10, output_tokens: 5 },
        ...(scheduled && args.includes("--json-schema") ? { structured_output: scheduled } : {}),
        ...(context ? { modelUsage: { fixture: { contextWindow: context === "unknown" ? null : 100_000 } } } : {}),
    });
}
if (args.includes("--version")) {
    console.log(provider === "claude" ? "2.1.328 (Claude Code)" : "codex-cli fixture");
    process.exit(0);
}
if (args[0] === "app-server" || args.includes("--input-format")) {
    let threadId;
    let activeTurn;
    let pendingQuestion;
    let usageReady = false;
    let claudeSession = false;
    for await (const line of createInterface({ input: process.stdin })) {
        const request = JSON.parse(line);
        if (provider === "claude") {
            if (request.request_id === "grove-usage" && request.request?.subtype === "initialize") {
                if ((await readFile(authPath, "utf8")) !== "in" || !args.includes("--safe-mode") || !args.includes("--no-session-persistence")
                    || args[args.indexOf("--max-turns") + 1] !== "0" || args[args.indexOf("--tools") + 1] !== "") process.exit(1);
                emit({ type: "control_response", response: { request_id: request.request_id, subtype: "success",
                    response: { commands: [{ name: "usage", builtin: true }] } } });
                usageReady = true;
                continue;
            }
            if (usageReady) {
                if (request.type !== "user" || request.message?.content?.[0]?.text !== "/usage") process.exit(1);
                await appendFile(join(directory, "claude-usage-requests"), "usage\n");
                emit({ type: "assistant", message: { content: [{ type: "text", text: "private-fixture-usage-output" }] }, usage_report: {
                    rate_limits: { limits: [
                        { kind: "session", percent: 12.5, resets_at: "2100-01-01T00:00:00Z" },
                        { kind: "weekly_all", percent: 70, resets_at: "2100-01-02T00:00:00Z" },
                        { kind: "weekly_scoped", percent: 88, scope: { model: { display_name: "Opus" } } },
                    ] },
                } });
                emit({ type: "result", subtype: "success", is_error: false, num_turns: 0, duration_api_ms: 0 });
                break;
            }
            if (request.type === "user") {
                await claudeAnswer(request.message.content.find((item) => item.type === "text")?.text ?? "");
                if (!claudeSession) break;
                continue;
            }
            if (request.request?.subtype === "mcp_set_servers") {
                emit({ type: "control_response", response: { request_id: request.request_id, subtype: "success",
                    response: { errors: {}, added: Object.keys(request.request.servers) } } });
                continue;
            }
            emit({ type: "control_response", response: { request_id: request.request_id, subtype: "success",
                response: { commands: await nativeSkills(), models: [
                    { value: "fixture-claude", displayName: "Fixture Claude" },
                    { value: "opus", resolvedModel: "claude-opus-5-5", displayName: "Opus" },
                ] } } });
            claudeSession = args.includes("--session-id") || args.includes("--resume");
            if (!claudeSession) break;
            continue;
        }
        await appendFile(join(directory, "app-server-requests.jsonl"), JSON.stringify(request) + "\n");
        if (pendingQuestion && request.id === pendingQuestion.id && !request.method) {
            const { turnId, id } = pendingQuestion;
            pendingQuestion = undefined;
            const reply = request.result?.answers;
            if (reply?.action?.answers?.[0] !== "적용" || reply?.extra?.answers?.length !== 0) {
                throw new Error(`unexpected response to ${id}`);
            }
            await writeFile(join(process.cwd(), "snapshot-edit.txt"), "CLI 수정\n");
            await writeFile(join(process.cwd(), "snapshot-new.txt"), "CLI 새 파일\n", { mode: 0o755 });
            emit({ method: "serverRequest/resolved", params: { threadId, requestId: id } });
            emit({ method: "item/completed", params: { threadId, turnId, item: { type: "commandExecution", id: "active-check", status: "completed" } } });
            emit({ method: "item/completed", params: { threadId, turnId, item: { type: "agentMessage", id: "answer", text: "질문 답변 확인" } } });
            emit({ method: "turn/completed", params: { threadId, turn: { id: turnId, status: "completed", items: [] } } });
        }
        if (request.method === "initialize") emit({ id: request.id, result: {} });
        if (request.method === "account/rateLimits/read") {
            emit({ id: request.id, result: {
                accountId: "private-fixture-account",
                rateLimits: {
                    primary: { usedPercent: 18, windowDurationMins: 300, resetsAt: 4102444800 },
                    secondary: { usedPercent: 61, windowDurationMins: 10080, resetsAt: 4102444800 },
                },
            } });
            break;
        }
        if (request.method === "skills/list") {
            emit({ id: request.id, result: { data: [{ cwd: process.cwd(), skills: await nativeSkills(), errors: [] }] } });
        }
        if (request.method === "thread/start" || request.method === "thread/resume") {
            threadId = request.params.threadId ?? randomUUID();
            emit({ id: request.id, result: { thread: { id: threadId } } });
        }
        if (request.method === "thread/unsubscribe") {
            threadId = undefined;
            activeTurn = undefined;
            emit({ id: request.id, result: { status: "unsubscribed" } });
        }
        if (request.method === "turn/steer") {
            if (!activeTurn || request.params.threadId !== threadId || request.params.expectedTurnId !== activeTurn.turnId) {
                emit({ id: request.id, error: { code: -32602, message: "fixture active turn mismatch" } });
                continue;
            }
            if (activeTurn.text.includes("fixture-steer-ack-hold")) {
                const marker = /fixture-followup-([0-9a-f-]{36})/.exec(activeTurn.text)[1];
                await new Promise((resolve, reject) => {
                    const watcher = watch(directory, (_event, name) => {
                        if (name === `steer-ack-release-${marker}`) { watcher.close(); resolve(); }
                    });
                    writeFile(join(directory, `steer-ack-ready-${marker}`), "").catch((error) => { watcher.close(); reject(error); });
                });
            }
            emit({ id: request.id, result: { turnId: activeTurn.turnId } });
            if (activeTurn.text.includes("fixture-steer-timeline")) {
                emit({ method: "item/completed", params: { threadId, turnId: activeTurn.turnId, item: { type: "agentMessage", id: "after-1", text: "합친 뒤 첫 확인." } } });
                emit({ method: "item/completed", params: { threadId, turnId: activeTurn.turnId, item: { type: "agentMessage", id: "after-2", text: "합친 뒤 두 번째 확인." } } });
                emit({ method: "item/started", params: { threadId, turnId: activeTurn.turnId, item: { type: "agentMessage", id: "answer", text: "" } } });
            }
            continue;
        }
        if (request.method === "turn/start") {
            await appendFile(join(directory, "native-turns.jsonl"), JSON.stringify({ provider, cwd: process.cwd(), ...request.params }) + "\n");
            const answer = await nextAnswer(threadId);
            const text = request.params.input.find((item) => item.type === "text")?.text ?? "";
            const turnId = randomUUID();
            emit({ id: request.id, result: { turn: { id: turnId } } });
            emit({ method: "turn/started", params: { threadId, turn: { id: turnId, status: "inProgress", items: [] } } });
            if (text.endsWith("fixture-native-question")) {
                const id = `question-${turnId}`;
                pendingQuestion = { id, turnId };
                emit({ method: "item/started", params: { threadId, turnId, item: {
                    type: "commandExecution", id: "active-check", status: "inProgress", command: "fixture raw command",
                } } });
                emit({ id, method: "item/tool/requestUserInput", params: { threadId, turnId, itemId: "questions", questions: [
                    { id: "action", header: "작업", question: "수정을 적용할까요?", options: [{ label: "적용", description: "파일을 수정" }] },
                    { id: "extra", header: "메모", question: "메모를 추가할까요?", options: null },
                ] } });
                continue;
            }
            const context = /fixture-context-(\d+|unknown)/.exec(text)?.[1];
            if (context) emit({ method: "thread/tokenUsage/updated", params: { threadId, turnId, tokenUsage: {
                total: { inputTokens: 900_000, outputTokens: 100_000 },
                last: { totalTokens: context === "unknown" ? 10_000 : Number(context) * 1_000 },
                modelContextWindow: context === "unknown" ? null : 100_000,
            } } });
            if (text.includes("fixture-generated-images")) {
                let images = JSON.parse(await readFile(join(process.cwd(), "native-generated-images.json"), "utf8"));
                const toolOutput = text.includes("fixture-generated-images-tools");
                const cacheOutput = text.includes("fixture-generated-images-cache");
                if (toolOutput || cacheOutput) {
                    const outputDirectory = cacheOutput ? process.env.AGENTS_IMAGE_CACHE : process.cwd();
                    await mkdir(outputDirectory, { recursive: true });
                    const path = join(outputDirectory, `${turnId}.한글 preview.png`);
                    await writeFile(path, Buffer.from(images[2].result, "base64"));
                    images = [
                        { id: "mcp-image", type: "mcpToolCall", server: "fixture", tool: "render", arguments: {}, status: "completed",
                            result: { content: [{ type: "image", mimeType: "image/png", data: images[0].result }] } },
                        { id: "dynamic-image", type: "dynamicToolCall", tool: "exec", arguments: {}, status: "completed", success: true,
                            contentItems: [{ type: "inputImage", imageUrl: `data:image/png;base64,${images[1].result}` }] },
                        { id: "view-image", type: "imageView", path: pathToFileURL(path).href },
                    ];
                    emit({ method: "item/started", params: { threadId, turnId, item: images[2] } });
                    if (cacheOutput) images.push({ ...images[2], id: "same-cache-again" });
                }
                for (const item of images) emit({ method: "item/completed", params: { threadId, turnId, item } });
                const final = { id: "answer", type: "agentMessage", text: toolOutput || cacheOutput ? "시안을 다시 보여줄게." : "시안 두 개를 만들었어." };
                emit({ method: "item/completed", params: { threadId, turnId, item: final } });
                // 완료 snapshot에 같은 이미지가 다시 와도 중복 첨부하지 않는다.
                emit({ method: "turn/completed", params: { threadId, turn: { id: turnId, status: "completed", items: [...images, final] } } });
                continue;
            }
            if (text.includes("fixture-followup-")) {
                const active = { turnId, text };
                activeTurn = active;
                if (text.includes("fixture-steer-timeline")) {
                    emit({ method: "item/completed", params: { threadId, turnId, item: { type: "agentMessage", id: "before-1", text: "합치기 전 첫 확인." } } });
                    emit({ method: "item/completed", params: { threadId, turnId, item: { type: "agentMessage", id: "before-2", text: "합치기 전 두 번째 확인." } } });
                }
                // 실행 완료를 기다리는 동안에도 stdio 입력을 받아 native steer를 처리한다.
                void followupBoundary(text).then(() => {
                    if (activeTurn !== active) return;
                    emit({ method: "item/agentMessage/delta", params: { threadId, turnId, itemId: "answer", delta: answer } });
                    emit({ method: "item/completed", params: { threadId, turnId, item: { id: "answer", type: "agentMessage", text: answer } } });
                    emit({ method: "turn/completed", params: { threadId, turn: { id: turnId, status: "completed", items: [] } } });
                    activeTurn = undefined;
                });
                continue;
            }
            if (text.includes("fixture-hold")) {
                emit({ method: "item/agentMessage/delta", params: { threadId, turnId, itemId: "answer", delta: "중단 대기 중" } });
                await new Promise(() => {});
            }
            await followupBoundary(text);
            if (text.includes("fixture-response-boundaries")) {
                emit({ method: "item/reasoning/summaryTextDelta", params: {
                    threadId, turnId, itemId: "reasoning", summaryIndex: 0, delta: responseReasoning(),
                } });
                emit({ method: "item/completed", params: { threadId, turnId, item: {
                    id: "progress", type: "agentMessage", text: responseProgress,
                } } });
                emit({ method: "item/started", params: { threadId, turnId, item: { id: "answer", type: "agentMessage", text: "" } } });
                await pauseResponse("response-release", "response-ready");
                emit({ method: "item/completed", params: { threadId, turnId, item: { id: "answer", type: "agentMessage", text: responseAnswer } } });
                await pauseResponse("response-finish", "response-answer-ready");
                emit({ method: "turn/completed", params: { threadId, turn: { id: turnId, status: "completed", items: [] } } });
                continue;
            }
            if (text.includes("fixture-progress-numbering")) {
                const progress = [
                    "`example.test`로 설정할게.\n\n연결 설정을 확인할게.",
                    "DNS 연결을 확인했어.\n서버 설치도 끝났어.",
                    "인증 테스트가 통과했어.\n\n```text\ncheck: ok\n```",
                    "빌드와 의존성 점검이 끝났어.",
                ];
                for (const [index, body] of progress.entries()) {
                    emit({ method: "item/completed", params: { threadId, turnId, item: { id: `progress-${index}`, type: "agentMessage", text: body } } });
                }
                emit({ method: "item/started", params: { threadId, turnId, item: { id: "answer", type: "agentMessage", text: "" } } });
                await new Promise((resolve) => {
                    const watcher = watch(directory, (_event, name) => {
                        if (name === `progress-numbering-release-${process.pid}`) { watcher.close(); resolve(); }
                    });
                    writeFile(join(directory, `progress-numbering-ready-${process.pid}`), "").catch((error) => { watcher.close(); throw error; });
                });
                emit({ method: "item/completed", params: { threadId, turnId, item: { id: "answer", type: "agentMessage", text: "설정을 마쳤어." } } });
                emit({ method: "turn/completed", params: { threadId, turn: { id: turnId, status: "completed", items: [] } } });
                continue;
            }
            emit({ method: "item/agentMessage/delta", params: { threadId, turnId, itemId: "answer", delta: answer } });
            emit({ method: "item/completed", params: { threadId, turnId, item: { id: "answer", type: "agentMessage", text: answer } } });
            emit({ method: "turn/completed", params: { threadId, turn: { id: turnId, status: "completed", items: [] } } });
        }
        if (request.method === "model/list") {
            emit({ id: request.id, result: { data: [
                { model: "fixture-codex", displayName: "Fixture Codex", isDefault: true, defaultReasoningEffort: "medium",
                    supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max", "ultra"].map((reasoningEffort) => ({ reasoningEffort })),
                    serviceTiers: [{ id: "priority", name: "Fast", description: "Faster processing, increased usage" }] },
                { model: "fixture-light", displayName: "Fixture Light",
                    supportedReasoningEfforts: ["low", "medium", "high"].map((reasoningEffort) => ({ reasoningEffort })), serviceTiers: [] },
                { model: "gpt-5.6", displayName: "GPT-5.6" },
                { model: "gpt-6.1", displayName: "GPT-6.1" },
                { model: "gpt-5.10", displayName: "GPT-5.10" },
            ] } });
            break;
        }
    }
    process.exit(0);
}
if (provider === "claude") {
    let input = "";
    for await (const bytes of process.stdin) input += bytes.toString();
    await claudeAnswer(input);
    process.exit(0);
}
let input = "";
for await (const bytes of process.stdin) input += bytes.toString();
const scheduled = scheduleAnswer(input);
const restricted = args.includes("--ephemeral");
if (restricted ? !args.includes("--ignore-user-config") || args.includes("--dangerously-bypass-approvals-and-sandbox")
    || args[args.indexOf("--sandbox") + 1] !== "read-only" : !args.includes("--dangerously-bypass-approvals-and-sandbox")) {
    emit({ type: "turn.failed", error: { message: "fixture: wrong coding policy" } });
    process.exit(1);
}
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
    emit({ type: "item.completed", item: { id: "reasoning", type: "reasoning", text: responseReasoning() } });
    emit({ type: "item.completed", item: { id: "progress", type: "agent_message", text: responseProgress } });
    emit({ type: "item.completed", item: { id: "tool", type: "command_execution", command: "readlink example", status: "completed", exit_code: 0 } });
    emit({ type: "item.started", item: { ...item, text: "" } });
    await pauseResponse("response-release", "response-ready");
    emit({ type: "item.completed", item: { ...item, text: responseAnswer } });
    await pauseResponse("response-finish", "response-answer-ready");
    emit({ type: "turn.completed", usage: { input_tokens: 10, output_tokens: 5 } });
    process.exit(0);
}
emit({ type: "item.started", item: { ...item, text: "" } });
if (input.includes("fixture-hold")) {
    emit({ type: "item.updated", item: { ...item, text: "중단 대기 중" } });
    setInterval(() => {}, 60_000);
} else {
    const text = scheduled ? args.includes("--output-schema") ? JSON.stringify(scheduled) : scheduled.answer : `에이전트 답변 ${state.turns}`;
    emit({ type: "item.updated", item: { ...item, text: "에이전트" } });
    emit({ type: "item.completed", item: { ...item, text } });
    emit({ type: "turn.completed", usage: { input_tokens: 10, output_tokens: 5 } });
}
