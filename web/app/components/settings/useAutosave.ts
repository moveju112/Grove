import { useEffect, useMemo, useSyncExternalStore, type FocusEvent } from "react";
import { ApiError, authGeneration, onAuthChange } from "../../api/client";
import { Autosave, type SavedValue } from "../../state/autosave";

type Options<T> = SavedValue<T> & {
    id: string; save: (value: T, revision: number, key: string) => Promise<SavedValue<T>>;
    draft?: SavedValue<T>; onSaved?: (value: T, saved: SavedValue<T>) => void;
    unversioned?: boolean;
    flush?: boolean;
};
type Binding<T> = { reference: { current: Options<T> }; controller: Autosave<T>; stop?: () => void };
// 화면을 닫은 뒤 도착한 실패도 같은 로그인·대상·편집기로 돌아오면 복구한다. 디스크에는 원문을 남기지 않는다.
const detached = new Map<string, Binding<unknown>[]>();
function forget<T>(key: string, binding: Binding<T>) {
    binding.stop?.(); binding.stop = undefined;
    const rest = detached.get(key)?.filter((item) => item !== binding);
    if (rest?.length) detached.set(key, rest);
    else detached.delete(key);
}
function remember<T>(key: string, binding: Binding<T>) {
    const keep = () => {
        const state = binding.controller.getSnapshot();
        return state.phase === "saving" || state.phase === "uncertain" || state.phase === "error" || state.phase === "conflict"
            || (binding.reference.current.flush !== false && state.dirty);
    };
    if (!keep()) return;
    const entries = detached.get(key) ?? [];
    const entry = binding as unknown as Binding<unknown>;
    if (!entries.includes(entry)) entries.push(entry);
    detached.set(key, entries);
    binding.stop = binding.controller.subscribe(() => { if (!keep()) forget(key, binding); });
}
onAuthChange((session) => {
    if (session) return;
    for (const entries of detached.values()) for (const binding of entries) binding.stop?.();
    detached.clear();
});

export function useAutosave<T>(options: Options<T>) {
    const owner = authGeneration();
    const recoveryKey = `${owner}:${options.id}`;
    const binding = useMemo(() => {
        // commit 전 render가 중단되어도 보존본을 잃지 않도록 effect에서만 꺼낸다.
        const previous = detached.get(recoveryKey)?.at(-1) as Binding<T> | undefined;
        if (previous) return previous;
        const reference = { current: options };
        return { reference, controller: new Autosave<T>(options, async (value, revision, key) => {
            if (owner !== authGeneration()) throw new ApiError(409, "actor_changed", "로그인이 바뀌어 이전 입력을 전송하지 않았어요.");
            const saved = await reference.current.save(value, revision, key);
            reference.current.onSaved?.(value, saved);
            return saved;
        }, options.draft) };
    }, [recoveryKey]);
    binding.reference.current = options;
    const controller = binding.controller;
    useEffect(() => {
        if (options.unversioned) controller.receiveValue(options.value);
        else controller.receive({ value: options.value, revision: options.revision });
    }, [controller, options.value, options.revision, options.unversioned]);
    useEffect(() => {
        forget(recoveryKey, binding);
        return () => {
            if (owner !== authGeneration()) return;
            if (binding.reference.current.flush !== false) controller.flush();
            remember(recoveryKey, binding);
        };
    }, [binding, controller, owner, recoveryKey]);
    const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
    const blur = (event: FocusEvent<HTMLInputElement | HTMLTextAreaElement>) => {
        const input = event.currentTarget;
        const invalid = input.form?.querySelector<HTMLInputElement | HTMLTextAreaElement>(":invalid")
            ?? (!input.validity.valid ? input : null);
        if (invalid) controller.reject(invalid.validationMessage);
        else controller.commitValid();
    };
    return { ...state, change: controller.change, commit: controller.commit,
        blur, reject: controller.reject, useRemote: controller.useRemote, applyMine: controller.applyMine, retry: controller.retry };
}
