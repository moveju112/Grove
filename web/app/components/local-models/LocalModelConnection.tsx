import { useState } from "react";
import { DetailDialog } from "../ui/Controls";
import type { SecretInfo } from "../../api/generated";
import { useServerBlockReason } from "../pwa/lifecycle";
import { LocalProfileCreation, type CreateLocalProfile, type LocalDraft } from "./connection";

const EMPTY: LocalDraft = { name: "", base_url: "", model: "", secret_id: "" };

export function LocalModelConnection({ secrets, onCreate }: { secrets: SecretInfo[]; onCreate: CreateLocalProfile }) {
    const serverBlocked = useServerBlockReason();
    const [draft, setDraft] = useState<LocalDraft>(EMPTY);
    const [creation] = useState(() => new LocalProfileCreation());
    const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
    const [error, setError] = useState("");
    const locked = status === "saving" || creation.pending !== null;
    const save = async () => {
        if (creation.busy || serverBlocked) return;
        setStatus("saving");
        try {
            if (await creation.run(draft, onCreate)) {
                setDraft(EMPTY);
                setStatus("saved");
            }
        } catch (error) {
            setError(error instanceof Error ? error.message : "연결 설정을 저장하지 못했습니다.");
            setStatus("error");
        }
    };
    return <DetailDialog data-testid="local-model-connection" label="로컬 HTTP 모델 연결" title="로컬 HTTP 모델 연결">
        <p className="muted small">localhost는 Grove 서버가 실행되는 컴퓨터를 가리킵니다.</p>
        <form className="inline wrap" aria-label="로컬 HTTP 모델 연결" onSubmit={(event) => { event.preventDefault(); void save(); }}>
            <input aria-label="로컬 연결 이름" placeholder="로컬 연결 이름" maxLength={80} required disabled={locked}
                value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} />
            <input aria-label="로컬 endpoint" placeholder="http://127.0.0.1:8000/v1" required disabled={locked}
                value={draft.base_url} onChange={(event) => setDraft({ ...draft, base_url: event.target.value })} />
            <input aria-label="로컬 수동 모델 ID" placeholder="서버에서 제공하는 모델 ID" maxLength={200} required disabled={locked}
                value={draft.model} onChange={(event) => setDraft({ ...draft, model: event.target.value })} />
            <select aria-label="로컬 인증 비밀" disabled={locked} value={draft.secret_id}
                onChange={(event) => setDraft({ ...draft, secret_id: event.target.value })}>
                <option value="">키 없음(인증이 필요 없을 때)</option>
                {secrets.map((secret) => <option key={secret.id} value={secret.id}>{secret.label} · {secret.masked}</option>)}
            </select>
            <button type="submit" disabled={status === "saving" || !!serverBlocked} title={serverBlocked ?? undefined}>
                {status === "saving" ? "저장 중…" : creation.pending ? "같은 연결 저장 요청 확인" : "로컬 연결 저장"}
            </button>
        </form>
        {serverBlocked && <p className="warn small" role="status">{serverBlocked}</p>}
        {status === "saved" && <p role="status">로컬 프로필 저장됨</p>}
        {status === "error" && <p className="err" role="alert">{error} 입력은 보존했습니다.</p>}
        {status === "error" && creation.pending && <p className="warn" role="status">
            저장 결과가 불명확합니다. 자동 재전송하지 않습니다. 같은 요청을 확인할 때까지 입력을 유지하세요.
        </p>}
    </DetailDialog>;
}
