import { Text } from "@astryxdesign/core/Text";
import { Stack } from "@astryxdesign/core/Stack";
import { Button } from "../../design/Button";
import { api } from "../../api/client";
import type { ServerUpdateStatus } from "../../api/updateSettings";
import { useQuery } from "../../state/store";
import { updateStatusKey } from "./updateState";

export function UpdateSettings() {
    const query = useQuery<ServerUpdateStatus>(updateStatusKey, () => api.get("/updates/settings"));
    return <Stack gap={2} data-testid="server-update-settings">
        {query.error ? <>
            <Text as="p" role="alert">서버 업데이트 설정을 불러오지 못했어요.</Text>
            <Button variant="secondary" density="compact" onClick={query.reload}>다시 확인</Button>
        </> : query.data ? <UpdateSettingsPanel application={query.data.automatic_application} />
            : <Text as="p" role="status">서버 업데이트 설정을 불러오는 중이에요.</Text>}
    </Stack>;
}

export function UpdateSettingsPanel({ application }: { application: ServerUpdateStatus["automatic_application"] }) {
    if (application === "enabled") return <Text as="p">자동 업데이트 · 항상 켜짐</Text>;
    if (application === "external") return <Text as="p">이 실행 방식은 데몬 자동 업데이트를 지원하지 않아요.</Text>;
    return <Text as="p">이 데몬은 수동 업데이트가 필요해요.</Text>;
}
