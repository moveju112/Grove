import { Stack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { Collapsible } from "@astryxdesign/core/Collapsible";
import { api } from "../../api/client";
import { useQuery } from "../../state/store";
import type { SettingsTarget } from "../ScopedSettings";
import { When } from "../When";

type MemoryData = {
    items: { id: string; title: string; summary: string; source_at: string }[];
    checkpoints: { session_id: string; title: string; attempted_at: string; error_code: string | null }[];
};

export function MemoryActivity({ target }: { target: SettingsTarget }) {
    const params = new URLSearchParams();
    if (target.sessionId) params.set("session_id", target.sessionId);
    else if (target.projectId) params.set("project_id", target.projectId);
    const records = useQuery<MemoryData>(`memory:${target.sessionId ?? target.projectId ?? "-"}`, () => api.get(`/memory?${params}`));
    return <Stack gap={2}>
        {Boolean(records.error) && <Text color="error" role="alert">메모리 기록을 읽지 못했어요.</Text>}
        {records.data?.checkpoints.filter((record) => record.error_code).map((record) => <Text key={record.session_id} color="warning" role="status">
            {record.title} · 메모리를 정리하지 못했어요 ({record.error_code}) · <When at={record.attempted_at} />
        </Text>)}
        {records.data && (records.data.items.length ? <Collapsible trigger={`정리 결과 ${records.data.items.length}개`} defaultIsOpen={false}>
            <Stack gap={3}>{records.data.items.map((item) => <Stack as="article" key={item.id} gap={1}>
                <Text type="supporting" color="secondary">{item.title} · <When at={item.source_at} /></Text>
                <Text>{item.summary}</Text>
            </Stack>)}</Stack>
        </Collapsible> : <Text type="supporting" color="secondary">아직 정리한 메모리가 없어요.</Text>)}
    </Stack>;
}
