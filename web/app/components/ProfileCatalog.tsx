import { Text as GroveText } from "@astryxdesign/core/Text";
import { Button as GroveButton } from "../design/Button";
import { useEffect, useRef, useState } from "react";
import { When } from "./When";
import { api } from "../api/client";
import type { ModelCatalog, ModelProfile } from "../api/generated";
import { useCapability } from "../state/capabilities";
import { useServerBlockReason } from "./pwa/lifecycle";

export function ProfileCatalog({ profile, onChoose }: { profile: ModelProfile; onChoose: (model: string, revision: number) => void }) {
    const serverBlocked = useServerBlockReason();
    const supported = useCapability("model_management_v1");
    const [catalog, setCatalog] = useState<ModelCatalog | null>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const controller = useRef<AbortController | null>(null);
    useEffect(() => () => { controller.current?.abort(); controller.current = null; }, []);
    useEffect(() => {
        const pending = controller.current;
        pending?.abort();
        controller.current = null;
        setBusy(false);
        setError(pending ? "프로필이 바뀌어 진행 중인 목록 조회를 사용하지 않습니다. 다시 조회하세요." : null);
    }, [profile.id, profile.revision]);
    if (supported === false) return null;
    const stale = catalog !== null && (catalog.profile_id !== profile.id || catalog.profile_revision !== profile.revision);
    const refresh = async () => {
        controller.current?.abort();
        const request = new AbortController();
        controller.current = request;
        setBusy(true);
        setError(null);
        try {
            const result = await api.getContract("ModelCatalog", `/model-profiles/${profile.id}/models`, {
                requires: ["model_management_v1"], signal: request.signal, timeoutMs: 35_000,
            });
            if (!request.signal.aborted && controller.current === request) setCatalog(result);
        } catch (error) {
            if (!request.signal.aborted && controller.current === request) setError(error instanceof Error ? error.message : "모델 목록을 조회하지 못했습니다");
        } finally {
            if (!request.signal.aborted && controller.current === request) {
                setBusy(false);
                controller.current = null;
            }
        }
    };
    return (
        <div className="small" role="group" aria-label={`${profile.name} 모델 목록`}>
            <GroveButton className="ghost small" type="button" disabled={busy} onClick={() => void refresh()}>
                {busy ? "목록 조회 중…" : "모델 목록 새로고침"}
            </GroveButton>
            {catalog && <>
                <label>
                    공급자 모델
                    <select aria-label={`${profile.name} 공급자 모델`} value={catalog.models.some((model) => model.id === profile.model) ? profile.model : ""}
                        disabled={busy || stale || error !== null || !!serverBlocked} title={serverBlocked ?? undefined}
                        onChange={(event) => { if (event.target.value) onChoose(event.target.value, catalog.profile_revision); }}>
                        <option value="">모델을 선택하세요(수동 입력도 가능)</option>
                        {catalog.models.map((model) => <option key={model.id} value={model.id}>{model.name} · {model.id}</option>)}
                    </select>
                </label>
                <GroveText type="inherit" color="secondary"> {catalog.models.length}개 · <When at={catalog.fetched_at} /> 조회</GroveText>
                {catalog.models.length === 0 && <GroveText type="inherit" color="secondary"> 조회된 모델 없음 · 수동 입력 가능</GroveText>}
                {stale && <GroveText as="p" display="block" type="inherit" color="warning" role="status">프로필이 변경됐으니 목록을 다시 조회하세요.</GroveText>}
            </>}
            {error && <GroveText as="p" display="block" type="inherit" color="error" role="alert">{error}{catalog ? " · 마지막 조회 목록 보존" : ""} · 수동 입력 유지 · 목록 재조회 필요</GroveText>}
        </div>
    );
}
