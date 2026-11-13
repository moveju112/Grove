import { useEffect, useState } from "react";
import { ApiError, api } from "../api/client";
import { useBotAvatar } from "../state/botAvatar";
import type { ModelProfile } from "../api/generated";
import { useQuery } from "../state/store";
import type { Opener } from "./Workspace";
import { ServerActionButton } from "./pwa/ServerActionButton";
import { useServerBlockReason } from "./pwa/lifecycle";

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
    // 이미지를 못 받으면(삭제·네트워크) 기본형으로 보인다.
    if (src) return <img className="avatar" src={src} alt="" aria-hidden data-testid="bot-avatar-image" />;
    return (
        <span className="avatar" style={{ background: b.avatar_color, color: avatarInk(b.avatar_color) }} aria-hidden>
            {[...b.name][0] ?? "?"}
        </span>
    );
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
    return <div className="inline" role="group" aria-label="봇 아바타">
        <Avatar b={bot} />
        <label className="small">아바타 이미지
            <input type="file" accept="image/png,image/jpeg,image/gif,image/webp" disabled={busy || !!serverBlocked} title={serverBlocked ?? undefined} aria-label="아바타 이미지 선택"
                onChange={(e) => {
                    const file = e.target.files?.[0];
                    e.target.value = "";
                    if (!file) return;
                    void run(async () => {
                        if (file.size > 2 * 1024 * 1024) throw new ApiError(413, "too_large", "아바타 이미지는 2MiB 이하여야 합니다", false);
                        const data = new Uint8Array(await file.arrayBuffer());
                        let binary = "";
                        for (let i = 0; i < data.length; i += 8192) binary += String.fromCharCode(...data.subarray(i, i + 8192));
                        await api.put(`/bots/${bot.id}/avatar`, { data_base64: btoa(binary) });
                    });
                }} />
        </label>
        {bot.avatar_sha256 && <ServerActionButton type="button" className="ghost small" disabled={busy} onClick={() => void run(() => api.del(`/bots/${bot.id}/avatar`))}>기본형으로</ServerActionButton>}
        {err && <span className="err small" role="alert">{err}</span>}
    </div>;
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
        <form
            className="stack bot-editor"
            data-testid="bot-editor"
            onSubmit={(e) => {
                e.preventDefault();
                void save();
            }}
        >
            {err && <p className="err" role="alert">{err}</p>}
            {bot && <AvatarControl bot={live ?? bot} />}
            <input aria-label="봇 이름" placeholder="이름" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
            <input aria-label="봇 설명" placeholder="설명" value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} />
            <textarea aria-label="persona" placeholder="persona(말투·성격)" rows={2} value={f.persona} onChange={(e) => setF({ ...f, persona: e.target.value })} />
            <textarea aria-label="작업 지침" placeholder="작업 지침" rows={2} value={f.instructions} onChange={(e) => setF({ ...f, instructions: e.target.value })} />
            <select aria-label="봇 모델" value={f.profile_id} onChange={(e) => setF({ ...f, profile_id: e.target.value })}>
                <option value="">모델 미설정(실행 불가)</option>
                {(profiles.data ?? []).map((p) => <option key={p.id} value={p.id} disabled={p.enabled === false}>{p.name} · {p.model}{p.enabled === false ? " · 비활성" : ""}</option>)}
            </select>
            <select aria-label="봇 프로젝트" value={projectId} disabled={!!bot?.home_session_id} onChange={(e) => setF({ ...f, project_id: e.target.value })}>
                {(projects.data ?? []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
            <label className="check">
                <input type="checkbox" checked={f.featured} onChange={(e) => setF({ ...f, featured: e.target.checked })} /> 대표 봇
            </label>
            <div className="inline">
                <ServerActionButton type="submit" disabled={!f.name.trim() || !projectId}>{bot ? "저장" : "봇 만들기"}</ServerActionButton>
                <button type="button" className="ghost" onClick={onDone}>닫기</button>
            </div>
        </form>
    );
}

/// 봇 목록: 위임 역할과 별개로, 사용자가 직접 대화하는 상대.
export function BotsPanel({ open }: { open: Opener }) {
    const q = useQuery<{ bots: Bot[]; order_revision: number }>("bots", () => api.get("/bots"));
    const [hidden, setHidden] = useState<string[]>(loadHidden);
    const [showHidden, setShowHidden] = useState(false);
    const [showDeleted, setShowDeleted] = useState(false);
    const [editing, setEditing] = useState<Bot | "new" | null>(null);
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
        <section className="bots" data-testid="bots-panel">
            <h2>
                봇 <button className="ghost small" onClick={() => setEditing("new")}>+ 봇</button>
            </h2>
            {err && <p className="err" role="alert">{err}</p>}
            {editing && <Editor bot={editing === "new" ? null : editing}
                live={editing === "new" ? null : (q.data?.bots.find((x) => x.id === editing.id) ?? null)} onDone={() => { setEditing(null); q.reload(); }} />}
            <ul className="session-list">
                {visible.map((b, i) => (
                    <li key={b.id} data-testid="bot" data-status={b.status}>
                        <ServerActionButton className="ghost bot-open" disabled={b.status === "deleted"} onClick={() => void enter(b)}>
                            <Avatar b={b} />
                            <span>
                                {b.featured && <span aria-label="대표">★ </span>}
                                {b.name}
                                {b.unread && <span className="dot" aria-label="읽지 않음" data-testid="bot-unread" />}
                            </span>
                            {b.home_status === "running" && <span className="status running">실행 중</span>}
                            {b.home_status === "awaiting_approval" && <span className="status awaiting_approval">승인 대기</span>}
                            {b.home_status === "awaiting_input" && <span className="status awaiting_input">답변 대기</span>}
                            {b.status === "disabled" && <span className="status">비활성</span>}
                            {b.model_state !== "ok" && b.status !== "deleted" &&
                                <span className="muted small">{MODEL_STATE[b.model_state]}</span>}
                        </ServerActionButton>
                        <details className="bot-actions">
                            <summary aria-label={`${b.name} 관리`}>⋯</summary>
                            {b.status !== "deleted" && <button className="ghost small" onClick={() => setEditing(b)}>편집</button>}
                            {b.status !== "deleted" && <ServerActionButton className="ghost small" onClick={() => void enter(b, "right")}>오른쪽에 열기</ServerActionButton>}
                            {b.status !== "deleted" && <ServerActionButton className="ghost small" onClick={() => void enter(b, "down")}>아래에 열기</ServerActionButton>}
                            {i > 0 && !showDeleted && <ServerActionButton className="ghost small" onClick={() => moveUp(i)}>위로</ServerActionButton>}
                            <button className="ghost small" onClick={() => toggleHide(b.id)}>{hidden.includes(b.id) ? "이 기기에서 보이기" : "이 기기에서 숨기기"}</button>
                            {b.status === "active" && <ServerActionButton className="ghost small" onClick={() => void status(b, "disable")}>비활성화</ServerActionButton>}
                            {b.status === "disabled" && <ServerActionButton className="ghost small" onClick={() => void status(b, "enable")}>다시 켜기</ServerActionButton>}
                            {b.status !== "deleted" && b.home_session_id && (
                                <ServerActionButton className="ghost small" onClick={() => { if (confirm(`'${b.name}' 대화를 보관하고 새로 시작할까요?`)) void status(b, "reset"); }}>대화 초기화</ServerActionButton>
                            )}
                            {b.status !== "deleted" && (
                                <ServerActionButton className="ghost small danger" onClick={() => { if (confirm(`'${b.name}'을 삭제할까요? 대화는 보관되고 복원할 수 있습니다.`)) void status(b, "delete"); }}>삭제</ServerActionButton>
                            )}
                            {b.status === "deleted" && <ServerActionButton className="ghost small" onClick={() => void status(b, "restore")}>복원</ServerActionButton>}
                        </details>
                    </li>
                ))}
            </ul>
            <div className="inline small">
                {hidden.length > 0 && <label className="check"><input type="checkbox" checked={showHidden} onChange={(e) => setShowHidden(e.target.checked)} /> 숨긴 봇 보기</label>}
                <label className="check"><input type="checkbox" checked={showDeleted} onChange={(e) => setShowDeleted(e.target.checked)} /> 삭제된 봇</label>
            </div>
        </section>
    );
}
