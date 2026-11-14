import { useRef, useState } from "react";
import { DetailDialog } from "./ui/Controls";
import { ApiError, api, newKey } from "../api/client";
import { useQuery } from "../state/store";
import { useCapability } from "../state/capabilities";
import { ServerActionButton } from "./pwa/ServerActionButton";
import { McpOAuth } from "./mcp-oauth/McpOAuth";
import type { McpOAuthConfig } from "../api/mcpOAuth";

type Config =
    | { transport: "stdio"; command: string; args: string[]; env_secrets: Record<string, string> }
    | { transport: "http" | "sse"; endpoint: string; header_secrets: Record<string, string>; oauth?: McpOAuthConfig };
type Server = {
    id: string; name: string; config: Config; enabled: boolean; timeout_secs: number; revision: number;
    connection_state: "disabled" | "disconnected" | "checking" | "in_use";
    active_calls?: number;
    last_check: null | { status: "checking" | "ready" | "failed" | "interrupted"; tool_count: number | null; error: { message: string } | null };
};
type Attempt = { method: "post" | "put" | "del"; path: string; body?: unknown; key: string };
type Mutation = { phase: "idle" } | { phase: "sending" | "unknown"; attempt: Attempt };
const example = JSON.stringify({ transport: "stdio", command: "mcp-server", args: [], env_secrets: {} }, null, 2);

export function McpServers() {
    const query = useQuery<Server[]>("mcp", () => api.get("/mcp/servers", { requires: ["mcp_settings_v1"] }));
    const secrets = useQuery<{ id: string; label: string }[]>("secrets", () => api.get("/secrets"));
    const [editing, setEditing] = useState<Server | null>(null);
    const [deleting, setDeleting] = useState<Server | null>(null);
    const [testing, setTesting] = useState<Server | null>(null);
    const [selected, setSelected] = useState<string | null>(null);
    const checkSupported = useCapability("mcp_check_v1");
    const check = useQuery<{ status: string; detail?: unknown } | null>(`mcp-check:${selected ?? "-"}`, () => selected ? api.get(`/mcp/servers/${selected}/check`) : Promise.resolve(null));
    const [name, setName] = useState("");
    const [config, setConfig] = useState(example);
    const [timeout, setTimeout] = useState(60);
    const [enabled, setEnabled] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [mutation, setMutation] = useState<Mutation>({ phase: "idle" });
    const sending = useRef(false);
    const blocked = mutation.phase !== "idle";
    const reset = () => {
        setEditing(null); setDeleting(null); setTesting(null); setName(""); setConfig(example); setTimeout(60); setEnabled(false);
    };
    const mutate = async (attempt: Attempt) => {
        if (sending.current) return;
        sending.current = true;
        setMutation({ phase: "sending", attempt });
        setError(null);
        try {
            const options = { key: attempt.key, requires: attempt.path.endsWith("/check") ? ["mcp_settings_v1", "mcp_check_v1"] : ["mcp_settings_v1"] };
            if (attempt.method === "del") await api.del(attempt.path, options);
            else await api[attempt.method](attempt.path, attempt.body, options);
            setMutation({ phase: "idle" });
            reset();
        } catch (e) {
            const unknown = !(e instanceof ApiError) || e.status >= 500 || e.status === 408
                || e.code === "result_unknown"
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
    const rowBlocked=(server:Server)=>blocked || !!editing || !!deleting || !!testing || !!name
        || server.last_check?.status==="checking" || server.connection_state==="in_use";
    return <div className="stack" data-testid="mcp-panel">
        <p className="muted small">비밀값 대신 env_secrets·header_secrets에 API 키 ID를 사용하세요. 헤더 키에는 Bearer 등 접두사를 포함하세요.</p>
        {!!query.error && <p role="alert" className="err">{query.error instanceof Error ? query.error.message : "MCP 조회 실패"}</p>}
        <ul>{(query.data ?? []).map((server) => <li key={server.id} data-testid="mcp-row">
            <strong>{server.name}</strong> · {server.config.transport} · {server.enabled ? "사용 설정" : "사용 안 함"}
            {server.connection_state==="checking" ? " · 연결 확인 중" : server.connection_state==="in_use" ? ` · 호출 ${server.active_calls}개 실행 중` : server.enabled ? " · 미연결" : ""}
            {" · "}revision {server.revision}
            <div className="inline">
                <button type="button" disabled={rowBlocked(server)} onClick={() => edit(server)}>MCP 편집</button>
                <ServerActionButton type="button" disabled={rowBlocked(server)} onClick={() => void mutate({
                    method: "put", path: `/mcp/servers/${server.id}`, key: newKey(),
                    body: { expected_revision: server.revision, server: { name: server.name, config: server.config, timeout_secs: server.timeout_secs, enabled: !server.enabled } },
                })}>{server.enabled ? "MCP 사용 끄기" : "MCP 사용 켜기"}</ServerActionButton>
                <button type="button" disabled={rowBlocked(server)} onClick={() => { setDeleting(server); setError(null); }}>MCP 삭제 확인</button>
                {checkSupported !== false && <button type="button" disabled={rowBlocked(server)} onClick={() => { setTesting(server); setError(null); }}>MCP 연결 확인 준비</button>}
                {server.last_check && <button type="button" onClick={() => setSelected(server.id)}>MCP 확인 상세</button>}
            </div>
            {server.last_check && <p role="status">마지막 확인: {({ checking: "확인 중", ready: "성공 · 확인 후 연결 닫힘", failed: "실패", interrupted: "중단" })[server.last_check.status]}
                {server.last_check.tool_count !== null && ` · 도구 ${server.last_check.tool_count}개`}
                {server.last_check.error && ` · ${server.last_check.error.message}`}</p>}
            {server.config.transport === "http" && server.config.oauth && <McpOAuth serverId={server.id} revision={server.revision}
                resource={server.config.endpoint} config={server.config.oauth} disabled={rowBlocked(server)} onChanged={query.reload} />}
        </li>)}</ul>
        {selected && <div role="group" aria-label="MCP 확인 상세">
            {check.error ? <p className="err">연결 확인 결과 조회 실패</p> : <pre>{JSON.stringify(check.data, null, 2)}</pre>}
            <button type="button" onClick={() => setSelected(null)}>MCP 확인 상세 닫기</button>
        </div>}
        {testing ? <div role="group" aria-label="MCP 실행·외부 연결 확인">
            <p>“{testing.name}”(revision {testing.revision})의 {testing.config.transport === "stdio" ? "프로세스를 실행합니다" : "외부 서버에 연결합니다"}. 저장한 secret 참조를 전달하고 handshake·도구 목록을 조회한 뒤 닫습니다. 임의 MCP 프로세스는 OS 파일시스템 sandbox로 격리되지 않습니다.</p>
            <ServerActionButton type="button" disabled={blocked} onClick={() => void mutate({
                method: "post", path: `/mcp/servers/${testing.id}/check`, key: newKey(), body: { expected_revision: testing.revision, confirmed: true },
            })}>확인하고 MCP 연결 검사</ServerActionButton>
            <button type="button" disabled={blocked} onClick={() => setTesting(null)}>MCP 검사 취소</button>
        </div> : deleting ? <div role="group" aria-label="MCP 삭제 확인">
            <p>“{deleting.name}” 설정(revision {deleting.revision})을 삭제합니다. 참조한 API 키는 삭제하지 않습니다.</p>
            <ServerActionButton type="button" disabled={blocked} onClick={() => void mutate({
                method: "del", path: `/mcp/servers/${deleting.id}?expected_revision=${deleting.revision}`, key: newKey(),
            })}>이 MCP 설정 삭제</ServerActionButton>
            <button type="button" disabled={blocked} onClick={() => setDeleting(null)}>삭제 취소</button>
        </div> : <form className="stack" onSubmit={(e) => { e.preventDefault(); submit(); }}>
            <fieldset disabled={blocked || !!query.error}>
                <legend>{editing ? "MCP 서버 편집" : "MCP 서버 추가"}</legend>
                <label>MCP 이름<input aria-label="MCP 이름" value={name} maxLength={64} onChange={(e) => setName(e.target.value)} /></label>
                <label>MCP 설정 JSON<textarea aria-label="MCP 설정 JSON" rows={8} value={config} onChange={(e) => setConfig(e.target.value)} /></label>
                <p className="muted small">HTTP 예: <code>{'{"transport":"http","endpoint":"https://example.com/mcp","header_secrets":{}}'}</code>. 구 SSE 설정은 transport를 sse로 지정합니다. URL query·fragment·내장 자격증명은 허용하지 않습니다.</p>
                <DetailDialog label="사용 가능한 API 키 ID" title="사용 가능한 API 키 ID">
                    <ul>{(secrets.data ?? []).map((s) => <li key={s.id}>{s.label}: <code>{s.id}</code></li>)}</ul>
                </DetailDialog>
                <label>MCP timeout(초)<input aria-label="MCP timeout(초)" type="number" min={1} max={300} value={timeout} onChange={(e) => setTimeout(Number(e.target.value))} /></label>
                <label className="check"><input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />MCP 사용 설정(연결 아님)</label>
                <ServerActionButton type="submit" disabled={!name.trim()}>MCP 설정 저장</ServerActionButton>
                {editing && <button type="button" onClick={reset}>MCP 편집 취소</button>}
                {editing && current && current.revision !== editing.revision && <button type="button" onClick={() => edit(current)}>최신 MCP 설정 사용</button>}
            </fieldset>
            {editing && current && current.revision !== editing.revision && <p className="warn" role="status">다른 기기에서 바뀌었습니다. 내 입력과 원래 revision을 보존했습니다.</p>}
        </form>}
        {mutation.phase === "sending" && <p role="status">MCP 설정 결과 확인 중…</p>}
        {mutation.phase === "unknown" && <div role="group" aria-label="MCP 결과 재확인">
            <p className="warn">결과 불명입니다. 새 요청을 만들지 않고 원래 내용·revision·같은 키로 확인합니다.</p>
            <ServerActionButton type="button" onClick={() => void mutate(mutation.attempt)}>같은 MCP 요청 확인</ServerActionButton>
        </div>}
        {error && <p role="alert" className="err">{error}</p>}
    </div>;
}
