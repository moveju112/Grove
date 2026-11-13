import { ApiError, api } from "./client";

export type McpOAuthConfig = {
    issuer: string;
    authorization_endpoint: string;
    token_endpoint: string;
    client_id: string;
    client_secret_id?: string;
    redirect_uri: string;
    scopes: string[];
};
export type OAuthStatus = {
    revision: number;
    attempt: null | { id: string; status: "pending" | "exchanging" | "completed" | "cancelled" | "expired" | "failed" | "unknown" | "interrupted"; kind: string; expires_at: string };
    credential: null | { expires_at: string; usable: boolean; refresh_available: boolean };
};
export type OAuthStarted = { attempt_id: string; authorization_url?: string; authorization_url_redacted?: boolean; expires_at: string };
export type OAuthCallback = { type: "grove-mcp-oauth"; state: string; code: string | null; error: string | null; iss: string };
export type OAuthAttempt = { action: "connect" | "complete" | "cancel" | "refresh"; body: unknown; key: string };
const path = (id: string) => `/mcp/servers/${encodeURIComponent(id)}/oauth`;
export const mcpOAuth = {
    status: (id: string) => api.get<OAuthStatus>(path(id)),
    send: (id: string, attempt: OAuthAttempt) => api.post<OAuthStarted | { status: string }>(
        `${path(id)}/${attempt.action}`, attempt.body, { key: attempt.key }),
};

export function uncertain(error: unknown): boolean {
    return !(error instanceof ApiError) || error.status === 0 || error.status >= 500
        || error.status === 408 || error.code === "result_unknown"
        || (error.details as { result_unknown?: boolean } | undefined)?.result_unknown === true;
}

export function callbackData(event: MessageEvent, origin: string, popup: Window | null, expectedState: string): OAuthCallback | null {
    if (!popup || event.source !== popup || event.origin !== origin || !expectedState) return null;
    const d = event.data as Partial<OAuthCallback> | null;
    if (!d || d.type !== "grove-mcp-oauth" || d.state !== expectedState || typeof d.iss !== "string"
        || (typeof d.code !== "string" && d.code !== null) || (typeof d.error !== "string" && d.error !== null)
        || (d.code === null) === (d.error === null)) return null;
    return d as OAuthCallback;
}
