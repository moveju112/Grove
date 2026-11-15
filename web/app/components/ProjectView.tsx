import { StatusBadge } from "../design/StatusBadge";
import { Code } from "@astryxdesign/core/Code";
import { StackItem } from "@astryxdesign/core/Stack";
import { chatLayout } from "./chat-layout.stylex";
import { List as GroveList, ListItem as GroveListItem } from "@astryxdesign/core/List";
import { Text as GroveText } from "@astryxdesign/core/Text";
import { Heading } from "@astryxdesign/core/Heading";
import { Button as GroveButton } from "../design/Button";
import { useState } from "react";
import { When } from "./When";
import { ApiError, api } from "../api/client";
import type { Project, SessionPage } from "../api/generated";
import { useQuery } from "../state/store";
import { ProjectComposer } from "./create/ProjectComposer";
import { GitPanel } from "./GitPanel";
import { FilesView } from "./FilesView";
import { SchedulesPanel } from "./SchedulesPanel";
import { TrashPanel } from "./TrashPanel";
import { WorktreesPanel } from "./WorktreesPanel";
import { ProjectScripts } from "./ProjectScripts";
import type { Opener } from "./Workspace";
import { ServerActionButton } from "./pwa/ServerActionButton";
import { requireServerAction } from "./pwa/lifecycle";
import { Stack } from "@astryxdesign/core/Stack";
import { ActionMenu, Panel, ToolsTrigger, Workbench } from "./ui/Controls";
import { Icon } from "./icons";
import { TextInput } from "../design/Fields";

/// 프로젝트 이름·아이콘 변경(PROJECT-002). revision 충돌이면 최신 값을 다시 불러와 알린다.
function ProjectIdentity({ p, reload }: { p: Project; reload: () => void }) {
    const [edit, setEdit] = useState(false);
    const [name, setName] = useState(p.name);
    const [icon, setIcon] = useState(p.icon ?? "");
    const [err, setErr] = useState<string | null>(null);
    if (!edit) {
        return (
            <GroveButton
                variant="secondary" density="compact"
                onClick={(event) => {
                    event.preventDefault();
                    setName(p.name);
                    setIcon(p.icon ?? "");
                    setErr(null);
                    setEdit(true);
                }}
            >
                이름·아이콘
            </GroveButton>
        );
    }
    const save = async () => {
        setErr(null);
        try {
            await api.patch(`/projects/${p.id}`, { expected_revision: p.revision, name: name.trim(), icon: icon.trim() || null });
            setEdit(false);
            reload();
        } catch (e) {
            if (e instanceof ApiError && e.code === "revision_conflict") reload();
            setErr(e instanceof ApiError ? e.message : "저장하지 못했습니다");
        }
    };
    return (
        <Stack as="form"
            gap={1.5} direction="horizontal" align="center"
            aria-label="프로젝트 이름·아이콘"
            onSubmit={(e) => {
                e.preventDefault();
                void save();
            }}
        >
            <TextInput label="아이콘" isLabelHidden value={icon} onChange={setIcon} placeholder="예: 🌱" width={72} />
            <TextInput label="프로젝트 이름" isLabelHidden value={name} onChange={setName} isRequired />
            <ServerActionButton density="compact" type="submit">저장</ServerActionButton>
            <GroveButton variant="secondary" density="compact" type="button" onClick={() => setEdit(false)}>취소</GroveButton>
            {err && <GroveText type="inherit" color="error" role="alert">{err}</GroveText>}
        </Stack>
    );
}

/// 프로젝트 = 단일 작업공간. 중간 생성 단계 없이 입력창에서 바로 새 대화를 시작한다.
export function ProjectView({ tabId, projectId, open, initialTitle }: { tabId: string; projectId: string; open: Opener; initialTitle?: string }) {
    const [q, setQ] = useState("");
    const [archived, setArchived] = useState(false);
    const [pages, setPages] = useState<string[]>([""]);
    const project = useQuery<Project>(`project:${projectId}`, () => api.get(`/projects/${projectId}`));
    // 첫 페이지와 같은 key라 같은 요청을 공유한다. 대화가 하나도 없으면 검색 도구를 띄우지 않는다.
    const firstQs = new URLSearchParams({ limit: "30", q: "", archived: "false" });
    const first = useQuery<SessionPage>(`sessions:${projectId}:${firstQs}`, () => api.get(`/projects/${projectId}/sessions?${firstQs}`));
    const filtered = q !== "" || archived;
    const showSearch = filtered || (first.data?.items.length ?? 0) > 0;
    const setArchivedView = (value: boolean) => { setArchived(value); setPages([""]); };

    // 확인 중에는 입력을 막지 않는다. 경로 없음·조회 실패만 실행 차단 사유로 표시한다.
    const composer = <ProjectComposer projectId={projectId} tabId={tabId} open={open}
        beforeMutation={requireServerAction}
        disabled={project.error ? "프로젝트를 확인할 수 없습니다" : project.data && !project.data.available ? "프로젝트 경로 없음" : null} />;
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
                { id: "files", label: "파일", icon: "file", lazy: true, content: <FilesView tabId={`${tabId}:files`} projectId={projectId} /> },
                { id: "scripts", label: "스크립트", content: <ProjectScripts projectId={projectId} projectName={project.data?.name ?? projectId} open={open} /> },
                { id: "schedules", label: "예약", content: <SchedulesPanel projectId={projectId} open={open} /> },
                { id: "worktrees", label: "워크스페이스", content: <WorktreesPanel key={`worktrees:${projectId}`} projectId={projectId} /> },
                { id: "trash", label: "휴지통", content: <TrashPanel key={`trash:${projectId}`} projectId={projectId} /> },
            ]}>
            <Stack as="header" direction="horizontal" align="center" gap={2}>
                <Heading level={1} color="inherit" xstyle={chatLayout.headerTitle}>
                    {project.data?.icon && <GroveText type="inherit" color="inherit" aria-hidden>{project.data.icon} </GroveText>}
                    {project.data?.name ?? initialTitle ?? "프로젝트"}
                </Heading>
                <ActionMenu label="프로젝트 작업">
                <Code color="secondary">{project.data?.root_path}</Code>
                <GroveButton variant="secondary" density="compact" onClick={() => open({ kind: "file", project_id: projectId, title: `파일 · ${project.data?.name ?? ""}` })}>
                    파일 탭으로 열기
                </GroveButton>
                <GroveButton variant="secondary" density="compact" aria-pressed={archived} onClick={() => setArchivedView(!archived)}>
                    {archived ? "현재 대화 보기" : "보관된 대화 보기"}
                </GroveButton>
                {project.data && <ProjectIdentity p={project.data} reload={project.reload} />}
                <GroveButton variant="secondary" density="compact" onClick={() => open({ kind: "settings", project_id: projectId, resource_id: "settings", title: `설정 · ${project.data?.name ?? ""}` })}>
                    프로젝트 설정
                </GroveButton>
                </ActionMenu>
                <ToolsTrigger />
            </Stack>
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
            <Stack as="section" gap={3} width="100%" maxWidth={720} xstyle={chatLayout.centered} aria-label="프로젝트 대화">
            {showSearch && <Stack direction="horizontal" align="center" gap={2}>
                <StackItem size="fill"><TextInput type="search" label="대화 검색" isLabelHidden placeholder="대화 검색" value={q}
                    onChange={(value) => { setQ(value); setPages([""]); }} /></StackItem>
                {/* 숨겨진 필터가 목록을 바꾸면 활성 상태와 해제 경로를 목록 바로 위에 남긴다. */}
                {archived && <GroveButton type="button" variant="secondary" density="compact" appearance="choice" aria-label="보관됨 필터 해제" onClick={() => setArchivedView(false)}>
                    보관됨 <Icon name="close" size={12} />
                </GroveButton>}
            </Stack>}
            <GroveList density="compact" edge="flush" hasDividers>
                {pages.map((cursor, i) => (
                    <SessionPageList key={cursor + i} projectId={projectId} cursor={cursor} q={q} archived={archived} filtered={filtered} open={open} onMore={(c) => setPages((p) => (p.includes(c) ? p : [...p, c]))} last={i === pages.length - 1} />
                ))}
            </GroveList>
            </Stack>
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
    const openTerm = (t: TerminalRow) => {
        open({ kind: "terminal", project_id: projectId, resource_id: t.id, title: t.name });
        void api.post("/recent/touch", { kind: "terminal", project_id: projectId, resource_id: t.id, title: t.name }).catch(() => undefined);
    };
    const create = async () => {
        setErr(null);
        try {
            const t = await api.post<TerminalRow>(`/projects/${projectId}/terminals`, { name: "터미널" });
            openTerm(t);
        } catch (e) {
            setErr(e instanceof ApiError ? e.message : "터미널을 열지 못했습니다");
        }
        list.reload();
    };
    const terms = list.data?.terminals ?? [];
    return (
        <Panel data-testid="terminal-list" title={`터미널${terms.length > 0 ? ` · ${terms.length}` : ""}`}>
            <ServerActionButton variant="secondary" density="compact" onClick={() => void create()}>새 터미널</ServerActionButton>
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

function SessionPageList(p: { projectId: string; cursor: string; q: string; archived: boolean; filtered: boolean; open: Opener; onMore: (c: string) => void; last: boolean }) {
    const qs = new URLSearchParams({ limit: "30", q: p.q, archived: String(p.archived) });
    if (p.cursor) qs.set("cursor", p.cursor);
    const page = useQuery<SessionPage>(`sessions:${p.projectId}:${qs}`, () => api.get(`/projects/${p.projectId}/sessions?${qs}`));
    return (
        <>
            {(page.data?.items ?? []).map((s) => (
                <GroveListItem key={s.id} label={<Stack direction="horizontal" align="center" gap={1}>
                    <GroveButton appearance="link" onClick={() => p.open({ kind: "session", project_id: p.projectId, resource_id: s.id, title: s.title })}>
                        {s.unread && <GroveText type="supporting" color="secondary" aria-label="읽지 않음" data-testid="session-unread">● </GroveText>}
                        {s.title}
                    </GroveButton>
                    {s.preview && <GroveText type="supporting" color="secondary" maxLines={1}>{s.preview}</GroveText>}
                    {s.active_turn === "awaiting_input" ? (
                        <StatusBadge status="awaiting_input">답변 대기</StatusBadge>
                    ) : (
                        s.active_turn && <StatusBadge status="running">실행 중</StatusBadge>
                    )}
                    {s.pending_approvals > 0 && <StatusBadge status="awaiting_approval">승인 {s.pending_approvals}</StatusBadge>}
                    {s.unreviewed_unknown > 0 && <StatusBadge status="unknown_result">결과 확인 필요</StatusBadge>}
                    <GroveText type="supporting" color="secondary" data-testid="session-updated"><When at={s.updated_at} /></GroveText>
                </Stack>} />
            ))}
            {p.last && page.data?.next_cursor && (
                <GroveListItem label={
                    <GroveButton variant="secondary" onClick={() => p.onMore(page.data!.next_cursor!)}>
                        더 보기
                    </GroveButton>
                } />
            )}
            {/* 빈 프로젝트는 빈 화면으로 둔다. 필터 결과가 비었을 때만 알린다. */}
            {p.filtered && p.cursor === "" && page.data?.items.length === 0 && <GroveListItem label={<GroveText color="secondary">조건에 맞는 대화가 없습니다.</GroveText>} />}
        </>
    );
}
