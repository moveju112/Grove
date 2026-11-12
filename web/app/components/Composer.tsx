import { useEffect, useRef, useState } from "react";
import { ApiError, api, authGeneration, isLoggedIn, newKey } from "../api/client";
import type { Definition, ModelProfile } from "../api/generated";
import { deviceName, loadPrefs } from "../state/device";
import * as D from "../state/drafts";
import { type FollowKind, type SendOptions, capabilityProblem, resolveOptions, sendOptionsSignature } from "../state/sendOptions";
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

export type { FollowKind } from "../state/sendOptions";
const FOLLOW_LABEL: Record<FollowKind, string> = { queue: "대기열에 추가", steer: "지금 반영", interrupt: "중단하고 보내기" };

/// 입력창: 입력할 때마다 기기 내 사본을 저장하고, 서버 초안은 명시적으로 저장/불러온다.
export function Composer({ projectId, resourceKey, copyId, disabled, running, onSend, commands, boundProfileId }: Props) {
    const [follow, setFollow] = useState<FollowKind>("queue");
    const store = typeof localStorage !== "undefined" ? localStorage : null;
    const localKey = D.key(resourceKey, copyId);
    const [initialDraft] = useState(() => store ? D.load(store, localKey) : null);
    const [text, setText] = useState(initialDraft?.text ?? "");
    const [pending, setPending] = useState<D.PendingSend | null>(initialDraft?.pending ?? null);
    const [pendingInvalid, setPendingInvalid] = useState(initialDraft?.pendingInvalid ?? false);
    const attachments = useAttachments(localKey, projectId, initialDraft?.attachments);
    const sending = useRef(false);
    const checking = useRef(false);
    const base = useRef<number>(initialDraft?.baseRevision ?? 0);
    const [opts, setOpts] = useState<SendOptions>(() => initialDraft?.options ?? initialDraft?.pending?.intent ?? loadOpts());
    const selection = useRef({ options: opts, ids: attachments.ids });
    selection.current = { options: opts, ids: attachments.ids };
    const [owner] = useState(authGeneration);
    const alive = useRef(true);
    useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
    const otherCopies = () => store ? D.siblingCopies(store, resourceKey).filter((c) => c.key !== localKey) : [];
    const [copies, setCopies] = useState(otherCopies);
    const [copyError, setCopyError] = useState(false);
    const [busy, setBusy] = useState(false);
    const [msg, setMsg] = useState<string | null>(null);
    const [conflict, setConflict] = useState<D.ServerDraft | null>(null);
    const profiles = useQuery<ModelProfile[]>("profiles", () => api.get("/model-profiles"));
    const agents = useQuery<Definition[]>("definitions:agent", () => api.get("/definitions?kind=agent"));
    const server = useQuery<D.ServerDraft>(`draft:${resourceKey}`, () => api.get(`/drafts/${resourceKey}`));
    const prefs = loadPrefs();

    useEffect(() => {
        if (!store || !isLoggedIn() || authGeneration() !== owner) return;
        try {
            D.save(store, localKey, {
                text, baseRevision: base.current, updatedAt: Date.now(), pending: pending ?? undefined, pendingInvalid, options: opts,
                attachments: attachments.items.flatMap((i) => i.attachment ? [i.attachment] : []),
            });
            setCopyError(false);
        } catch { setCopyError(true); }
    }, [text, localKey, store, pending, pendingInvalid, attachments.items, base.current, opts]); // eslint-disable-line react-hooks/exhaustive-deps

    useEffect(() => {
        if (!isLoggedIn() || authGeneration() !== owner) return;
        try { localStorage.setItem(OPT_KEY, JSON.stringify(opts)); }
        catch { setCopyError(true); }
    }, [opts, owner]);

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
    const restoreCopy = (draft: D.LocalDraft) => {
        if (!store || busy || attachments.busy) return;
        try {
            // 현재 입력도 별도 사본으로 남기고 선택한 snapshot만 이 탭에 복제한다.
            if (text || attachments.items.length || pending || pendingInvalid) D.save(store, D.key(resourceKey, `${copyId}-${newKey()}`), {
                text, baseRevision: base.current, updatedAt: Date.now(), pending: pending ?? undefined, pendingInvalid, options: opts,
                attachments: attachments.items.flatMap((i) => i.attachment ? [i.attachment] : []),
            });
            D.save(store, localKey, draft);
            base.current = draft.baseRevision;
            setText(draft.text);
            setPending(draft.pending ?? null);
            setPendingInvalid(draft.pendingInvalid ?? false);
            if (draft.options || draft.pending) setOpts(draft.options ?? draft.pending!.intent);
            attachments.restore(draft.attachments ?? []);
            setCopies(otherCopies());
            setCopyError(false);
        } catch { setCopyError(true); }
    };

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
    const recovering = pending?.raw === text && pending.sig === sendOptionsSignature(opts, attachments.ids) ? pending : null;
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
        if ((!text.trim() && attachments.items.length === 0) || busy || sending.current || attachments.busy || !attachments.ready || !!disabled || pendingInvalid) return;
        if (recovering) { await sendText(recovering.body, text); return; }
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
    const sendText = async (body: string, raw: string, original?: D.PendingSend) => {
        if (busy || sending.current || attachments.busy || !!disabled || pendingInvalid) return;
        const confirmation = original ?? (pending?.raw === raw && pending.sig === sendOptionsSignature(opts, attachments.ids) ? pending : null);
        const ids = confirmation?.attachmentIds ?? attachments.ids;
        if (!confirmation && eff.mode === "model" && profileDisabled) {
            setMsg("선택한 모델 프로필이 비활성화돼 있습니다. 다른 프로필을 명시적으로 선택하세요.");
            return;
        }
        if (!confirmation && problem) { setMsg(problem); return; }
        const requestBody = confirmation?.body ?? body;
        checking.current = !!confirmation;
        sending.current = true;
        setBusy(true);
        setMsg(null);
        const options = confirmation?.options ?? eff;
        const kind = confirmation ? confirmation.follow : running ? follow : undefined;
        let intent = opts;
        if (!confirmation && options.mode === "model" && boundProfileId === undefined) {
            // 보내기를 누른 순간 보이는 기본 모델도 사용자가 선택한 대상이다.
            intent = { ...opts, profileId: options.profileId };
            update({ profileId: options.profileId });
        }
        const sig = confirmation?.sig ?? sendOptionsSignature(intent, ids);
        const key = confirmation?.key ?? newKey();
        selection.current = { options: intent, ids: attachments.ids };
        const snapshot: D.PendingSend = { body: requestBody, raw, sig, key, intent: confirmation?.intent ?? intent,
            options: { ...options }, follow: kind, attachmentIds: [...ids] };
        try {
            if (!store) throw new Error("draft storage unavailable");
            D.save(store, localKey, { text, baseRevision: base.current, updatedAt: Date.now(), options: intent,
                attachments: attachments.items.flatMap((i) => i.attachment ? [i.attachment] : []), pending: snapshot });
        } catch {
            sending.current = false;
            setBusy(false);
            setCopyError(true);
            setMsg("전송 사본을 보관하지 못해 보내지 않았습니다. 기기 저장 공간을 확인하세요.");
            return;
        }
        setPending(snapshot);
        try {
            await onSend(requestBody, options, key, kind, ids);
            if (authGeneration() !== owner) return;
            const sameSelection = sendOptionsSignature(selection.current.options, selection.current.ids) === sig;
            D.settleSend(store, resourceKey, key, true);
            if (!alive.current) return;
            attachments.clearSent(ids);
            setPending(null);
            setCopies(otherCopies());
            // 보내는 동안 새로 입력한 글은 지우지 않는다(보낸 글 그대로일 때만 비움).
            setText((cur) => (sameSelection && cur === raw ? "" : cur));
            // 보낸 뒤 서버 초안이 내 것이면 비운다(다른 기기 수정이 있으면 남김)
            if (server.data && server.data.revision === base.current && server.data.text) {
                await api.put(`/drafts/${resourceKey}`, { expected_revision: base.current, text: "", device_name: deviceName() }).catch(() => undefined);
            }
        } catch (e) {
            if (authGeneration() !== owner) return;
            // 응답을 못 받았거나 서버 오류면 실제로 처리됐는지 모른다: 입력을 남기고 자동 재전송하지 않는다.
            const unknown = !(e instanceof ApiError) || e.status >= 500 || e.status === 408
                || (e.details as { result_unknown?: boolean } | undefined)?.result_unknown === true;
            if (unknown) {
                if (alive.current) setPending(snapshot);
            } else {
                D.settleSend(store, resourceKey, key, false);
                if (!alive.current) return;
                setPending(null);
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
            {copyError && <p className="err" role="alert">기기에 입력 사본을 보관하지 못했습니다. 화면을 떠나기 전에 내용을 복사하세요.</p>}
            {copies.length > 0 && <details className="draft-note" data-testid="draft-copies">
                <summary>다른 입력 사본 {copies.length}개</summary>
                <p className="muted small">선택한 사본을 이 탭에 복제합니다. 현재 입력은 별도 사본으로 남기며 자동 전송하지 않습니다.</p>
                {copies.map((copy) => <div key={copy.key} data-testid="draft-copy">
                    <pre>{copy.draft.text}</pre>
                    {copy.draft.options && <p className="muted small">
                        {copy.draft.options.mode === "save" ? "메시지만 저장" : `모델: ${profiles.data?.find((p) => p.id === copy.draft.options!.profileId)?.name ?? copy.draft.options.profileId ?? "기본"} · 강도: ${copy.draft.options.effort ?? "auto"} · 도구 ${copy.draft.options.tools ? "사용" : "끔"}`}
                    </p>}
                    {!!copy.draft.attachments?.length && <p className="small">첨부: {copy.draft.attachments.map((a) => a.name).join(", ")}</p>}
                    {copy.draft.pending && <p className="warn small">전송 결과 확인 필요 · 원래 요청 키 유지</p>}
                    <button className="ghost small" disabled={busy || attachments.busy} onClick={() => restoreCopy(copy.draft)}>이 사본 이어받기</button>
                </div>)}
            </details>}
            {pendingInvalid && <div className="draft-note warn" role="alert">
                전송 사본이 손상되어 원래 요청을 확인할 수 없습니다. 서버 대화·실행 기록을 먼저 확인하세요.
                <button className="ghost small" onClick={() => setPendingInvalid(false)}>기록 확인 후 새 전송 허용</button>
            </div>}
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
            {pending && !busy && (
                <div className="draft-note warn" role="alert" data-testid="send-unsure">
                    보냈는지 확인할 수 없습니다(연결 문제). 입력은 그대로 보관했고 자동으로 다시 보내지 않습니다.
                    글·모델/도구 옵션·첨부를 바꾸지 않고 확인하면 원래 전송 위치·옵션·같은 요청 키를 사용합니다.
                    {!recovering && <>
                        <details><summary>원래 요청 보기</summary><pre>{pending.raw}</pre>
                            <p className="small">모델: {pending.options.profileId ?? "없음"} · 첨부 {pending.attachmentIds.length}개 · {pending.follow ? FOLLOW_LABEL[pending.follow] : pending.options.mode === "save" ? "메시지만 저장" : "모델로 보내기"}</p>
                        </details>
                        <button className="ghost small" disabled={busy || attachments.busy || !!disabled}
                            onClick={() => void sendText(pending.body, pending.raw, pending)}>원래 요청 결과 확인</button>
                        <span className="small">현재 입력과 새 첨부는 보존합니다. 현재 내용을 보내면 별도의 새 요청입니다.</span>
                    </>}
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
                    <select aria-label="실행 중 보내기 방식" value={follow} disabled={!!recovering} onChange={(e) => setFollow(e.target.value as FollowKind)}>
                        <option value="queue">대기열에 추가(끝난 뒤 새 요청)</option>
                        <option value="steer">지금 반영(다음 모델 호출에 추가)</option>
                        <option value="interrupt">중단하고 보내기</option>
                    </select>
                )}
                <button
                    onClick={send}
                    disabled={busy || pendingInvalid || attachments.busy || !attachments.ready || (!text.trim() && attachments.items.length === 0) || !!disabled || (!recovering && (!!problem || (eff.mode === "model" && (!eff.profileId || profileDisabled)) || (!!running && eff.mode === "save")))}
                    title={running && eff.mode === "save" ? "실행 중에는 메시지만 저장할 수 없습니다(도구 호출과 결과 사이에 끼면 안 됨)" : undefined}
                >
                    {busy ? checking.current ? "확인 중…" : "보내는 중…" : recovering ? "같은 요청 확인" : running && eff.mode === "model" ? FOLLOW_LABEL[follow] : "보내기"}
                </button>
            </div>
            {msg && <p className="muted small" role="status">{msg}</p>}
            {eff.mode === "model" && selectedProfile && <CapabilitySummary capabilities={selectedProfile.capabilities} />}
            {problem && <p className="warn small" role="status">{problem}</p>}
            {eff.mode === "model" && profileDisabled && <p className="warn small" role="status" data-testid="profile-disabled">선택한 모델 프로필이 비활성화돼 있습니다. 다른 모델로 자동 전환하지 않습니다.</p>}
        </div>
    );
}
