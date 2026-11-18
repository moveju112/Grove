import { Stack as GroveStack } from "@astryxdesign/core/Stack";
import { Text as GroveText } from "@astryxdesign/core/Text";
import { Button as GroveButton } from "../../design/Button";
import { useRef, useState } from "react";
import { ApiError, api, newKey } from "../../api/client";
import type { SaveUpdatePreferences, ServerUpdateStatus } from "../../api/updateSettings";
import { setData, useQuery } from "../../state/store";
import { BooleanSelect } from "../BooleanSelect";
import { updateResultUnknown, updateStatusKey } from "./updateState";

type Attempt = { body: SaveUpdatePreferences; key: string };

export function UpdateSettings() {
    const query = useQuery<ServerUpdateStatus>(updateStatusKey, () => api.get("/updates/settings"));
    const [attempt, setAttempt] = useState<Attempt | null>(null);
    const [unknown, setUnknown] = useState(false);
    const [message, setMessage] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const sending = useRef(false);
    const mutate = async (request: Attempt) => {
        if (sending.current) return;
        sending.current = true;
        setAttempt(request); setUnknown(false); setMessage(null); setError(null);
        let received = false;
        try {
            const saved = await api.put<{ settings: ServerUpdateStatus["settings"] }>("/updates/settings", request.body, { key: request.key });
            received = true;
            // 저장 성공 응답과 실제 서버 재조회 완료를 구분한다.
            const confirmed = await api.get<ServerUpdateStatus>("/updates/settings");
            setData(updateStatusKey, confirmed);
            setAttempt(null);
            const changed = confirmed.settings.revision !== saved.settings.revision;
            setMessage(changed ? "서버 저장 후 다른 요청으로 설정이 변경됐습니다. 현재 값을 다시 조회했습니다." : "서버에 저장됨 · 다시 조회해 확인했습니다.");
        } catch (e) {
            const uncertain = received || updateResultUnknown(e);
            setUnknown(uncertain);
            if (!uncertain) setAttempt(null);
            setError(e instanceof ApiError ? e.message : "요청 결과를 확인할 수 없습니다.");
        } finally {
            sending.current = false;
        }
    };
    return <GroveStack gap={2} data-testid="server-update-settings">
        {query.loading && <GroveText as="p" display="block" type="inherit" color="inherit" role="status">서버 업데이트 설정 불러오는 중</GroveText>}
        {!!query.error && <GroveText as="p" display="block" type="inherit" color="inherit" role="alert">서버 업데이트 설정 조회 실패</GroveText>}
        {error && <GroveText as="p" display="block" type="inherit" color="inherit" role="alert">{error}</GroveText>}
        {message && <GroveText as="p" display="block" type="inherit" color="inherit" role="status">{message}</GroveText>}
        {unknown && attempt && <GroveText as="p" display="block" type="inherit" color="inherit" role="status">결과 불명 · 새 요청 전에 같은 요청으로 확인하세요.
            <GroveButton onClick={() => void mutate(attempt)}>같은 업데이트 요청 확인</GroveButton>
        </GroveText>}
        {(!!query.error || (error && !unknown)) && <GroveButton variant="secondary" density="compact" disabled={!!attempt || query.loading}
            onClick={() => { setError(null); query.reload(); }}>현재 설정 다시 조회</GroveButton>}
        {query.data && <UpdateSettingsPanel key={query.data.settings.revision} data={query.data} blocked={!!attempt || !!query.error || query.loading}
            onSave={(body) => void mutate({ body, key: newKey() })} />}
    </GroveStack>;
}

export function UpdateSettingsPanel({ data, blocked, onSave }: {
    data: ServerUpdateStatus; blocked: boolean;
    onSave: (body: SaveUpdatePreferences) => void;
}) {
    const [enabled, setEnabled] = useState(data.settings.auto_apply !== "notify_only");
    return <>
        {!data.can_manage && <GroveText as="p" display="block" type="inherit" color="inherit">이 서버의 업데이트 설정은 읽기 전용이에요.</GroveText>}
        <BooleanSelect label="자동 업데이트" value={enabled} disabled={!data.can_manage || blocked}
            trueLabel="ON" falseLabel="OFF" help="현재는 설정만 저장되며 자동 설치·재시작은 실행하지 않아요."
            onChange={(value) => {
                if (value === enabled) return;
                setEnabled(value);
                onSave({
                    channel: data.settings.channel,
                    auto_apply: value ? "minor" : "notify_only",
                    expected_revision: data.settings.revision,
                });
            }} />
    </>;
}
