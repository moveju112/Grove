// 로컬 OpenAI 호환 모델 fixture(재현용, 실제 모델 품질 증거 아님).
// POST /script 로 다음 응답 대본을 넣고, /v1/chat/completions가 순서대로 소비한다.
import { createServer, type Server } from "node:http";

// marker가 있으면 요청 본문에 그 문자열이 있을 때만 쓴다(동시에 도는 부모·자식 턴 구분).
type Step = { frames: string[]; delayMs?: number; hang?: boolean; marker?: string };

export async function startFixture(port: number): Promise<{ close: () => void }> {
    const script: Step[] = [];
    const requests: unknown[] = [];
    const server: Server = createServer((req, res) => {
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", async () => {
            if (req.url === "/script") {
                script.push(JSON.parse(body) as Step);
                res.end("ok");
                return;
            }
            if (req.url === "/requests") {
                res.setHeader("content-type", "application/json");
                res.end(JSON.stringify(requests));
                return;
            }
            // 연결 확인(AUTH-001): 모델 목록 조회는 대본·요청 기록에 넣지 않는다(생성 요청이 아님).
            if (req.method === "GET" && req.url?.endsWith("/models")) {
                res.setHeader("content-type", "application/json");
                res.end(JSON.stringify({ data: [{ id: "fixture-model" }] }));
                return;
            }
            requests.push(JSON.parse(body || "null"));
            let idx = script.findIndex((s) => s.marker !== undefined && body.includes(s.marker));
            if (idx < 0) idx = script.findIndex((s) => s.marker === undefined);
            const step = idx >= 0 ? script.splice(idx, 1)[0] : undefined;
            if (!step) {
                res.statusCode = 500;
                res.end(JSON.stringify({ error: { message: "script exhausted" } }));
                return;
            }
            res.setHeader("content-type", "text/event-stream");
            for (const f of step.frames) {
                if (step.delayMs) await new Promise((r) => setTimeout(r, step.delayMs));
                res.write(`data: ${f}\n\n`);
            }
            if (!step.hang) res.end();
        });
    });
    await new Promise<void>((r) => server.listen(port, "127.0.0.1", () => r()));
    return { close: () => server.close() };
}

export const frames = {
    reasoning(reasoning: string, answer: string): string[] {
        return [
            JSON.stringify({ choices: [{ delta: { reasoning_content: reasoning } }] }),
            JSON.stringify({ choices: [{ delta: { content: answer } }] }),
            JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] }),
            "[DONE]",
        ];
    },
    text(parts: string[]): string[] {
        return [
            ...parts.map((p) => JSON.stringify({ choices: [{ delta: { content: p } }] })),
            JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] }),
            "[DONE]",
        ];
    },
    tool(id: string, name: string, args: unknown): string[] {
        return [
            JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id, type: "function", function: { name, arguments: JSON.stringify(args) } }] } }] }),
            JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }),
            "[DONE]",
        ];
    },
};
