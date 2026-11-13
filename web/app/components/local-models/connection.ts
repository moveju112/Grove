import { ApiError, newKey } from "../../api/client";

export type LocalDraft = { name: string; base_url: string; model: string; secret_id: string };
export type LocalProfileInput = {
    name: string; protocol: "openai"; base_url: string; model: string; secret_id: string | null;
};
export type CreateLocalProfile = (body: LocalProfileInput, key: string) => Promise<unknown>;

export function localProfileInput(draft: LocalDraft): LocalProfileInput {
    const name = draft.name.trim();
    const base_url = draft.base_url.trim().replace(/\/+$/, "");
    const model = draft.model.trim();
    if (!name || name.length > 80) throw new Error("프로필 이름은 1~80자로 입력하세요.");
    let url: URL;
    try { url = new URL(base_url); } catch { throw new Error("서버가 접근할 HTTP(S) endpoint를 입력하세요."); }
    if (!["http:", "https:"].includes(url.protocol) || !url.hostname || /\s/.test(base_url)) {
        throw new Error("서버가 접근할 HTTP(S) endpoint를 입력하세요.");
    }
    if (url.username || url.password || url.search || url.hash) {
        throw new Error("endpoint에는 계정·키·query·fragment를 넣지 마세요. 필요한 키는 API 키에서 선택하세요.");
    }
    if (!model || model.length > 200 || /\s/.test(model)) throw new Error("수동 모델 ID를 공백 없이 입력하세요.");
    return { name, protocol: "openai", base_url, model, secret_id: draft.secret_id || null };
}

// 결과가 불명확한 생성은 같은 본문·키로만 확인한다. 입력은 성공 전까지 지우지 않는다.
export class LocalProfileCreation {
    busy = false;
    pending: { body: LocalProfileInput; key: string } | null = null;

    async run(draft: LocalDraft, create: CreateLocalProfile): Promise<boolean> {
        if (this.busy) return false;
        const body = localProfileInput(draft);
        if (this.pending && JSON.stringify(this.pending.body) !== JSON.stringify(body)) {
            throw new Error("이전 연결 저장 요청의 결과를 먼저 확인하세요.");
        }
        const attempt = this.pending ?? { body, key: newKey() };
        this.pending = attempt;
        this.busy = true;
        try {
            await create(attempt.body, attempt.key);
            this.pending = null;
            return true;
        } catch (error) {
            const unknown = !(error instanceof ApiError) || error.status >= 500 || error.status === 408
                || (error.details as { result_unknown?: boolean } | undefined)?.result_unknown === true;
            if (!unknown) this.pending = null;
            throw error;
        } finally {
            this.busy = false;
        }
    }
}
