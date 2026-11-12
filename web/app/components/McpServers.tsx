import { useRef, useState } from "react";
import { ApiError, api, newKey } from "../api/client";
import { useQuery } from "../state/store";

type Config =
    | { transport: "stdio"; command: string; args: string[]; env_secrets: Record<string, string> }
    | { transport: "http" | "sse"; endpoint: string; header_secrets: Record<string, string> };
type Server = {
    id: string; name: string; config: Config; enabled: boolean; timeout_secs: number; revision: number;
    connection_state: "disabled" | "disconnected";
};
type Attempt = { method: "post" | "put" | "del"; path: string; body?: unknown; key: string };
type Mutation = { phase: "idle" } | { phase: "sending" | "unknown"; attempt: Attempt };
const example = JSON.stringify({ transport: "stdio", command: "mcp-server", args: [], env_secrets: {} }, null, 2);

export function McpServers() {
    const query = useQuery<Server[]>("mcp", () => api.get("/mcp/servers", { requires: ["mcp_settings_v1"] }));
    const secrets = useQuery<{ id: string; label: string }[]>("secrets", () => api.get("/secrets"));
    const [editing, setEditing] = useState<Server | null>(null);
    const [deleting, setDeleting] = useState<Server | null>(null);
    const [name, setName] = useState("");
    const [config, setConfig] = useState(example);
    const [timeout, setTimeout] = useState(60);
    const [enabled, setEnabled] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [mutation, setMutation] = useState<Mutation>({ phase: "idle" });
    const sending = useRef(false);
    const blocked = mutation.phase !== "idle";
    const reset = () => {
        setEditing(null); setDeleting(null); setName(""); setConfig(example); setTimeout(60); setEnabled(false);
    };
    const mutate = async (attempt: Attempt) => {
        if (sending.current) return;
        sending.current = true;
        setMutation({ phase: "sending", attempt });
        setError(null);
        try {
            const options = { key: attempt.key, requires: ["mcp_settings_v1"] };
            if (attempt.method === "del") await api.del(attempt.path, options);
            else await api[attempt.method](attempt.path, attempt.body, options);
            setMutation({ phase: "idle" });
            reset();
        } catch (e) {
            const unknown = !(e instanceof ApiError) || e.status >= 500 || e.status === 408
                || (e.details as { result_unknown?: boolean } | undefined)?.result_unknown === true;
            setMutation(unknown ? { phase: "unknown", attempt } : { phase: "idle" });
            setError(e instanceof Error ? e.message : "MCP 설정 요청 실패");
        } finally {
            sending.current = false;
            query.reload();
        }
    };
    const submit = () => {
        try {
            const server = { name, config: JSON.parse(config) as Config, timeout_secs: timeout, enabled };
            void mutate({
                method: editing ? "put" : "post", path: editing ? `/mcp/servers/${editing.id}` : "/mcp/servers", key: newKey(),
                body: editing ? { expected_revision: editing.revision, server } : server,
            });
        } catch {
            setError("MCP 설정 JSON 형식이 올바르지 않습니다");
        }
    };
    const edit = (server: Server) => {
        setEditing(server); setDeleting(null); setName(server.name);
        setConfig(JSON.stringify(server.config, null, 2)); setTimeout(server.timeout_secs); setEnabled(server.enabled); setError(null);
    };
    const current = query.data?.find((s) => s.id === editing?.id);
    return <div className="stack" data-testid="mcp-panel">
        <p className="muted small">서버 전체 설정이며 소유자만 관리할 수 있습니다. 저장·사용 설정은 연결 완료가 아닙니다. 현재 이 화면은 연결하거나 프로세스를 실행하지 않습니다.</p>
        <p className="muted small">비밀 원문을 실행 인자·URL·JSON에 넣지 마세요. 환경변수는 env_secrets, 헤더는 header_secrets에 API 키의 ID를 참조하세요. 헤더 secret에는 필요한 접두사(예: Bearer)까지 저장하세요.</p>
        {!!query.error && <p role="alert" className="err">{query.error instanceof Error ? query.error.message : "MCP 조회 실패"}</p>}
        <ul>{(query.data ?? []).map((server) => <li key={server.id} data-testid="mcp-row">
            <strong>{server.name}</strong> · {server.config.transport} · {server.enabled ? "사용 설정 · 미연결" : "사용 안 함"} · revision {server.revision}
            <div className="inline">
                <button type="button" disabled={blocked || !!editing || !!deleting || !!name} onClick={() => edit(server)}>MCP 편집</button>
                <button type="button" disabled={blocked || !!editing || !!deleting || !!name} onClick={() => void mutate({
                    method: "put", path: `/mcp/servers/${server.id}`, key: newKey(),
                    body: { expected_revision: server.revision, server: { name: server.name, config: server.config, timeout_secs: server.timeout_secs, enabled: !server.enabled } },
                })}>{server.enabled ? "MCP 사용 끄기" : "MCP 사용 켜기"}</button>
                <button type="button" disabled={blocked || !!editing || !!deleting || !!name} onClick={() => { setDeleting(server); setError(null); }}>MCP 삭제 확인</button>
            </div>
        </li>)}</ul>
        {deleting ? <div role="group" aria-label="MCP 삭제 확인">
            <p>“{deleting.name}” 설정(revision {deleting.revision})을 삭제합니다. 참조한 API 키는 삭제하지 않습니다.</p>
            <button type="button" disabled={blocked} onClick={() => void mutate({
                method: "del", path: `/mcp/servers/${deleting.id}?expected_revision=${deleting.revision}`, key: newKey(),
            })}>이 MCP 설정 삭제</button>
            <button type="button" disabled={blocked} onClick={() => setDeleting(null)}>삭제 취소</button>
        </div> : <form className="stack" onSubmit={(e) => { e.preventDefault(); submit(); }}>
            <fieldset disabled={blocked || !!query.error}>
                <legend>{editing ? "MCP 서버 편집" : "MCP 서버 추가"}</legend>
                <label>MCP 이름<input aria-label="MCP 이름" value={name} maxLength={64} onChange={(e) => setName(e.target.value)} /></label>
                <label>MCP 설정 JSON<textarea aria-label="MCP 설정 JSON" rows={8} value={config} onChange={(e) => setConfig(e.target.value)} /></label>
                <p className="muted small">HTTP 예: <code>{'{"transport":"http","endpoint":"https://example.com/mcp","header_secrets":{}}'}</code>. 구 SSE 설정은 transport를 sse로 지정합니다. URL query·fragment·내장 자격증명은 허용하지 않습니다.</p>
                <details><summary>사용 가능한 API 키 ID</summary>
                    <ul>{(secrets.data ?? []).map((s) => <li key={s.id}>{s.label}: <code>{s.id}</code></li>)}</ul>
                </details>
                <label>MCP timeout(초)<input aria-label="MCP timeout(초)" type="number" min={1} max={300} value={timeout} onChange={(e) => setTimeout(Number(e.target.value))} /></label>
                <label className="check"><input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />MCP 사용 설정(연결 아님)</label>
                <button type="submit" disabled={!name.trim()}>MCP 설정 저장</button>
                {editing && <button type="button" onClick={reset}>MCP 편집 취소</button>}
                {editing && current && current.revision !== editing.revision && <button type="button" onClick={() => edit(current)}>최신 MCP 설정 사용</button>}
            </fieldset>
            {editing && current && current.revision !== editing.revision && <p className="warn" role="status">다른 기기에서 바뀌었습니다. 내 입력과 원래 revision을 보존했습니다.</p>}
        </form>}
        {mutation.phase === "sending" && <p role="status">MCP 설정 결과 확인 중…</p>}
        {mutation.phase === "unknown" && <div role="group" aria-label="MCP 결과 재확인">
            <p className="warn">결과 불명입니다. 새 요청을 만들지 않고 원래 내용·revision·같은 키로 확인합니다.</p>
            <button type="button" onClick={() => void mutate(mutation.attempt)}>같은 MCP 요청 확인</button>
        </div>}
        {error && <p role="alert" className="err">{error}</p>}
    </div>;
}
