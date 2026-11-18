import { createContext, useContext, useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { ComposerMemory } from "./composerMemory";

const Context = createContext<ComposerMemory | null>(null);

// SavedLayout가 소유한다. 인증 종료로 Workspace가 사라지면 이전 입력도 함께 버린다.
export function ComposerMemoryProvider({ copies, children }: { copies: string[]; children: ReactNode }) {
    const [memory] = useState(() => new ComposerMemory());
    useEffect(() => memory.retain(new Set(copies)), [memory, copies]);
    return <Context.Provider value={memory}>{children}</Context.Provider>;
}

export function useComposerMemory<T>(resource: string, copyId: string, field: string, initial: () => T) {
    const memory = useContext(Context);
    if (!memory) throw new Error("ComposerMemoryProvider is required");
    const cell = memory.cell(resource, copyId, field, initial);
    const value = useSyncExternalStore(cell.subscribe, cell.read, cell.read);
    return [value, cell.set] as const;
}
