import { useEffect, useMemo, useRef, useState } from "react";
import { ApiError, authGeneration, isTransportError } from "../api/client";
import { checkCompatibility } from "../components/pwa/lifecycle";
import { removeHiddenRecent } from "./store";

type Target = { kind: string; project_id?: string; resource_id?: string };
const identity = (target: Target) => JSON.stringify([target.kind, target.project_id, target.resource_id]);
type Hide = {
    key: string; request: () => Promise<string>; tabId?: string; onHidden?: () => void | Promise<void>;
    error?: string; uncertain?: boolean;
};

export function useRecentHides() {
    const [entries, setEntries] = useState<Hide[]>([]);
    const current = useRef(new Map<string, Hide>());
    const flights = useRef(new Map<string, Promise<void>>());
    const owner = useRef(authGeneration());
    useEffect(() => {
        const pending = current.current;
        return () => pending.clear();
    }, []);
    const actions = useMemo(() => {
        const publish = () => setEntries([...current.current.values()]);
        const run = (op: Hide) => {
            const previous = flights.current.get(op.key);
            const send = async () => {
                if (previous) await previous;
                if (current.current.get(op.key) !== op || owner.current !== authGeneration()) return;
                try {
                    const id = await op.request();
                    if (current.current.get(op.key) !== op || owner.current !== authGeneration()) return;
                    removeHiddenRecent(id);
                    await op.onHidden?.();
                    if (current.current.get(op.key) === op) current.current.delete(op.key);
                } catch (error) {
                    if (current.current.get(op.key) !== op || owner.current !== authGeneration()) return;
                    if (isTransportError(error, true)) void checkCompatibility();
                    const transport = isTransportError(error);
                    const reported = error instanceof ApiError
                        ? (error.details as { result_unknown?: boolean } | undefined)?.result_unknown : undefined;
                    const uncertain = !!(op.uncertain && transport) || (reported ?? (error instanceof ApiError
                        && (error.code === "result_unknown" || error.status >= 500 || error.status === 408)));
                    if (transport && !uncertain) current.current.delete(op.key);
                    else current.current.set(op.key, { ...op, uncertain,
                        error: uncertain ? "최근에서 숨겼는지 확인하지 못했습니다."
                            : error instanceof ApiError ? error.message : "최근에서 숨기지 못했어요." });
                }
                publish();
            };
            const flight = send().finally(() => {
                if (flights.current.get(op.key) === flight) flights.current.delete(op.key);
            });
            flights.current.set(op.key, flight);
        };
        return {
            isHidden: (target: Target) => {
                const op = current.current.get(identity(target));
                return !!op && (!op.error || op.uncertain);
            },
            hide(target: Target, request: Hide["request"], tabId?: string, onHidden?: Hide["onHidden"]) {
                const key = identity(target);
                const old = current.current.get(key);
                if (old && (!old.error || old.uncertain)) {
                    if (tabId) { old.tabId = tabId; old.onHidden = onHidden; publish(); }
                    return;
                }
                const op = { key, request, tabId, onHidden };
                current.current.set(key, op);
                publish();
                run(op);
            },
            retry(op: Hide) {
                if (current.current.get(op.key) !== op || !op.uncertain || !op.error) return;
                const retry = { ...op, error: undefined };
                current.current.set(op.key, retry);
                publish();
                run(retry);
            },
            dismiss(op: Hide) {
                if (current.current.get(op.key) === op && !op.uncertain) current.current.delete(op.key);
                publish();
            },
            // 명시적으로 다시 열면 그 의도가 이긴다. 화면은 바로 열고 접근 기록만 숨김 뒤에 보낸다.
            reopen(target: Target, touch: () => Promise<void>) {
                const key = identity(target);
                if (current.current.delete(key)) publish();
                const previous = flights.current.get(key);
                const next = previous ? previous.then(() => owner.current === authGeneration() ? touch() : undefined) : touch();
                const queued = next.catch(() => undefined).finally(() => {
                    if (flights.current.get(key) === queued) flights.current.delete(key);
                });
                flights.current.set(key, queued);
                return next;
            },
        };
    }, []);
    return useMemo(() => ({ ...actions, entries }), [actions, entries]);
}

export type RecentHides = ReturnType<typeof useRecentHides>;
