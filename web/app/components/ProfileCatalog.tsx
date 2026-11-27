import { Stack as GroveStack } from "@astryxdesign/core/Stack";
import { Text as GroveText } from "@astryxdesign/core/Text";
import { Select } from "../design/Select";
import { Button as GroveButton } from "../design/Button";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { api } from "../api/client";
import type { ModelCatalog, ModelProfile } from "../api/generated";
import { useCapability } from "../state/capabilities";
import { useServerBlockReason } from "./pwa/lifecycle";
import { sortModels } from "./model-catalog";
import { Icon } from "./icons";
import * as stylex from "@stylexjs/stylex";

const styles = stylex.create({ select: { minWidth: 0, flexGrow: 1 } });

const OPEN_KEYS = new Set(["Enter", " ", "ArrowDown", "ArrowUp"]);

/// 프로필 행의 모델 선택과 그 아래 줄에 둘 조회 상태를 나눠 돌려준다.
/// 목록은 처음 펼칠 때나 새로고침을 누를 때만 조회한다(설정 화면을 여는 것만으로 공급자를 호출하지 않는다).
export function useProfileCatalog(profile: ModelProfile, onChoose: (model: string, revision: number) => void): { control: ReactNode; messages: ReactNode } {
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
    if (supported === false) return { control: null, messages: null };
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
    const loadOnOpen = () => { if (!catalog && !busy && !error) void refresh(); };
    const models = catalog ? sortModels(catalog.models) : [];
    const options = [
        ...(models.some((model) => model.id === profile.model) ? [] : [{ value: profile.model, label: profile.model }]),
        ...models.map((model) => ({ value: model.id, label: model.name === model.id ? model.id : `${model.name} · ${model.id}` })),
    ];
    const control = <GroveStack direction="horizontal" align="center" gap={1} role="group" aria-label={`${profile.name} 모델 목록`}>
        <GroveStack xstyle={styles.select} onPointerDownCapture={loadOnOpen}
            onKeyDownCapture={(event) => { if (OPEN_KEYS.has(event.key)) loadOnOpen(); }}>
            <Select label={`${profile.name} 공급자 모델`} hideLabel value={profile.model} data-testid="profile-model"
                isLoading={busy && !catalog}
                disabled={(busy && catalog !== null) || stale || error !== null || !!serverBlocked} disabledMessage={serverBlocked ?? undefined}
                onChange={(value) => { if (value && catalog && value !== profile.model) onChoose(value, catalog.profile_revision); }}
                options={options} />
        </GroveStack>
        <GroveButton type="button" variant="secondary" appearance="icon" disabled={busy}
            aria-label="모델 목록 새로고침" title={busy ? "목록 조회 중…" : "모델 목록 새로고침"} onClick={() => void refresh()}>
            <Icon name="restore" size={16} />
        </GroveButton>
    </GroveStack>;
    const messages = (catalog?.models.length === 0 || stale || error) ? <GroveText as="div" display="block" type="supporting" color="inherit">
        {catalog?.models.length === 0 && <GroveText type="inherit" color="secondary">조회된 모델 없음 · 수동 입력 가능</GroveText>}
        {stale && <GroveText as="p" display="block" type="inherit" color="warning" role="status">프로필이 변경됐으니 목록을 다시 조회하세요.</GroveText>}
        {error && <GroveText as="p" display="block" type="inherit" color="error" role="alert">{error}{catalog ? " · 마지막 조회 목록 보존" : ""} · 수동 입력 유지 · 목록 재조회 필요</GroveText>}
    </GroveText> : null;
    return { control, messages };
}
