import type { DefinitionDetail } from "../../api/generated";
import type { Store } from "../../state/drafts";

export const FIELDS = ["name", "description", "body"] as const;
export type Field = typeof FIELDS[number];
export const LABELS: Record<Field, string> = { name: "이름", description: "설명", body: "본문" };
export type Attempt = { key: string; definition: DefinitionDetail; fields: Field[] };
export const recoveryKey = (kind: string, id: string) => `grove.draft.definition-restore.${kind}.${id}`;

export function restoreBody(attempt: Attempt) {
    const d = attempt.definition;
    return {
        expected_revision: d.revision,
        fields: attempt.fields,
        expected_baseline: { name: d.baseline_name, description: d.baseline_description, body: d.baseline_body, sha256: d.baseline_sha256 },
    };
}

export function loadAttempt(store: Store, kind: string, id: string): Attempt | null {
    const raw = store.getItem(recoveryKey(kind, id));
    if (!raw) return null;
    const a = JSON.parse(raw) as Attempt;
    const d = a?.definition;
    if (!a || typeof a.key !== "string" || !a.key || !Array.isArray(a.fields) || !a.fields.length
        || a.fields.some((f) => !FIELDS.includes(f)) || !d || !d.builtin || d.kind !== kind || d.id !== id
        || !Number.isSafeInteger(d.revision) || d.revision < 0
        || typeof d.baseline_sha256 !== "string" || typeof d.enabled !== "boolean"
        || FIELDS.some((f) => typeof d[f] !== "string" || typeof d[`baseline_${f}`] !== "string")) {
        throw new Error("저장된 복원 요청을 읽지 못했습니다. 결과를 확인하기 전 새 복원을 실행하지 않습니다.");
    }
    return a;
}
