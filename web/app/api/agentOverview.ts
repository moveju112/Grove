import { api } from "./client";

export type OverviewTarget = { projectId?: string; sessionId?: string };
export type OverviewProfile =
    | { status: "configured" | "disabled"; name: string; model: string }
    | { status: "unset" | "missing" | "unknown" };
export type OverviewRole = {
    id: string; name: string; description: string; body: string;
    builtin: boolean; modified_fields: string[]; enabled: boolean; revision: number;
    availability: "disabled" | "unknown" | "delegation_off" | "policy_denied" | "tools_disabled" | "available" | "depth_limit" | "needs_session";
};
export type AgentOverviewData = {
    project_id: string | null; session_id: string | null; roles: OverviewRole[];
    delegation: { mode: "off" | "ask" | "auto" | null; source: string; approval: "blocked" | "auto" | "ask" | "unknown" };
    parent: { status: "active"; profile: OverviewProfile; tools_enabled: boolean } | { status: "no_active_turn" | "no_session" };
    next_request_default: OverviewProfile & { source: string };
    limits: { max_depth: number; max_per_parent: number; max_running: number };
};

export function getAgentOverview(target: OverviewTarget): Promise<AgentOverviewData> {
    const params = new URLSearchParams();
    if (target.sessionId) params.set("session_id", target.sessionId);
    else if (target.projectId) params.set("project_id", target.projectId);
    return api.get(`/agent-overview?${params}`);
}
