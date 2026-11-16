import { useId, useRef, useState, type ReactNode } from "react";
import { Stack, StackItem } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { Heading } from "@astryxdesign/core/Heading";
import { Button } from "../design/Button";
import { TextInput } from "../design/Fields";
import { ApiError, api } from "../api/client";
import type { Project, ProjectFolder } from "../api/generated";
import { useQuery } from "../state/store";
import { useCapability } from "../state/capabilities";
import { groupProjects } from "../state/projectFolders";
import { ActionMenu } from "./ui/Controls";
import { Icon } from "./icons";
import { CreationDialog } from "./create/CreationDialog";
import { CreationRequest } from "./create/creation";
import { ServerActionButton } from "./pwa/ServerActionButton";
import { requireServerAction } from "./pwa/lifecycle";

const requirements = { requires: ["project_folders_v1"] };

export function useProjectFolders() {
    const supported = useCapability("project_folders_v1");
    const query = useQuery<ProjectFolder[]>(supported === false ? null : "project-folders",
        () => api.get("/project-folders", requirements));
    return { ...query, supported };
}

export function ProjectFolderDialog({ folder, onDone, onClose }: {
    folder?: ProjectFolder; onDone: (folder: ProjectFolder) => void; onClose: () => void;
}) {
    const [name, setName] = useState(folder?.name ?? "");
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const [request] = useState(() => new CreationRequest<ProjectFolder>(folder ? "patch" : "post"));
    const unresolved = request.pending !== null;
    const close = () => { if (!request.busy && !request.pending) onClose(); };
    const save = async () => {
        if (request.busy) return;
        setBusy(true);
        setError(null);
        try {
            requireServerAction();
            const pending = request.pending;
            const result = await request.run(pending?.path ?? (folder ? `/project-folders/${folder.id}` : "/project-folders"),
                pending?.body ?? { name: name.trim(), ...(folder ? { expected_revision: folder.revision } : {}) });
            if (result) onDone(result);
        } catch (cause) {
            setError(cause instanceof Error ? cause.message : "폴더를 저장하지 못했어요.");
        } finally { setBusy(false); }
    };
    const title = folder ? "폴더 이름 변경" : "폴더 추가";
    return <CreationDialog label={title} onClose={close} busy={busy}>
        <Heading level={2}>{title}</Heading>
        <Stack as="form" gap={2} onSubmit={(event) => { event.preventDefault(); void save(); }}>
            <TextInput label="폴더 이름" value={name} onChange={setName} maxLength={80} hasAutoFocus isRequired isDisabled={busy || unresolved} />
            {error && <Text color="error" role="alert">{error}</Text>}
            {unresolved && !busy && <Text color="warning" role="status">저장 결과를 확인하지 못했어요. 같은 요청으로 결과를 확인해 주세요.</Text>}
            <Stack direction="horizontal" gap={2}>
                <ServerActionButton type="submit" disabled={busy || !name.trim()}>{unresolved ? "같은 요청 결과 확인" : folder ? "저장" : "추가"}</ServerActionButton>
                <Button type="button" variant="secondary" disabled={busy || unresolved} onClick={close}>취소</Button>
            </Stack>
        </Stack>
    </CreationDialog>;
}

function FolderSection({ folder, children }: { folder: ProjectFolder; children: ReactNode }) {
    const id = useId();
    const [expanded, setExpanded] = useState(true);
    const [renaming, setRenaming] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const removing = useRef(false);
    const remove = async () => {
        if (removing.current || !confirm(`${folder.name} 폴더만 삭제할까요? 프로젝트·대화·실제 파일은 그대로 남고 프로젝트는 목록으로 이동해요.`)) return;
        removing.current = true;
        setBusy(true);
        setError(null);
        try {
            await api.del(`/project-folders/${folder.id}?expected_revision=${folder.revision}`, requirements);
        } catch (cause) {
            setError(cause instanceof ApiError ? cause.message : "폴더 삭제 결과를 확인하지 못했어요.");
        } finally { removing.current = false; setBusy(false); }
    };
    return <Stack as="section" gap={0} aria-label={`${folder.name} 폴더`} data-testid="project-folder" data-folder-id={folder.id}>
        <Stack direction="horizontal" align="center" gap={0} minHeight={32}>
            <Button type="button" appearance="navigation" aria-expanded={expanded} aria-controls={id} onClick={() => setExpanded((value) => !value)}>
                <Icon name={expanded ? "chevronDown" : "chevronRight"} size={12} />
                <Icon name="folder" size={16} />
                <StackItem as="span" size="fill"><Text type="inherit" color="inherit" maxLines={1}>{folder.name}</Text></StackItem>
            </Button>
            <ActionMenu label={`${folder.name} 폴더 메뉴`}>
                <Button type="button" appearance="navigation" aria-haspopup="dialog" disabled={busy} onClick={() => setRenaming(true)}>이름 변경</Button>
                <ServerActionButton type="button" appearance="navigation" disabled={busy} onClick={() => void remove()}>폴더 삭제</ServerActionButton>
            </ActionMenu>
        </Stack>
        {error && <Text type="supporting" color="error" role="alert">{error}</Text>}
        <Stack id={id} gap={0} paddingInlineStart={3} hidden={!expanded}>{children}</Stack>
        {renaming && <ProjectFolderDialog folder={folder} onDone={() => setRenaming(false)} onClose={() => setRenaming(false)} />}
    </Stack>;
}

export function ProjectFolderTree({ projects, folders, renderProject }: {
    projects: Project[]; folders: ProjectFolder[]; renderProject: (project: Project) => ReactNode;
}) {
    return <>{groupProjects(projects, folders).map((group) => group.folder
        ? <FolderSection key={group.folder.id} folder={group.folder}>{group.projects.map(renderProject)}</FolderSection>
        : <Stack key="unfiled" gap={0}>{group.projects.map(renderProject)}</Stack>)}</>;
}
