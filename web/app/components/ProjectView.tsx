import { usePendingAction } from "../state/usePendingAction";
import { StatusBadge } from "../design/StatusBadge";
import { chatLayout } from "./chat-layout.stylex";
import { List as GroveList, ListItem as GroveListItem } from "@astryxdesign/core/List";
import { Text as GroveText } from "@astryxdesign/core/Text";
import { Heading } from "@astryxdesign/core/Heading";
import { Button as GroveButton } from "../design/Button";
import { useEffect, useState } from "react";
import { ApiError, api } from "../api/client";
import type { Project } from "../api/generated";
import { useQuery } from "../state/store";
import { createTerminal } from "./create/creation";
import { ProjectComposer } from "./create/ProjectComposer";
import { GitPanel } from "./GitPanel";
import { FilesView } from "./FilesView";
import { WorktreesPanel } from "./WorktreesPanel";
import { ProjectScripts } from "./ProjectScripts";
import type { Opener } from "./Workspace";
import { ServerActionButton } from "./pwa/ServerActionButton";
import { requireServerAction } from "./pwa/lifecycle";
import { onNewConversation } from "../state/newConversation";
import { Stack } from "@astryxdesign/core/Stack";
import { Panel, ToolsTrigger, Workbench } from "./ui/Controls";

// 프로젝트를 열면 바로 입력할 수 있다. 실제 대화는 첫 전송 때만 만든다.
export function ProjectView({ tabId, projectId, open, openCreated = open }: { tabId: string; projectId: string; open: Opener; openCreated?: Opener }) {
    const [composeVersion, setComposeVersion] = useState(1);
    useEffect(() => onNewConversation(projectId, () => setComposeVersion((v) => v + 1)), [projectId]);
    const project = useQuery<Project>(`project:${projectId}`, () => api.get(`/projects/${projectId}`));

    // 확인 중에는 입력을 막지 않는다. 경로 없음·조회 실패만 실행 차단 사유로 표시한다.
    const composer = composeVersion > 0 ? <ProjectComposer projectId={projectId} tabId={tabId} open={openCreated} focusVersion={composeVersion}
        beforeMutation={requireServerAction}
        disabled={project.error ? "프로젝트를 확인할 수 없습니다" : project.data && !project.data.available ? "프로젝트 경로 없음" : null} /> : null;
    if (project.error) return <Stack as="section" data-testid="project-view" gap={2} xstyle={chatLayout.view}>
        <Heading level={1} color="inherit">프로젝트를 열 수 없습니다</Heading>
        <GroveText as="p" display="block" type="inherit" color="error" role="alert">{project.error instanceof ApiError ? project.error.message : "프로젝트 정보를 불러오지 못했습니다."}</GroveText>
        <GroveButton variant="secondary" density="compact" onClick={project.reload}>프로젝트 다시 확인</GroveButton>
        {composer}
    </Stack>;

    return (
        <Stack as="section" data-testid="project-view" gap={2} xstyle={chatLayout.view}>
            <Workbench label="프로젝트 도구" tools={[
                { id: "git", label: "변경", icon: "changes", content: <GitPanel projectId={projectId} /> },
                { id: "terminals", label: "터미널", icon: "terminal", content: <TerminalList projectId={projectId} open={open} /> },
                { id: "files", label: "파일", icon: "file", lazy: true, content: <Stack gap={2}>
                    <GroveButton variant="secondary" density="compact" onClick={() => open({ kind: "file", project_id: projectId, title: `파일 · ${project.data?.name ?? ""}` })}>
                        파일 탭으로 열기
                    </GroveButton>
                    <FilesView tabId={`${tabId}:files`} projectId={projectId} />
                </Stack> },
                { id: "scripts", label: "스크립트", content: <ProjectScripts projectId={projectId} projectName={project.data?.name ?? projectId} open={open} /> },
                { id: "worktrees", label: "워크스페이스", content: <WorktreesPanel key={`worktrees:${projectId}`} projectId={projectId} /> },
                { id: "settings", label: "설정", content: (close) => <GroveButton variant="secondary" density="compact" aria-haspopup="dialog"
                    onClick={() => { close(); open({ kind: "settings", project_id: projectId, resource_id: "settings", title: `설정 · ${project.data?.name ?? projectId}` }); }}>
                    프로젝트 설정
                </GroveButton> },
            ]}>
            <ToolsTrigger inlineHeader />
                {project.data && !project.data.available && (
                    <GroveText as="div" display="block" type="inherit" color="error" role="alert" data-testid="project-missing">
                        프로젝트 경로에 접근할 수 없습니다(폴더 이동·삭제·권한 변경). 실행 요청은 거절됩니다. 대화 기록은 남아 있습니다.{" "}
                        <ServerActionButton
                            density="compact"
                            onClick={() => {
                                const r = prompt("폴더를 옮겼다면 새 경로를 입력하세요(서버 기준 절대 경로)", project.data!.root_path);
                                if (!r) return;
                                api.patch(`/projects/${projectId}`, { expected_revision: project.data!.revision, root_path: r })
                                    .then(() => project.reload())
                                    .catch((e: Error) => alert(`다시 연결하지 못했습니다: ${e.message}`));
                            }}
                        >
                            새 경로로 다시 연결
                        </ServerActionButton>
                    </GroveText>
                )}
            {composer}
            </Workbench>
        </Stack>
    );
}

type TerminalRow = { id: string; name: string; status: "running" | "exited" | "lost"; exit_code: number | null };

/// 프로젝트 터미널 목록·새 터미널. 끝난 터미널은 화면 보기·기록 삭제만 할 수 있다.
function TerminalList({ projectId, open }: { projectId: string; open: Opener }) {
    const list = useQuery<{ terminals: TerminalRow[] }>(`terminals:${projectId}`, () => api.get(`/projects/${projectId}/terminals`));
    const [err, setErr] = useState<string | null>(null);
    const creation = usePendingAction();
    const openTerm = (t: Pick<TerminalRow, "id" | "name">) => {
        open({ kind: "terminal", project_id: projectId, resource_id: t.id, title: t.name });
    };
    const create = async () => {
        setErr(null);
        try {
            const t = await createTerminal(projectId);
            if (t) openTerm(t);
        } catch (e) {
            setErr(e instanceof Error ? e.message : "터미널을 열지 못했습니다");
        }
        list.reload();
    };
    const terms = list.data?.terminals ?? [];
    return (
        <Panel data-testid="terminal-list" title={`터미널${terms.length > 0 ? ` · ${terms.length}` : ""}`}>
            <ServerActionButton variant="secondary" density="compact" disabled={creation.busy} onClick={() => void creation.run(create)}>{creation.busy ? "터미널 여는 중…" : "새 터미널"}</ServerActionButton>
            {err && <GroveText as="p" display="block" type="inherit" color="error" role="alert">{err}</GroveText>}
            <GroveList density="compact" edge="flush" hasDividers>
                {terms.map((t) => (
                    <GroveListItem key={t.id} label={<Stack direction="horizontal" align="center" gap={1}>
                        <GroveButton appearance="link" onClick={() => openTerm(t)}>{t.name}</GroveButton>
                        <StatusBadge status={t.status}>{t.status === "running" ? "실행 중" : t.status === "lost" ? "재시작으로 종료" : `종료(${t.exit_code ?? "?"})`}</StatusBadge>
                        {t.status !== "running" && (
                            <ServerActionButton variant="secondary" density="compact" onClick={() => void api.del(`/terminals/${t.id}`).then(list.reload)}>기록 삭제</ServerActionButton>
                        )}
                    </Stack>} />
                ))}
            </GroveList>
        </Panel>
    );
}
