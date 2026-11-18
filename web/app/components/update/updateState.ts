import { ApiError } from "../../api/client";

export const updateStatusKey = "server-update-settings";

export function updateResultUnknown(error: unknown): boolean {
    return !(error instanceof ApiError) || error.status === 0 || error.status >= 500 || error.status === 408
        || error.code === "result_unknown"
        || (error.details as { result_unknown?: boolean } | undefined)?.result_unknown === true;
}
