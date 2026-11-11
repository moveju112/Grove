// 생성 metadata를 해석한다. 추가 필드는 같은 protocol의 확장을 위해 허용한다.
import { contractMetadata, type ContractTypes } from "./generated.metadata";

export type Schema =
    | { kind: "string" | "number" | "boolean" | "unknown" }
    | { kind: "literal"; value: string | number | boolean | null }
    | { kind: "array"; item: Schema }
    | { kind: "union"; options: readonly Schema[] }
    | { kind: "ref"; name: string }
    | { kind: "object"; fields: Readonly<Record<string, { optional: boolean; schema: Schema }>> };

function mismatch(schema: Schema, value: unknown, path: string): string | null {
    switch (schema.kind) {
        case "unknown": return null;
        case "string":
        case "boolean": return typeof value === schema.kind ? null : path;
        case "number": return typeof value === "number" && Number.isFinite(value) ? null : path;
        case "literal": return value === schema.value ? null : path;
        case "ref": return mismatch(contractMetadata[schema.name as keyof ContractTypes], value, path);
        case "union": return schema.options.some((option) => mismatch(option, value, path) === null) ? null : path;
        case "array":
            if (!Array.isArray(value)) return path;
            for (let i = 0; i < value.length; i++) {
                const error = mismatch(schema.item, value[i], `${path}[${i}]`);
                if (error) return error;
            }
            return null;
        case "object":
            if (value === null || typeof value !== "object" || Array.isArray(value)) return path;
            for (const [name, field] of Object.entries(schema.fields)) {
                const fieldPath = `${path}.${name}`;
                if (!Object.prototype.hasOwnProperty.call(value, name)) {
                    if (!field.optional) return fieldPath;
                    continue;
                }
                const error = mismatch(field.schema, (value as Record<string, unknown>)[name], fieldPath);
                if (error) return error;
            }
            return null;
    }
}

export class ContractError extends Error {
    readonly code = "invalid_response";
    constructor(public contract: keyof ContractTypes, public path: string) {
        // 응답 값은 오류·로그에 넣지 않는다.
        super(`서버 응답이 ${contract} 계약과 맞지 않습니다: ${path}`);
    }
}

export function parseContract<K extends keyof ContractTypes>(name: K, value: unknown): ContractTypes[K] {
    const error = mismatch(contractMetadata[name], value, "$");
    if (error) throw new ContractError(name, error);
    return value as ContractTypes[K];
}
