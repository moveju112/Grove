import { useRef } from "react";
import type { ModelProfile } from "../../api/generated";
import { api } from "../../api/client";
import { invalidate } from "../../state/store";
import { useAutosave } from "./useAutosave";

export function useProfileDraft<T>(section: string, profile: ModelProfile, extract: (profile: ModelProfile) => T,
    options: (draft: T) => Record<string, unknown>, requires: string[] = [], flush = true) {
    const formRef = useRef<HTMLFormElement>(null);
    const state = useAutosave({
        id: `profile:${profile.id}:${section}`, value: extract(profile), revision: profile.revision, flush,
        save: async (value, revision, key) => {
            const body = { expected_revision: revision, options: options(value) };
            try {
                const saved = await api.put<ModelProfile>(`/model-profiles/${profile.id}`, body, { key, requires });
                return { value: extract(saved), revision: saved.revision };
            } finally { invalidate("profiles"); }
        },
    });
    const validate = () => {
        const invalid = formRef.current?.querySelector<HTMLInputElement>(":invalid");
        if (invalid) state.reject(invalid.validationMessage);
    };
    return { ...state, formRef, validate };
}
