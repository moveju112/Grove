import { List as GroveList, ListItem as GroveListItem } from "@astryxdesign/core/List";
import { Button as GroveButton } from "../design/Button";
import { useRef, useState } from "react";
import { DetailDialog } from "./ui/Controls";
import { BooleanSelect } from "./BooleanSelect";
import { ApiError, api, newKey } from "../api/client";
import { useQuery } from "../state/store";
import { useCapability } from "../state/capabilities";
import { ServerActionButton } from "./pwa/ServerActionButton";
import { McpOAuth } from "./mcp-oauth/McpOAuth";
import type { McpOAuthConfig } from "../api/mcpOAuth";
import { HelpTip, SentenceText } from "./HelpTip";
import { TextInput, TextArea, DraftInput } from "../design/Fields";
import { Stack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";

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
    return <Stack gap={2} data-testid="mcp-panel">
        <Text as="p" display="block" type="supporting" color="secondary">비밀값 대신 API 키 ID를 사용하세요.</Text>
        {!!query.error && <Text as="p" display="block" type="inherit" color="error" role="alert">{query.error instanceof Error ? query.error.message : "MCP 조회 실패"}</Text>}
        <GroveList density="compact" edge="flush" listStyle="disc">{(query.data ?? []).map((server) => <GroveListItem key={server.id} data-testid="mcp-row" label={<>
            <strong>{server.name}</strong> · {server.config.transport} · {server.enabled ? "사용 설정" : "사용 안 함"}
            {server.connection_state==="checking" ? " · 연결 확인 중" : server.connection_state==="in_use" ? ` · 호출 ${server.active_calls}개 실행 중` : server.enabled ? " · 미연결" : ""}
            {" · "}revision {server.revision}
            <Stack direction="horizontal" align="center" gap={1.5}>
                <GroveButton type="button" disabled={rowBlocked(server)} onClick={() => edit(server)}>MCP 편집</GroveButton>
                <ServerActionButton type="button" disabled={rowBlocked(server)} onClick={() => void mutate({
                    method: "put", path: `/mcp/servers/${server.id}`, key: newKey(),
                    body: { expected_revision: server.revision, server: { name: server.name, config: server.config, timeout_secs: server.timeout_secs, enabled: !server.enabled } },
                })}>{server.enabled ? "MCP 사용 끄기" : "MCP 사용 켜기"}</ServerActionButton>
                <GroveButton type="button" disabled={rowBlocked(server)} onClick={() => { setDeleting(server); setError(null); }}>MCP 삭제 확인</GroveButton>
                {checkSupported !== false && <GroveButton type="button" disabled={rowBlocked(server)} onClick={() => { setTesting(server); setError(null); }}>MCP 연결 확인 준비</GroveButton>}
                {server.last_check && <GroveButton type="button" onClick={() => setSelected(server.id)}>MCP 확인 상세</GroveButton>}
            </Stack>
            {server.last_check && <Text as="p" display="block" type="inherit" color="inherit" role="status">마지막 확인: {({ checking: "확인 중", ready: "성공 · 확인 후 연결 닫힘", failed: "실패", interrupted: "중단" })[server.last_check.status]}
                {server.last_check.tool_count !== null && ` · 도구 ${server.last_check.tool_count}개`}
                {server.last_check.error && ` · ${server.last_check.error.message}`}</Text>}
            {server.config.transport === "http" && server.config.oauth && <McpOAuth serverId={server.id} revision={server.revision}
                resource={server.config.endpoint} config={server.config.oauth} disabled={rowBlocked(server)} onChanged={query.reload} />}
        </>} />)}</GroveList>
        {selected && <Stack gap={0} role="group" aria-label="MCP 확인 상세">
            {check.error ? <Text as="p" display="block" type="inherit" color="error">연결 확인 결과 조회 실패</Text> : <pre>{JSON.stringify(check.data, null, 2)}</pre>}
            <GroveButton type="button" onClick={() => setSelected(null)}>MCP 확인 상세 닫기</GroveButton>
        </Stack>}
        {testing ? <Stack gap={0} role="group" aria-label="MCP 실행·외부 연결 확인">
            <Text as="p" display="block" type="inherit" color="inherit">“{testing.name}”(revision {testing.revision})의 {testing.config.transport === "stdio" ? "프로세스를 실행합니다" : "외부 서버에 연결합니다"}. 저장한 secret 참조를 전달하고 handshake·도구 목록을 조회한 뒤 닫습니다. 임의 MCP 프로세스는 OS 파일시스템 sandbox로 격리되지 않습니다.</Text>
            <ServerActionButton type="button" disabled={blocked} onClick={() => void mutate({
                method: "post", path: `/mcp/servers/${testing.id}/check`, key: newKey(), body: { expected_revision: testing.revision, confirmed: true },
            })}>확인하고 MCP 연결 검사</ServerActionButton>
            <GroveButton type="button" disabled={blocked} onClick={() => setTesting(null)}>MCP 검사 취소</GroveButton>
        </Stack> : deleting ? <Stack gap={0} role="group" aria-label="MCP 삭제 확인">
            <Text as="p" display="block" type="inherit" color="inherit">“{deleting.name}” 설정(revision {deleting.revision})만 삭제하며 API 키는 유지합니다.</Text>
            <ServerActionButton type="button" disabled={blocked} onClick={() => void mutate({
                method: "del", path: `/mcp/servers/${deleting.id}?expected_revision=${deleting.revision}`, key: newKey(),
            })}>이 MCP 설정 삭제</ServerActionButton>
            <GroveButton type="button" disabled={blocked} onClick={() => setDeleting(null)}>삭제 취소</GroveButton>
        </Stack> : <Stack as="form" gap={2} onSubmit={(e) => { e.preventDefault(); submit(); }}>
            <fieldset disabled={blocked || !!query.error}>
                <legend>{editing ? "MCP 서버 편집" : "MCP 서버 추가"}</legend>
                <TextInput label="MCP 이름" value={name} maxLength={64} onChange={setName} />
                <Stack gap={2}>
                <Stack direction="horizontal" gap={1} align="center"><Text type="label">MCP 설정 JSON</Text><HelpTip label="MCP 설정 도움말">
                    <Text as="p" display="block" type="inherit" color="inherit">HTTP 예: <code>{'{"transport":"http","endpoint":"https://example.com/mcp","header_secrets":{}}'}</code></Text>
                    <Text as="p" display="block" type="inherit" color="inherit"><SentenceText text="env_secrets·header_secrets에는 API 키 ID를 쓰고 헤더 키에는 Bearer 등 접두사를 포함하세요. 구 SSE는 transport를 sse로 지정합니다. URL query·fragment·내장 자격증명은 허용하지 않습니다." /></Text>
                </HelpTip></Stack>
                <TextArea label="MCP 설정 JSON" isLabelHidden rows={8} value={config} onChange={setConfig} />
                </Stack>
                <DetailDialog label="사용 가능한 API 키 ID" title="사용 가능한 API 키 ID">
                    <GroveList density="compact" edge="flush" listStyle="disc">{(secrets.data ?? []).map((s) => <GroveListItem key={s.id} label={<>{s.label}: <code>{s.id}</code></>} />)}</GroveList>
                </DetailDialog>
                <DraftInput label="MCP timeout(초)" type="number" min={1} max={300} value={String(timeout)} onChange={(value) => setTimeout(Number(value))} />
                <BooleanSelect label="MCP 사용 설정(연결 아님)" value={enabled} onChange={setEnabled} disabled={blocked || !!query.error} />
                <ServerActionButton type="submit" disabled={!name.trim()}>MCP 설정 저장</ServerActionButton>
                {editing && <GroveButton type="button" onClick={reset}>MCP 편집 취소</GroveButton>}
                {editing && current && current.revision !== editing.revision && <GroveButton type="button" onClick={() => edit(current)}>최신 MCP 설정 사용</GroveButton>}
            </fieldset>
            {editing && current && current.revision !== editing.revision && <Text as="p" display="block" type="inherit" color="warning" role="status">다른 기기에서 바뀌었습니다. 내 입력과 원래 revision을 보존했습니다.</Text>}
        </Stack>}
        {mutation.phase === "sending" && <Text as="p" display="block" type="inherit" color="inherit" role="status">MCP 설정 결과 확인 중…</Text>}
        {mutation.phase === "unknown" && <Stack gap={0} role="group" aria-label="MCP 결과 재확인">
            <Text as="p" display="block" type="inherit" color="warning">결과 불명입니다. 새 요청을 만들지 않고 원래 내용·revision·같은 키로 확인합니다.</Text>
            <ServerActionButton type="button" onClick={() => void mutate(mutation.attempt)}>같은 MCP 요청 확인</ServerActionButton>
        </Stack>}
        {error && <Text as="p" display="block" type="inherit" color="error" role="alert">{error}</Text>}
    </Stack>;
}
