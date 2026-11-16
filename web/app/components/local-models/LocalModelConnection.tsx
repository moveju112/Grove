import { Stack as GroveStack } from "@astryxdesign/core/Stack";
import { Text as GroveText } from "@astryxdesign/core/Text";
import { Button as GroveButton } from "../../design/Button";
import { useState } from "react";
import { DetailDialog } from "../ui/Controls";
import type { SecretInfo } from "../../api/generated";
import { useServerBlockReason } from "../pwa/lifecycle";
import { LocalProfileCreation, type CreateLocalProfile, type LocalDraft } from "./connection";
import { TextInput } from "../../design/Fields";
import { Select } from "../../design/Select";

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
        <GroveText as="p" display="block" type="supporting" color="secondary">localhost는 Grove 서버가 실행되는 컴퓨터를 가리킵니다.</GroveText>
        <GroveStack as="form" gap={1.5} direction="horizontal" align="center" wrap="wrap" aria-label="로컬 HTTP 모델 연결" onSubmit={(event) => { event.preventDefault(); void save(); }}>
            <TextInput label="로컬 연결 이름" isLabelHidden placeholder="로컬 연결 이름" maxLength={80} isRequired isDisabled={locked}
                value={draft.name} onChange={(value) => setDraft({ ...draft, name: value })} />
            <TextInput label="로컬 endpoint" isLabelHidden placeholder="http://127.0.0.1:8000/v1" isRequired isDisabled={locked}
                value={draft.base_url} onChange={(value) => setDraft({ ...draft, base_url: value })} />
            <TextInput label="로컬 수동 모델 ID" isLabelHidden placeholder="서버에서 제공하는 모델 ID" maxLength={200} isRequired isDisabled={locked}
                value={draft.model} onChange={(value) => setDraft({ ...draft, model: value })} />
            <Select label="로컬 인증 비밀" hideLabel disabled={locked} value={draft.secret_id}
                onChange={(value) => setDraft({ ...draft, secret_id: value })}
                options={[{ value: "", label: "키 없음(인증이 필요 없을 때)" },
                    ...secrets.map((secret) => ({ value: secret.id, label: `${secret.label} · ${secret.masked}` }))]} />
            <GroveButton type="submit" disabled={status === "saving" || !!serverBlocked} title={serverBlocked ?? undefined}>
                {status === "saving" ? "연결 추가 중…" : creation.pending ? "요청 결과 확인" : "연결 추가"}
            </GroveButton>
        </GroveStack>
        {serverBlocked && <GroveText as="p" display="block" type="supporting" color="warning" role="status">{serverBlocked}</GroveText>}
        {status === "saved" && <GroveText as="p" display="block" type="inherit" color="inherit" role="status">로컬 프로필 저장됨</GroveText>}
        {status === "error" && <GroveText as="p" display="block" type="inherit" color="error" role="alert">{error} 입력은 보존했습니다.</GroveText>}
        {status === "error" && creation.pending && <GroveText as="p" display="block" type="inherit" color="warning" role="status">
            저장 결과가 불명확합니다. 자동 재전송하지 않습니다. 같은 요청을 확인할 때까지 입력을 유지하세요.
        </GroveText>}
    </DetailDialog>;
}
