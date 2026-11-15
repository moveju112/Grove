import { StatusBadge } from "../design/StatusBadge";
import { List as GroveList, ListItem as GroveListItem } from "@astryxdesign/core/List";
import { Stack as GroveStack } from "@astryxdesign/core/Stack";
import { Avatar as AstryxAvatar } from "@astryxdesign/core/Avatar";
import { botAvatarStyles } from "./bot-avatar.stylex";
import { Text as GroveText } from "@astryxdesign/core/Text";
import { Button as GroveButton } from "../design/Button";
import { useEffect, useState } from "react";
import { ActionMenu } from "./ui/Controls";
import { BooleanSelect } from "./BooleanSelect";
import { TextInput, TextArea, FileInput } from "../design/Fields";
import { Select } from "../design/Select";
import { ApiError, api } from "../api/client";
import { useBotAvatar } from "../state/botAvatar";
import type { ModelProfile } from "../api/generated";
import { useQuery } from "../state/store";
import type { Opener } from "./Workspace";
import { ServerActionButton } from "./pwa/ServerActionButton";
import { useServerBlockReason } from "./pwa/lifecycle";
import { BotRooms } from "./BotRooms";
import { BotConnections } from "./BotConnections";
import { useCapability } from "../state/capabilities";

type Bot = {
    id: string;
    name: string;
    description: string;
    persona: string;
    instructions: string;
    profile_id: string | null;
    project_id: string;
    featured: boolean;
    avatar_color: string;
    avatar_sha256: string | null;
    status: "active" | "disabled" | "deleted";
    home_session_id: string | null;
    revision: number;
    runnable: boolean;
    model_state: "ok" | "not_configured" | "deleted" | "disabled";
    home_status: "idle" | "running" | "awaiting_approval" | "awaiting_input";
    unread: boolean;
};
type Project = { id: string; name: string };
const MODEL_STATE = { not_configured: "모델 없음", deleted: "모델 삭제됨", disabled: "모델 비활성" } as const;

// 숨김은 이 기기 화면 상태일 뿐이다(서버 실행·다른 기기에 영향 없음).
const HIDE_KEY = "grove.bots.hidden";
const loadHidden = (): string[] => {
    try {
        return JSON.parse(localStorage.getItem(HIDE_KEY) ?? "[]") as string[];
    } catch {
        return [];
    }
};

function Avatar({ b }: { b: Bot }) {
    const src = useBotAvatar(b.id, b.avatar_sha256);
    return <AstryxAvatar src={src ?? undefined} name={[...b.name][0] ?? "?"} size={24} tooltip={false}
        aria-hidden="true" data-testid={src ? "bot-avatar-image" : "bot-avatar-fallback"}
        xstyle={botAvatarStyles.custom(b.avatar_color, avatarInk(b.avatar_color))} />;
}

/// 기본형 아바타 글자색: 흰색과 거의 검은색 중 바탕과 대비가 큰 쪽(초록·주황 바탕의 흰 글자는 AA 미달).
export function avatarInk(hex: string): string {
    const m = /^#([0-9a-f]{6})$/i.exec(hex);
    if (!m) return "#ffffff";
    const ch = [0, 2, 4].map((i) => parseInt(m[1]!.slice(i, i + 2), 16) / 255).map((x) => (x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4));
    const lum = 0.2126 * ch[0]! + 0.7152 * ch[1]! + 0.0722 * ch[2]!;
    const dark = 0.0064; // #111318의 상대 휘도
    return 1.05 / (lum + 0.05) >= (lum + 0.05) / (dark + 0.05) ? "#ffffff" : "#111318";
}

/// 아바타 이미지 선택·기본형 복귀. 서버가 형식·크기·디코딩을 검사하고 PNG로 다시 저장한다.
function AvatarControl({ bot }: { bot: Bot }) {
    const serverBlocked = useServerBlockReason();
    const [err, setErr] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const run = async (fn: () => Promise<unknown>) => {
        setBusy(true);
        setErr(null);
        try { await fn(); } catch (e) { setErr(e instanceof ApiError ? e.message : "아바타 변경 실패"); } finally { setBusy(false); }
    };
    return <GroveStack direction="horizontal" align="center" gap={1.5} role="group" aria-label="봇 아바타">
        <Avatar b={bot} />
            <FileInput label="아바타 이미지 선택" accept="image/png,image/jpeg,image/gif,image/webp" isDisabled={busy || !!serverBlocked} disabledMessage={serverBlocked ?? undefined} value={null}
                onChange={(files) => {
                    const file = Array.isArray(files) ? files[0] : files;
                    if (!file) return;
                    void run(async () => {
                        if (file.size > 2 * 1024 * 1024) throw new ApiError(413, "too_large", "아바타 이미지는 2MiB 이하여야 합니다", false);
                        const data = new Uint8Array(await file.arrayBuffer());
                        let binary = "";
                        for (let i = 0; i < data.length; i += 8192) binary += String.fromCharCode(...data.subarray(i, i + 8192));
                        await api.put(`/bots/${bot.id}/avatar`, { data_base64: btoa(binary) });
                    });
                }} />
        {bot.avatar_sha256 && <ServerActionButton type="button" variant="secondary" density="compact" disabled={busy} onClick={() => void run(() => api.del(`/bots/${bot.id}/avatar`))}>기본형으로</ServerActionButton>}
        {err && <GroveText type="supporting" color="error" role="alert">{err}</GroveText>}
    </GroveStack>;
}

type Form = { name: string; description: string; persona: string; instructions: string; profile_id: string; project_id: string; featured: boolean };

function Editor({ bot, live, onDone }: { bot: Bot | null; live: Bot | null; onDone: () => void }) {
    const profiles = useQuery<ModelProfile[]>("profiles", () => api.get("/model-profiles"));
    const projects = useQuery<Project[]>("projects", () => api.get("/projects"));
    const [f, setF] = useState<Form>({
        name: bot?.name ?? "",
        description: bot?.description ?? "",
        persona: bot?.persona ?? "",
        instructions: bot?.instructions ?? "",
        profile_id: bot?.profile_id ?? "",
        project_id: bot?.project_id ?? "",
        featured: bot?.featured ?? false,
    });
    const [err, setErr] = useState<string | null>(null);
    const projectId = f.project_id || projects.data?.[0]?.id || "";
    const save = async () => {
        setErr(null);
        const body = { ...f, project_id: projectId, profile_id: f.profile_id || null };
        try {
            if (bot) await api.patch(`/bots/${bot.id}`, { ...body, expected_revision: bot.revision });
            else await api.post("/bots", body);
            onDone();
        } catch (e) {
            setErr(e instanceof ApiError ? (e.code === "revision_conflict" ? "다른 곳에서 먼저 바뀌었습니다. 다시 열어 수정하세요" : e.message) : "저장 실패");
        }
    };
    return (
        <GroveStack as="form" gap={2}
            data-testid="bot-editor"
            onSubmit={(e) => {
                e.preventDefault();
                void save();
            }}
        >
            {err && <GroveText as="p" display="block" type="inherit" color="error" role="alert">{err}</GroveText>}
            {bot && <AvatarControl bot={live ?? bot} />}
            <TextInput label="봇 이름" isLabelHidden placeholder="이름" value={f.name} onChange={(value) => setF({ ...f, name: value })} />
            <TextInput label="봇 설명" isLabelHidden placeholder="설명" value={f.description} onChange={(value) => setF({ ...f, description: value })} />
            <TextArea label="persona" isLabelHidden placeholder="persona(말투·성격)" rows={2} value={f.persona} onChange={(value) => setF({ ...f, persona: value })} />
            <TextArea label="작업 지침" isLabelHidden placeholder="작업 지침" rows={2} value={f.instructions} onChange={(value) => setF({ ...f, instructions: value })} />
            <Select label="봇 모델" hideLabel value={f.profile_id} onChange={(value) => setF({ ...f, profile_id: value })}
                options={[{ value: "", label: "모델 미설정(실행 불가)" }, ...(profiles.data ?? []).map((p) => ({
                    value: p.id, label: `${p.name} · ${p.model}${p.enabled === false ? " · 비활성" : ""}`, disabled: p.enabled === false,
                }))]} />
            <Select label="봇 프로젝트" hideLabel value={projectId} disabled={!!bot?.home_session_id}
                onChange={(value) => setF({ ...f, project_id: value })}
                options={(projects.data ?? []).map((p) => ({ value: p.id, label: p.name }))} />
            <BooleanSelect label="대표 봇" value={f.featured} onChange={(value) => setF({ ...f, featured: value })} />
            <GroveStack direction="horizontal" align="center" gap={1.5}>
                <ServerActionButton type="submit" disabled={!f.name.trim() || !projectId}>{bot ? "저장" : "봇 만들기"}</ServerActionButton>
                <GroveButton type="button" variant="secondary" onClick={onDone}>닫기</GroveButton>
            </GroveStack>
        </GroveStack>
    );
}

/// 봇 목록: 위임 역할과 별개로, 사용자가 직접 대화하는 상대.
export function BotsPanel({ open }: { open: Opener }) {
    const roomsSupported = useCapability("bot_rooms_v1");
    const connectionsSupported = useCapability("bot_connections_v1");
    const q = useQuery<{ bots: Bot[]; order_revision: number }>("bots", () => api.get("/bots"));
    const [hidden, setHidden] = useState<string[]>(loadHidden);
    const [showHidden, setShowHidden] = useState(false);
    const [showDeleted, setShowDeleted] = useState(false);
    const [editing, setEditing] = useState<Bot | "new" | null>(null);
    const [creatingRoom, setCreatingRoom] = useState(false);
    const [connections, setConnections] = useState<string | null>(null);
    const [err, setErr] = useState<string | null>(null);
    const all = q.data?.bots ?? [];
    const act = async (f: () => Promise<unknown>) => {
        setErr(null);
        try {
            await f();
        } catch (e) {
            setErr(e instanceof ApiError ? (e.code === "revision_conflict" ? "다른 곳에서 먼저 바뀌었습니다. 최신 목록을 불러왔습니다" : e.message) : "봇 변경 실패");
        }
        q.reload();
    };
    const toggleHide = (id: string) => {
        const next = hidden.includes(id) ? hidden.filter((x) => x !== id) : [...hidden, id];
        localStorage.setItem(HIDE_KEY, JSON.stringify(next));
        setHidden(next);
    };
    const visible = all.filter((b) => (showDeleted ? b.status === "deleted" : b.status !== "deleted") && (showHidden || !hidden.includes(b.id)));
    const status = (b: Bot, action: string) => act(() => api.post(`/bots/${b.id}/status`, { expected_revision: b.revision, action }));
    const enter = (b: Bot, how?: "right" | "down") =>
        act(async () => {
            const v = await api.post<Bot>(`/bots/${b.id}/home`);
            const s = await api.get<{ last_message_seq: number }>(`/sessions/${v.home_session_id}`);
            await api.post(`/bots/${b.id}/seen`, { seq: s.last_message_seq });
            open({ kind: "session", project_id: v.project_id, resource_id: v.home_session_id!, title: v.name }, how);
        });
    const moveUp = (i: number) => {
        const ids = visible.map((b) => b.id);
        [ids[i - 1], ids[i]] = [ids[i]!, ids[i - 1]!];
        void act(() => api.post("/bots/order", { expected_revision: q.data?.order_revision ?? 0, ids }));
    };
    return (
        <GroveStack as="section" gap={3} data-testid="bots-panel">
            <ActionMenu label="봇 작업">
                <GroveButton variant="secondary" density="compact" onClick={() => setEditing("new")}>봇 만들기</GroveButton>
                {roomsSupported !== false && <GroveButton variant="secondary" density="compact" onClick={() => setCreatingRoom(true)}>그룹 만들기</GroveButton>}
            </ActionMenu>
            {roomsSupported !== false && <BotRooms bots={all} creating={creatingRoom} onDone={() => setCreatingRoom(false)} open={open} />}
            {connectionsSupported !== false && connections && <GroveStack gap={2}>
                <BotConnections key={connections} botId={connections} />
                <GroveButton variant="secondary" density="compact" onClick={() => setConnections(null)}>연결 설정 닫기</GroveButton>
            </GroveStack>}
            {err && <GroveText as="p" display="block" type="inherit" color="error" role="alert">{err}</GroveText>}
            {editing && <Editor bot={editing === "new" ? null : editing}
                live={editing === "new" ? null : (q.data?.bots.find((x) => x.id === editing.id) ?? null)} onDone={() => { setEditing(null); q.reload(); }} />}
            <GroveList density="compact" edge="flush" hasDividers>
                {visible.map((b, i) => (
                    <GroveListItem key={b.id} data-testid="bot" data-status={b.status} label={<>
                        <ServerActionButton appearance="navigation" disabled={b.status === "deleted"} onClick={() => void enter(b)}>
                            <Avatar b={b} />
                            <GroveText type="inherit" color="inherit">
                                {b.featured && <GroveText type="inherit" color="inherit" aria-label="대표">★ </GroveText>}
                                {b.name}
                                {b.unread && <GroveText type="supporting" color="secondary" aria-label="읽지 않음" data-testid="bot-unread">●</GroveText>}
                            </GroveText>
                            {b.home_status === "running" && <StatusBadge status="running">실행 중</StatusBadge>}
                            {b.home_status === "awaiting_approval" && <StatusBadge status="awaiting_approval">승인 대기</StatusBadge>}
                            {b.home_status === "awaiting_input" && <StatusBadge status="awaiting_input">답변 대기</StatusBadge>}
                            {b.status === "disabled" && <StatusBadge>비활성</StatusBadge>}
                            {b.model_state !== "ok" && b.status !== "deleted" &&
                                <GroveText type="supporting" color="secondary">{MODEL_STATE[b.model_state]}</GroveText>}
                        </ServerActionButton>
                        <ActionMenu label={`${b.name} 관리`}>
                            {connectionsSupported !== false && b.status !== "deleted" && <GroveButton variant="secondary" density="compact" onClick={() => setConnections(b.id)}>외부 연결</GroveButton>}
                            {b.status !== "deleted" && <GroveButton variant="secondary" density="compact" onClick={() => setEditing(b)}>편집</GroveButton>}
                            {b.status !== "deleted" && <ServerActionButton variant="secondary" density="compact" onClick={() => void enter(b, "right")}>오른쪽에 열기</ServerActionButton>}
                            {b.status !== "deleted" && <ServerActionButton variant="secondary" density="compact" onClick={() => void enter(b, "down")}>아래에 열기</ServerActionButton>}
                            {i > 0 && !showDeleted && <ServerActionButton variant="secondary" density="compact" onClick={() => moveUp(i)}>위로</ServerActionButton>}
                            <GroveButton variant="secondary" density="compact" onClick={() => toggleHide(b.id)}>{hidden.includes(b.id) ? "이 기기에서 보이기" : "이 기기에서 숨기기"}</GroveButton>
                            {b.status === "active" && <ServerActionButton variant="secondary" density="compact" onClick={() => void status(b, "disable")}>비활성화</ServerActionButton>}
                            {b.status === "disabled" && <ServerActionButton variant="secondary" density="compact" onClick={() => void status(b, "enable")}>다시 켜기</ServerActionButton>}
                            {b.status !== "deleted" && b.home_session_id && (
                                <ServerActionButton variant="secondary" density="compact" onClick={() => { if (confirm(`'${b.name}' 대화를 보관하고 새로 시작할까요?`)) void status(b, "reset"); }}>대화 초기화</ServerActionButton>
                            )}
                            {b.status !== "deleted" && (
                                <ServerActionButton variant="destructive" density="compact" onClick={() => { if (confirm(`'${b.name}'을 삭제할까요? 대화는 보관되고 복원할 수 있습니다.`)) void status(b, "delete"); }}>삭제</ServerActionButton>
                            )}
                            {b.status === "deleted" && <ServerActionButton variant="secondary" density="compact" onClick={() => void status(b, "restore")}>복원</ServerActionButton>}
                        </ActionMenu>
                    </>} />
                ))}
            </GroveList>
            <GroveStack direction="horizontal" align="center" gap={1.5}>
                {hidden.length > 0 && <BooleanSelect label="숨긴 봇 보기" value={showHidden} onChange={setShowHidden} />}
                <BooleanSelect label="삭제된 봇" value={showDeleted} onChange={setShowDeleted} />
            </GroveStack>
        </GroveStack>
    );
}
