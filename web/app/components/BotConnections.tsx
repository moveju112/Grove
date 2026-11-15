import { useState } from "react";
import { Stack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { api } from "../api/client";
import type { BotConnections as Connections } from "../api/generated";
import { useQuery } from "../state/store";
import { BooleanSelect } from "./BooleanSelect";
import { ServerActionButton } from "./pwa/ServerActionButton";
import { useReceiptMutation } from "../state/useReceiptMutation";

export function BotConnections({ botId }: { botId: string }) {
    const query = useQuery<Connections>(`bot-connections:${botId}`, () => api.getContract("BotConnections", `/bots/${botId}/connections`, { requires: ["bot_connections_v1"] }));
    const [selection, setSelection] = useState<{ ids: string[]; revision: number } | null>(null);
    const mutation = useReceiptMutation((body: { expected_revision: number; server_ids: string[] }, key) =>
        api.put<Connections>(`/bots/${botId}/connections`, body, { key, requires: ["bot_connections_v1"], contract: "BotConnections" }));
    const ids = selection?.ids ?? query.data?.servers.filter((s) => s.selected).map((s) => s.id) ?? [];
    const save = async () => {
        if (!selection) return;
        const saved = await mutation.submit({ expected_revision: selection.revision, server_ids: selection.ids });
        if (!saved) return;
        setSelection(null);
        query.reload();
    };
    return <Stack gap={2} data-testid="bot-connections">
        <Text type="supporting" color="secondary">MCP 설정에서 연결한 서비스를 선택해요. 실제 호출에는 별도 승인이 필요해요.</Text>
        {!!query.error && <Text color="error" role="alert">외부 연결을 불러오지 못했어요</Text>}
        {query.data && query.data.servers.length === 0 && <Text type="supporting" color="secondary">아직 연결한 서비스가 없어요</Text>}
        {query.data?.servers.map((server) => <BooleanSelect key={server.id} label={`${server.name}${server.enabled ? "" : " · 비활성"}`}
            value={ids.includes(server.id)} disabled={mutation.blocked} onChange={(on) => setSelection({
                revision: selection?.revision ?? query.data!.revision,
                ids: on ? [...ids, server.id] : ids.filter((id) => id !== server.id),
            })} />)}
        {selection && <ServerActionButton disabled={mutation.busy} onClick={() => void save()}>{mutation.pending ? "같은 연결 요청 확인" : "연결 저장"}</ServerActionButton>}
        {mutation.error && <Text color="error" role="alert">{mutation.error}</Text>}
    </Stack>;
}
