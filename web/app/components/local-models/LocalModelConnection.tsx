import { useState } from "react";
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
    return <details data-testid="local-model-connection">
        <summary>선택적 로컬 HTTP 모델 연결</summary>
        <p className="muted small">
            OpenAI-compatible HTTP 서버의 endpoint를 직접 입력하세요(예: http://127.0.0.1:8000/v1).
            localhost는 이 브라우저·휴대폰이 아니라 Grove 서버가 실행되는 컴퓨터입니다.
            설치·자동 시작·다운로드·포트 검색은 하지 않습니다.
        </p>
        <p className="muted small">
            수동 모델 ID와 endpoint를 저장한 뒤 프로필에서 연결 확인·모델 목록 새로고침을 실행하세요.
            목록이 없거나 미지원이어도 수동 모델은 유지됩니다. 모델은 직접 선택해야 하며 목록 조회는 생성 요청을 보내지 않습니다.
        </p>
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
        {status === "saved" && <p role="status">로컬 프로필 저장됨. 연결 상태는 아래 프로필의 연결 확인 결과를 보세요. 사용할 대화에서 프로필을 명시적으로 선택하세요.</p>}
        {status === "error" && <p className="err" role="alert">{error} 입력은 보존했습니다.</p>}
        {status === "error" && creation.pending && <p className="warn" role="status">
            저장 결과가 불명확합니다. 자동 재전송하지 않습니다. 같은 요청을 확인할 때까지 입력을 유지하세요.
        </p>}
    </details>;
}
