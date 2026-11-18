import { useState } from "react";
import { Heading } from "@astryxdesign/core/Heading";
import { Stack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { ApiError } from "../api/client";
import type { Project } from "../api/generated";
import { Button } from "../design/Button";
import { TextInput } from "../design/Fields";
import { invalidate } from "../state/store";
import { CreationDialog } from "./create/CreationDialog";
import { CreationRequest } from "./create/creation";
import { ServerActionButton } from "./pwa/ServerActionButton";
import { requireServerAction } from "./pwa/lifecycle";

export function ProjectRenameDialog({ project, onClose }: { project: Project; onClose: () => void }) {
    const [name, setName] = useState(project.name);
    const [revision, setRevision] = useState(project.revision);
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const [request] = useState(() => new CreationRequest<Project, `/projects/${string}`>("patch"));
    const unresolved = request.pending !== null;
    const close = () => { if (!request.busy && !request.pending) onClose(); };
    const save = async () => {
        if (request.busy || !name.trim()) return;
        setBusy(true);
        setError(null);
        try {
            requireServerAction();
            const pending = request.pending;
            const result = await request.run(pending?.path ?? `/projects/${project.id}`,
                pending?.body ?? { name: name.trim(), expected_revision: revision });
            if (!result) return;
            invalidate("projects");
            invalidate(`project:${project.id}`);
            invalidate("recent");
            onClose();
        } catch (cause) {
            if (cause instanceof ApiError && cause.code === "revision_conflict") {
                const current = (cause.details as { current: Project }).current;
                setRevision(current.revision);
                invalidate("projects");
                invalidate(`project:${project.id}`);
                setError("다른 곳에서 프로젝트 정보가 바뀌었어요. 입력을 확인하고 다시 저장해 주세요.");
            } else {
                setError(cause instanceof Error ? cause.message : "프로젝트 이름을 저장하지 못했어요.");
            }
        } finally {
            setBusy(false);
        }
    };
    return <CreationDialog label="프로젝트 이름 변경" onClose={close} busy={busy} width="28em">
        <Heading level={2}>프로젝트 이름 변경</Heading>
        <Stack as="form" gap={3} onSubmit={(event) => { event.preventDefault(); void save(); }}>
            <TextInput label="프로젝트 이름" value={name} onChange={setName} maxLength={120}
                hasAutoFocus isRequired isDisabled={busy || unresolved} />
            {error && <Text as="p" type="supporting" color="error" role="alert">{error}</Text>}
            {unresolved && !busy && <Text as="p" type="supporting" color="warning" role="status">
                저장 결과를 확인하지 못했어요. 같은 요청으로 결과를 확인해 주세요.
            </Text>}
            <Stack direction="horizontal" gap={2}>
                <ServerActionButton type="submit" disabled={busy || !name.trim()}>
                    {unresolved ? "같은 요청 결과 확인" : "저장"}
                </ServerActionButton>
                <Button type="button" variant="secondary" disabled={busy || unresolved} onClick={close}>취소</Button>
            </Stack>
        </Stack>
    </CreationDialog>;
}
