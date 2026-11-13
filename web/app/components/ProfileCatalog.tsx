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
    if (profile.protocol === "claude_code" || profile.protocol === "codex_cli") {
        return <span className="muted small">CLI 모델 목록 자동 조회는 미지원입니다. 모델 이름을 수동 입력하세요.</span>;
    }
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
            <button className="ghost small" type="button" disabled={busy} onClick={() => void refresh()}>
                {busy ? "목록 조회 중…" : "모델 목록 새로고침"}
            </button>
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
                <span className="muted"> {catalog.models.length}개 · <When at={catalog.fetched_at} /> 조회</span>
                {catalog.models.length === 0 && <span className="muted"> 조회된 모델이 없습니다. 수동 모델 입력은 유지됩니다.</span>}
                {stale && <p className="warn" role="status">프로필이 바뀌었습니다. 목록을 다시 조회한 뒤 선택하세요.</p>}
            </>}
            {error && <p className="err" role="alert">{error}{catalog ? " (마지막 조회 목록은 보존했습니다.)" : ""} 수동 모델 입력은 유지됩니다. 다시 조회한 뒤 목록에서 선택하세요.</p>}
        </div>
    );
}
