import { useState } from "react";
import { key, load, type LocalDraft } from "../../state/drafts";

export function useDefinitionDraft(kind: string, id: string) {
    const storageKey = key(`definition.${kind}.${id}`);
    const [draft, setDraft] = useState<LocalDraft | null>(() => typeof localStorage === "undefined" ? null : load(localStorage, storageKey));
    const [error, setError] = useState<string | null>(null);
    const write = (next: LocalDraft | null) => {
        setDraft(next);
        try {
            if (next) localStorage.setItem(storageKey, JSON.stringify(next));
            else localStorage.removeItem(storageKey);
            setError(null);
        } catch { setError("초안은 화면에 남아 있지만 기기 저장에 실패했어. 화면을 닫기 전에 복사해 둬."); }
    };
    return { draft, error, write };
}
