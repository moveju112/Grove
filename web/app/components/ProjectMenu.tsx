import { useState } from "react";
import { Stack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { api } from "../api/client";
import type { Project } from "../api/generated";
import { Button } from "../design/Button";
import { invalidate } from "../state/store";
import { ServerActionButton } from "./pwa/ServerActionButton";
import { useCapability } from "../state/capabilities";

export function ProjectMenu({ project, onClose, onHistory, onEdit }: {
    project: Project; onClose: () => void; onHistory: () => void; onEdit: (field: "name" | "icon") => void;
}) {
    const icons = useCapability("project_icons_v1");
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const archive = async () => {
        if (!confirm(`${project.name}을(를) 보관할까요? 목록에서만 빠지고 폴더·대화는 그대로이며 "보관됨"에서 복원할 수 있습니다.`)) return;
        setBusy(true);
        setError(null);
        try {
            await api.patch(`/projects/${project.id}`, { expected_revision: project.revision, archived: true });
            invalidate("projects");
            onClose();
        } catch (e) {
            setError(e instanceof Error ? e.message : "보관 실패");
        } finally {
            setBusy(false);
        }
    };
    return <Stack gap={1}>
        <ServerActionButton type="button" variant="secondary" density="compact" aria-haspopup="dialog" onClick={() => { onClose(); onEdit("name"); }}>이름 변경</ServerActionButton>
        {icons !== false && <ServerActionButton type="button" variant="secondary" density="compact" aria-haspopup="dialog" onClick={() => { onClose(); onEdit("icon"); }}>아이콘 변경</ServerActionButton>}
        <Button type="button" variant="secondary" density="compact" aria-haspopup="dialog" onClick={() => { onClose(); onHistory(); }}>기록</Button>
        {error && <Text as="p" display="block" type="inherit" color="error" role="alert">{error}</Text>}
        <ServerActionButton type="button" variant="secondary" density="compact" disabled={busy} onClick={() => void archive()}>보관</ServerActionButton>
        <Button type="button" variant="secondary" density="compact" onClick={onClose}>닫기</Button>
    </Stack>;
}
