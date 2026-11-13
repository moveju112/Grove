import { useCallback, useEffect, useRef, useState } from "react";
import type { SettingDef } from "../ScopedSettings";
import { createSettingReveal, settingLinkKey, type SettingLinkReady } from "./reveal";

type Request = { key: string; scope: string; prepared: boolean };

export function useSettingsLink(
    registry: { data: SettingDef[] | undefined; error: unknown },
    scope: string,
    prepare: (definition: SettingDef) => boolean,
) {
    const root = useRef<HTMLDivElement>(null);
    const [request, setRequest] = useState<Request | null>(() => {
        const key = typeof location === "undefined" ? null : settingLinkKey(location.hash);
        return key ? { key, scope, prepared: false } : null;
    });
    const [error, setError] = useState<string | null>(null);
    const active = useRef<{ request: Request; reveal: ReturnType<typeof createSettingReveal> } | null>(null);
    const cancel = useCallback(() => {
        active.current?.reveal.cancel();
        active.current = null;
        setRequest(null);
        setError(null);
    }, []);
    const open = useCallback((key: string) => {
        cancel();
        setRequest({ key, scope, prepared: false });
    }, [cancel, scope]);

    useEffect(() => {
        if (!request) return;
        if (request.scope !== scope) return cancel();
        if (registry.error) {
            cancel();
            setError("링크한 설정을 불러오지 못했습니다.");
            return;
        }
        if (request.prepared || !registry.data) return;
        const definition = registry.data.find((item) => item.key === request.key);
        if (!definition || !prepare(definition)) {
            cancel();
            setError("링크한 설정 항목을 찾을 수 없습니다.");
            return;
        }
        const next = { ...request, prepared: true };
        active.current = { request: next, reveal: createSettingReveal(root.current, request.key) };
        setRequest(next);
    }, [request, registry.data, registry.error, scope, prepare, cancel]);

    useEffect(() => () => {
        active.current?.reveal.cancel();
        active.current = null;
    }, []);

    const ready: SettingLinkReady = useCallback((key, element) => {
        const current = active.current;
        if (!current || current.request.scope !== scope) return;
        const outcome = current.reveal.ready(key, element);
        if (outcome === "ignored") return;
        active.current = null;
        setRequest(null);
        if (outcome === "unavailable") setError("링크한 설정을 불러오지 못했습니다.");
    }, [scope]);

    return {
        root, open, cancel, ready, error,
        pending: request !== null && request.scope === scope,
        key: request?.prepared && request.scope === scope ? request.key : undefined,
    };
}
