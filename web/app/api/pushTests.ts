import { api } from "./client";
import type { PushTest } from "./generated";

export type PushTestRequest = { endpoint: string; delay_seconds: 0 | 10 };
const requires = ["web_push_tests_v1"];

export const createPushTest = (body: PushTestRequest, key: string) =>
    api.post<PushTest>("/web-push/tests", body, { key, requires, contract: "PushTest" });
export const getPushTest = (id: string) =>
    api.getContract("PushTest", `/web-push/tests/${encodeURIComponent(id)}`, { requires });
