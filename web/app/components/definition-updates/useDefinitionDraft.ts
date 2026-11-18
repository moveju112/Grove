import { useState } from "react";
type LocalDraft = { text: string; baseRevision: number; updatedAt: number };

export function useDefinitionDraft(kind: string, id: string) {
    // 채팅 저장과 별개인 설정 편집 오류 복구. 기존 설정 편집본의 키는 유지한다.
    const storageKey = `grove.draft.definition.${kind}.${id}`;
    const [draft, setDraft] = useState<LocalDraft | null>(() => {
        try {
            const saved = JSON.parse(localStorage.getItem(storageKey) ?? "null") as LocalDraft | null;
            return saved && typeof saved.text === "string" && Number.isSafeInteger(saved.baseRevision) && saved.baseRevision >= 0 ? saved : null;
        } catch { return null; }
    });
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
