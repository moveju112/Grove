import { useEffect, useRef, useState } from "react";
import { ApiError, api, newKey } from "../api/client";
import type { Definition, ModelProfile } from "../api/generated";
import { deviceName, loadPrefs } from "../state/device";
import * as D from "../state/drafts";
import { type SendOptions, capabilityProblem, resolveOptions } from "../state/sendOptions";
import { type SlashCommand, parseSlash, suggest } from "../state/slash";
import { useQuery } from "../state/store";

import { AttachmentPicker, useAttachments } from "./Attachments";
import { CapabilitySummary } from "./ProfileCapabilities";

export type { SendOptions };

const OPT_KEY = "grove.composer.options";

function loadOpts(): SendOptions {
    try {
        return { mode: "model", profileId: null, agentId: null, tools: false, ...(JSON.parse(localStorage.getItem(OPT_KEY) ?? "{}") as Partial<SendOptions>) };
    } catch {
        return { mode: "model", profileId: null, agentId: null, tools: false };
    }
}

type Props = {
    projectId: string;
    resourceKey: string; // session:<id> | project:<id>
    copyId: string; // 탭/분할 사본별 로컬 키
    disabled?: string | null;
    /// 이 대화에서 턴이 실행 중이면 보내기 대신 대기열·steer·중단 후 보내기를 고른다(UI-021).
    running?: boolean;
    /// key: 이 전송의 Idempotency-Key. 결과를 모르는 실패 뒤 같은 내용을 다시 보내면 같은 key를 넘겨 서버가 중복 실행하지 않는다.
    /// follow: 실행 중일 때 고른 방식(없으면 일반 전송).
    onSend: (text: string, o: SendOptions, key: string, follow?: FollowKind, attachments?: string[]) => Promise<void>;
    /// 이 화면이 제공하는 slash command(UI-024). 입력창 공통 명령(/tools·/save·/model)은 Composer가 가진다.
    commands?: RunCommand[];
    /// 봇 대화는 서버가 결합한 실제 프로필을 쓰며 로컬 선택을 변경하지 않는다.
    boundProfileId?: string | null;
};

/// run의 반환 문자열은 상태 줄에 보인다. 실패는 throw.
export type RunCommand = SlashCommand & { run: (arg: string, o: SendOptions) => Promise<string | void> | string | void };

export type FollowKind = "queue" | "steer" | "interrupt";
const FOLLOW_LABEL: Record<FollowKind, string> = { queue: "대기열에 추가", steer: "지금 반영", interrupt: "중단하고 보내기" };

/// 입력창: 입력할 때마다 기기 내 사본을 저장하고, 서버 초안은 명시적으로 저장/불러온다.
export function Composer({ projectId, resourceKey, copyId, disabled, running, onSend, commands, boundProfileId }: Props) {
    const [follow, setFollow] = useState<FollowKind>("queue");
    const store = typeof localStorage !== "undefined" ? localStorage : null;
    const localKey = D.key(resourceKey, copyId);
    const [text, setText] = useState(() => (store ? D.load(store, localKey)?.text ?? "" : ""));
    const attachments = useAttachments(localKey, projectId);
    const sending = useRef(false);
    const base = useRef<number>(store ? D.load(store, localKey)?.baseRevision ?? 0 : 0);
    const [opts, setOpts] = useState<SendOptions>(loadOpts);
    const [busy, setBusy] = useState(false);
    const [msg, setMsg] = useState<string | null>(null);
    const [conflict, setConflict] = useState<D.ServerDraft | null>(null);
    const profiles = useQuery<ModelProfile[]>("profiles", () => api.get("/model-profiles"));
    const agents = useQuery<Definition[]>("definitions:agent", () => api.get("/definitions?kind=agent"));
    const server = useQuery<D.ServerDraft>(`draft:${resourceKey}`, () => api.get(`/drafts/${resourceKey}`));
    const prefs = loadPrefs();

    useEffect(() => {
        if (store) D.save(store, localKey, { text, baseRevision: base.current, updatedAt: Date.now() });
    }, [text, localKey, store]);

    useEffect(() => localStorage.setItem(OPT_KEY, JSON.stringify(opts)), [opts]);

    // 화면 선택과 보내는 값이 같도록 매 렌더 계산한다(기본 프로필을 상태로 복사하지 않음).
    const resolved = resolveOptions(
        opts,
        profiles.data && [...profiles.data].sort((a, b) => Number(a.enabled === false) - Number(b.enabled === false)).map((p) => p.id),
        agents.data?.map((a) => a.id),
    );
    const eff = boundProfileId === undefined ? resolved : { ...resolved, profileId: boundProfileId, agentId: null };
    const selectedProfile = profiles.data?.find((p) => p.id === eff.profileId);
    const profileDisabled = selectedProfile?.enabled === false;
    const problem = capabilityProblem(selectedProfile?.capabilities, eff, attachments.items.some((item) =>
        (item.attachment?.mime ?? item.file?.type)?.startsWith("image/")));
    const update = (patch: Partial<SendOptions>) => setOpts((o) => ({ ...o, ...patch }));

    const state = server.data ? D.compare(text ? { text, baseRevision: base.current, updatedAt: 0 } : null, server.data) : null;

    const saveServer = async () => {
        setMsg(null);
        try {
            const r = await api.put<D.ServerDraft>(`/drafts/${resourceKey}`, { expected_revision: base.current, text, device_name: deviceName() });
            base.current = r.revision;
            setConflict(null);
            setMsg("서버에 초안을 저장했습니다");
            server.reload();
        } catch (e) {
            if (e instanceof ApiError && e.code === "revision_conflict") {
                setConflict((e.details as { current: D.ServerDraft }).current);
            } else setMsg(e instanceof ApiError ? e.message : "초안 저장 실패");
        }
    };

    const loadServer = (d: D.ServerDraft, mode: "replace" | "append") => {
        setText((t) => (mode === "replace" ? d.text : t ? `${t}\n\n${d.text}` : d.text));
        base.current = d.revision;
        setConflict(null);
    };

    // 모바일(터치) 키보드에는 Shift가 불편하므로 Enter는 항상 줄바꿈이고, 보내기 버튼으로 보낸다.
    const enterSends = prefs.enterToSend && !(typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches);
    // 결과를 알 수 없는 전송(네트워크 끊김·서버 오류)의 key. 같은 내용·옵션으로 다시 보낼 때만 재사용한다(UI-028).
    const unsure = useRef<{ sig: string; key: string } | null>(null);
    const [unsureMsg, setUnsureMsg] = useState(false);
    // slash command: 공통 명령 + 화면 명령. 등록된 이름만 명령이고 나머지 "/"는 보내지 않는다(//로 시작하면 글).
    const builtins: RunCommand[] = [
        {
            name: "tools",
            args: "on|off",
            description: "모델 도구 사용 켜기·끄기",
            run: (a) => {
                const on = a ? a === "on" : !eff.tools;
                update({ tools: on });
                return `도구 사용을 ${on ? "켰습니다" : "껐습니다"}`;
            },
        },
        {
            name: "effort",
            args: "auto|low|medium|high",
            description: "추론 강도 바꾸기",
            run: (a) => {
                const v = a || "auto";
                if (!["auto", "low", "medium", "high"].includes(v)) throw new Error("/effort auto|low|medium|high");
                update({ effort: v as SendOptions["effort"] });
                return `추론 강도를 ${v}로 바꿨습니다`;
            },
        },
        {
            name: "save",
            description: "보내기 방식 바꾸기(모델로 ↔ 메시지만 저장)",
            run: () => {
                const m = eff.mode === "save" ? "model" : "save";
                update({ mode: m });
                return m === "save" ? "메시지만 저장으로 바꿨습니다" : "모델로 보내기로 바꿨습니다";
            },
        },
        {
            name: "model",
            args: "이름",
            description: "모델 프로필 바꾸기(이름·모델 일부)",
            run: (a) => {
                const q = a.toLowerCase();
                const p = (profiles.data ?? []).find((x) => x.enabled !== false && q && (x.name.toLowerCase().includes(q) || x.model.toLowerCase().includes(q)));
                if (!p) throw new Error(a ? `'${a}'에 맞는 모델 프로필이 없습니다` : "프로필 이름을 함께 쓰세요(/model 이름)");
                update({ profileId: p.id, mode: "model" });
                return `모델 프로필을 ${p.name} · ${p.model}로 바꿨습니다`;
            },
        },
    ];
    const allCmds = [...builtins, ...(commands ?? [])];
    const [sel, setSel] = useState(0);
    const [hideSugg, setHideSugg] = useState(false);
    const sugg = hideSugg ? [] : suggest(text, allCmds);
    const complete = (c: SlashCommand) => {
        setText(`/${c.name}${c.args ? " " : ""}`);
        setSel(0);
    };

    const send = async () => {
        if ((!text.trim() && attachments.items.length === 0) || busy || sending.current || attachments.busy || !attachments.ready || !!disabled) return;
        const parsed = parseSlash(text, allCmds.map((c) => c.name));
        if (parsed.kind === "unknown") {
            setMsg(`알 수 없는 명령 /${parsed.name}입니다. '/'를 입력하면 명령 목록이 보이고, '/'로 시작하는 글은 '//'로 시작해 보내세요.`);
            return;
        }
        if (parsed.kind === "command") {
            const c = allCmds.find((x) => x.name === parsed.name)!;
            setBusy(true);
            setMsg(null);
            try {
                const r = await c.run(parsed.arg, eff);
                const sent = text;
                setText((cur) => (cur === sent ? "" : cur));
                setMsg(r ? r : `/${c.name} 실행했습니다`);
            } catch (e) {
                setMsg(e instanceof Error ? e.message : "명령을 실행하지 못했습니다");
            } finally {
                setBusy(false);
            }
            return;
        }
        await sendText(parsed.text, text);
    };

    /// body: 실제로 보낼 글("//" 이스케이프를 푼 값), raw: 입력창 원문(보낸 뒤 비울지 판단).
    const sendText = async (body: string, raw: string) => {
        if (eff.mode === "model" && profileDisabled) {
            setMsg("선택한 모델 프로필이 비활성화돼 있습니다. 다른 프로필을 명시적으로 선택하세요.");
            return;
        }
        if (problem) { setMsg(problem); return; }
        const text = body;
        sending.current = true;
        setBusy(true);
        setMsg(null);
        const kind = running ? follow : undefined;
        const ids = attachments.ids;
        const sig = JSON.stringify([text, eff, kind, ids]);
        const key = unsure.current?.sig === sig ? unsure.current.key : newKey();
        try {
            await onSend(text, eff, key, kind, ids);
            attachments.clear();
            unsure.current = null;
            setUnsureMsg(false);
            // 보내는 동안 새로 입력한 글은 지우지 않는다(보낸 글 그대로일 때만 비움).
            setText((cur) => (cur === raw ? "" : cur));
            // 보낸 뒤 서버 초안이 내 것이면 비운다(다른 기기 수정이 있으면 남김)
            if (server.data && server.data.revision === base.current && server.data.text) {
                await api.put(`/drafts/${resourceKey}`, { expected_revision: base.current, text: "", device_name: deviceName() }).catch(() => undefined);
            }
        } catch (e) {
            // 응답을 못 받았거나 서버 오류면 실제로 처리됐는지 모른다: 입력을 남기고 자동 재전송하지 않는다.
            const unknown = !(e instanceof ApiError) || e.status >= 500 || e.status === 408
                || (e.details as { result_unknown?: boolean } | undefined)?.result_unknown === true;
            if (unknown) {
                unsure.current = { sig, key };
                setUnsureMsg(true);
            } else {
                unsure.current = null;
                setUnsureMsg(false);
                setMsg(e.message);
            }
        } finally {
            sending.current = false;
            setBusy(false);
        }
    };

    // 한글 IME: 조합 중 Enter와, 조합을 끝내는 Enter(Safari는 isComposing=false·keyCode 229로 보낸다)는 보내지 않는다.
    const composing = useRef(false);
    const onKey = (e: React.KeyboardEvent) => {
        // 명령 목록이 열려 있으면 방향키로 고르고 Tab·Enter로 채운다(실행은 한 번 더 보내기).
        if (sugg.length > 0 && !e.nativeEvent.isComposing && !composing.current) {
            if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                e.preventDefault();
                setSel((i) => (i + (e.key === "ArrowDown" ? 1 : sugg.length - 1)) % sugg.length);
                return;
            }
            if (e.key === "Tab" || (e.key === "Enter" && !e.ctrlKey && !e.metaKey && !e.shiftKey && text !== `/${sugg[Math.min(sel, sugg.length - 1)]!.name}`)) {
                e.preventDefault();
                complete(sugg[Math.min(sel, sugg.length - 1)]!);
                return;
            }
            if (e.key === "Escape") {
                setHideSugg(true);
                return;
            }
        }
        if (e.key !== "Enter" || e.nativeEvent.isComposing || composing.current || e.keyCode === 229) return;
        if (e.ctrlKey || e.metaKey || (enterSends && !e.shiftKey)) {
            e.preventDefault();
            void send();
        }
    };

    return (
        <div className="composer">
            {state?.kind === "server_newer" && (
                <div className="draft-note">
                    다른 기기({state.server.device_name})의 서버 초안이 있습니다.
                    <button className="ghost small" onClick={() => loadServer(state.server, "replace")}>불러오기</button>
                </div>
            )}
            {conflict && (
                <div className="draft-note warn" role="alert">
                    서버 초안이 다른 기기({conflict.device_name})에서 바뀌었습니다. 내 초안은 이 기기에 보존되어 있습니다.
                    <details>
                        <summary>서버 초안 보기</summary>
                        <pre>{conflict.text}</pre>
                    </details>
                    <button className="ghost small" onClick={() => loadServer(conflict, "replace")}>서버 것으로 바꾸기</button>
                    <button className="ghost small" onClick={() => loadServer(conflict, "append")}>합치기</button>
                    <button className="ghost small" onClick={() => { base.current = conflict.revision; setConflict(null); void saveServer(); }}>
                        내 것으로 덮어쓰기
                    </button>
                </div>
            )}
            {unsureMsg && (
                <div className="draft-note warn" role="alert" data-testid="send-unsure">
                    보냈는지 확인할 수 없습니다(연결 문제). 입력은 그대로 보관했고 자동으로 다시 보내지 않습니다. 대화에 반영됐는지 확인한 뒤, 내용을 바꾸지 않고 다시 보내면 같은
                    요청으로 처리되어 두 번 실행되지 않습니다.
                </div>
            )}
            {sugg.length > 0 && (
                <ul className="slash-list" role="listbox" aria-label="명령" data-testid="slash-list">
                    {sugg.map((c, i) => (
                        <li
                            key={c.name}
                            role="option"
                            aria-selected={i === Math.min(sel, sugg.length - 1)}
                            onMouseDown={(e) => {
                                e.preventDefault();
                                complete(c);
                            }}
                        >
                            <code>/{c.name}{c.args ? ` ${c.args}` : ""}</code> <span className="muted small">{c.description}</span>
                        </li>
                    ))}
                </ul>
            )}
            <AttachmentPicker draft={attachments} disabled={busy || !!disabled} />
            <textarea
                onDragOver={(e) => { if (e.dataTransfer.types.includes("Files")) e.preventDefault(); }}
                onDrop={(e) => { if (e.dataTransfer.files.length) { e.preventDefault(); if (!busy && !disabled) void attachments.add(Array.from(e.dataTransfer.files)); } }}
                onPaste={(e) => { if (e.clipboardData.files.length && !busy && !disabled) { e.preventDefault(); void attachments.add(Array.from(e.clipboardData.files)); } }}
                value={text}
                onChange={(e) => {
                    setText(e.target.value);
                    setHideSugg(false);
                }}
                onKeyDown={onKey}
                onCompositionStart={() => (composing.current = true)}
                onCompositionEnd={() => (composing.current = false)}
                enterKeyHint={enterSends ? "send" : "enter"}
                placeholder={disabled ?? (enterSends ? "메시지 (Enter 보내기 · Shift+Enter 줄바꿈)" : "메시지 (Ctrl+Enter 보내기)")}
                aria-label="메시지 입력"
                rows={3}
                disabled={!!disabled}
            />
            <div className="composer-bar">
                <select aria-label="보내기 방식" value={eff.mode} onChange={(e) => update({ mode: e.target.value as SendOptions["mode"] })}>
                    <option value="model">모델로 보내기</option>
                    <option value="save">메시지만 저장</option>
                </select>
                {eff.mode === "model" && (
                    <>
                        <select aria-label="모델 프로필" value={eff.profileId ?? ""} disabled={boundProfileId !== undefined} onChange={(e) => update({ profileId: e.target.value || null })}>
                            {boundProfileId === null && <option value="">봇 모델 로딩 중 또는 미설정</option>}
                            {(profiles.data ?? []).length === 0 && <option value="">모델 프로필 없음(설정에서 추가)</option>}
                            {(profiles.data ?? []).map((p) => (
                                <option key={p.id} value={p.id} disabled={p.enabled === false}>
                                    {p.name} · {p.model}{p.enabled === false ? " · 비활성" : ""}
                                </option>
                            ))}
                        </select>
                        <select aria-label="에이전트" value={eff.agentId ?? ""} disabled={boundProfileId !== undefined} onChange={(e) => update({ agentId: e.target.value || null })}>
                            <option value="">에이전트 없음</option>
                            {(agents.data ?? []).map((a) => (
                                <option key={a.id} value={a.id}>
                                    {a.name}
                                </option>
                            ))}
                        </select>
                        <select aria-label="추론 강도" value={eff.effort ?? "auto"} onChange={(e) => update({ effort: e.target.value as SendOptions["effort"] })} title="모델이 생각하는 정도. auto는 모델 기본값">
                            <option value="auto">강도 auto</option>
                            <option value="low" disabled={selectedProfile?.capabilities?.effort === false}>강도 낮음</option>
                            <option value="medium" disabled={selectedProfile?.capabilities?.effort === false}>강도 중간</option>
                            <option value="high" disabled={selectedProfile?.capabilities?.effort === false}>강도 높음</option>
                        </select>
                        <label className="check">
                            <input type="checkbox" checked={eff.tools} disabled={!eff.tools && selectedProfile?.capabilities?.tools === false} onChange={(e) => update({ tools: e.target.checked })} /> 도구
                        </label>
                    </>
                )}
                <span className="spacer" />
                <button className="ghost small" onClick={saveServer} disabled={!text} title="다른 기기에서 이어서 쓰도록 서버에 저장">
                    초안 서버 저장
                </button>
                {running && eff.mode === "model" && (
                    <select aria-label="실행 중 보내기 방식" value={follow} onChange={(e) => setFollow(e.target.value as FollowKind)}>
                        <option value="queue">대기열에 추가(끝난 뒤 새 요청)</option>
                        <option value="steer">지금 반영(다음 모델 호출에 추가)</option>
                        <option value="interrupt">중단하고 보내기</option>
                    </select>
                )}
                <button
                    onClick={send}
                    disabled={busy || attachments.busy || !attachments.ready || (!text.trim() && attachments.items.length === 0) || !!disabled || !!problem || (eff.mode === "model" && (!eff.profileId || profileDisabled)) || (!!running && eff.mode === "save")}
                    title={running && eff.mode === "save" ? "실행 중에는 메시지만 저장할 수 없습니다(도구 호출과 결과 사이에 끼면 안 됨)" : undefined}
                >
                    {busy ? "보내는 중…" : running && eff.mode === "model" ? FOLLOW_LABEL[follow] : "보내기"}
                </button>
            </div>
            {msg && <p className="muted small" role="status">{msg}</p>}
            {eff.mode === "model" && selectedProfile && <CapabilitySummary capabilities={selectedProfile.capabilities} />}
            {problem && <p className="warn small" role="status">{problem}</p>}
            {eff.mode === "model" && profileDisabled && <p className="warn small" role="status" data-testid="profile-disabled">선택한 모델 프로필이 비활성화돼 있습니다. 다른 모델로 자동 전환하지 않습니다.</p>}
        </div>
    );
}
