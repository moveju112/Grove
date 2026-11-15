import { Grid } from "@astryxdesign/core/Grid";
import { Card } from "@astryxdesign/core/Card";
import { Notice } from "../design/Notice";
import { chatLayout } from "./chat-layout.stylex";
import { Select } from "../design/Select";
import { TextArea } from "../design/Fields";
import { composerStyles } from "./composer.stylex";
import { CommandPaletteList, CommandPaletteItem } from "@astryxdesign/core/CommandPalette";
import { Stack } from "@astryxdesign/core/Stack";
import { Text as GroveText } from "@astryxdesign/core/Text";
import { Button as GroveButton } from "../design/Button";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { ActionMenu, DetailDialog } from "./ui/Controls";
import { Icon } from "./icons";
import { ApiError, api, authGeneration, isLoggedIn, newKey } from "../api/client";
import type { Definition, ModelProfile } from "../api/generated";
import { deviceName, loadPrefs } from "../state/device";
import * as D from "../state/drafts";
import { EFFORTS, type FollowKind, type SendOptions, capabilityProblem, initialProfile, resolveOptions, sendOptionsSignature, serviceTierForProfile } from "../state/sendOptions";
import { type SlashCommand, parseSlash, suggest } from "../state/slash";
import { useQuery } from "../state/store";

import { AttachmentPicker, AttachmentSelection, useAttachments } from "./Attachments";
import { BooleanSelect } from "./BooleanSelect";
import { AgentConnect } from "./AgentConnect";
import { SessionSkills } from "./skills/SessionSkills";
import { ModelSelect, useModelCatalog } from "./ModelSelect";
import { localDraftStorage, requireServerAction, useServerBlockReason } from "./pwa/lifecycle";

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
export function Composer({ projectId, resourceKey, copyId, disabled: parentDisabled, running, onSend, commands, boundProfileId }: Props) {
    const serverBlocked = useServerBlockReason();
    const disabled = parentDisabled ?? serverBlocked;
    const [follow, setFollow] = useState<FollowKind>("queue");
    const store = localDraftStorage();
    const localKey = D.key(resourceKey, copyId);
    const [initialDraft] = useState(() => store ? D.load(store, localKey) : null);
    const [text, setText] = useState(initialDraft?.text ?? "");
    const [pending, setPending] = useState<D.PendingSend | null>(initialDraft?.pending ?? null);
    const [pendingInvalid, setPendingInvalid] = useState(initialDraft?.pendingInvalid ?? false);
    const attachments = useAttachments(localKey, projectId, initialDraft?.attachments);
    const sending = useRef(false);
    const checking = useRef(false);
    const base = useRef<number>(initialDraft?.baseRevision ?? 0);
    const [deviceOptions, setDeviceOptions] = useState(loadOpts);
    const [selectionState, setSelectionState] = useState<{ phase: "loading" | "ready"; options: SendOptions }>(() => {
        const restored = initialDraft?.options ?? initialDraft?.pending?.intent;
        return { phase: boundProfileId !== undefined || restored?.profileId ? "ready" : "loading",
            options: restored ?? { ...deviceOptions, profileId: null, model: null } };
    });
    const opts = selectionState.options;
    const setOpts = (value: SendOptions | ((options: SendOptions) => SendOptions)) => setSelectionState((current) => {
        const options = typeof value === "function" ? value(current.options) : value;
        return { phase: options.profileId ? "ready" : current.phase, options };
    });
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
    const [expandedModel, setExpandedModel] = useState(false);
    const [conflict, setConflict] = useState<D.ServerDraft | null>(null);
    const profiles = useQuery<ModelProfile[]>("profiles", () => api.get("/model-profiles"));
    const defaults = useQuery<{ items: { key: string; effective: unknown }[] }>(boundProfileId === undefined ? `settings:${projectId}` : null,
        () => api.get(`/settings/effective?project_id=${encodeURIComponent(projectId)}`));
    const agents = useQuery<Definition[]>("definitions:agent", () => api.get("/definitions?kind=agent"));
    const server = useQuery<D.ServerDraft>(`draft:${resourceKey}`, () => api.get(`/drafts/${resourceKey}`));
    const prefs = loadPrefs();
    const ready = boundProfileId !== undefined || selectionState.phase === "ready";
    useEffect(() => {
        if (ready || !profiles.data || !defaults.data) return;
        const configured = defaults.data.items.find((item) => item.key === "model.default_profile")?.effective;
        const ids = [...profiles.data].sort((a, b) => Number(a.enabled === false) - Number(b.enabled === false)).map((profile) => profile.id);
        setSelectionState((current) => current.phase === "ready" ? current : {
            phase: "ready", options: { ...current.options, profileId: initialProfile(configured, deviceOptions.profileId, ids),
                model: initialProfile(configured, deviceOptions.profileId, ids) === deviceOptions.profileId ? deviceOptions.model : null },
        });
    }, [ready, profiles.data, defaults.data, deviceOptions.profileId]);

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
        try { localStorage.setItem(OPT_KEY, JSON.stringify(deviceOptions)); }
        catch { setCopyError(true); }
    }, [deviceOptions, owner]);

    // 화면 선택과 보내는 값이 같도록 매 렌더 계산한다(기본 프로필을 상태로 복사하지 않음).
    const resolved = resolveOptions(
        opts,
        profiles.data && [...profiles.data].sort((a, b) => Number(a.enabled === false) - Number(b.enabled === false)).map((p) => p.id),
        agents.data?.map((a) => a.id),
    );
    const bound = boundProfileId === undefined ? resolved : { ...resolved, profileId: boundProfileId, model: null, agentId: null };
    const selectedProfile = profiles.data?.find((p) => p.id === bound.profileId);
    const eff = { ...bound, serviceTier: serviceTierForProfile(bound.serviceTier, selectedProfile?.capabilities) };
    const catalog = useModelCatalog(selectedProfile);
    const selectedModel = catalog.data?.models.find((m) => m.id === (eff.model ?? selectedProfile?.model))
        ?? (selectedProfile?.model === "default" && !eff.model ? catalog.data?.models.find((m) => m.is_default) : undefined);
    const efforts = selectedProfile?.protocol === "codex_cli" ? selectedModel?.reasoning_efforts ?? [] : ["low", "medium", "high"];
    const tiers = selectedProfile?.capabilities.fast ? selectedModel?.service_tiers ?? [] : [];
    const fastTier = tiers.find((tier) => tier.id === "priority");
    const fastEnabled = !!eff.serviceTier && eff.serviceTier !== "default";
    const profileDisabled = selectedProfile?.enabled === false;
    const profileMissing = !!eff.profileId && profiles.data !== undefined && !selectedProfile;
    const problem = capabilityProblem(selectedProfile?.capabilities, eff, attachments.items.some((item) =>
        (item.attachment?.mime ?? item.file?.type)?.startsWith("image/")), selectedModel);
    const update = (patch: Partial<SendOptions>) => {
        setOpts((o) => ({ ...o, ...patch }));
        // 범위별 자동 기본값·사본 복원은 기기 기본값으로 승격하지 않는다. 직접 바꾼 필드만 공유한다.
        setDeviceOptions((o) => ({ ...o, ...patch }));
    };
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
            requireServerAction();
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
            args: "auto|low|medium|high|xhigh|max",
            description: "추론 옵션 바꾸기",
            run: (a) => {
                const v = a || "auto";
                if (!EFFORTS.includes(v as typeof EFFORTS[number]) || (v !== "auto" && !efforts.includes(v))) throw new Error("선택한 모델이 지원하는 추론 옵션을 선택하세요");
                update({ effort: v as SendOptions["effort"] });
                return `추론을 ${v}로 바꿨습니다`;
            },
        },
        {
            name: "save",
            args: "on|off",
            description: "보내기 방식 바꾸기(모델로 ↔ 메시지만 저장)",
            run: (a) => {
                if (a && a !== "on" && a !== "off") throw new Error("/save on|off");
                const m = a ? a === "on" ? "save" : "model" : eff.mode === "save" ? "model" : "save";
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
                update({ profileId: p.id, model: null, mode: "model" });
                return `모델 프로필을 ${p.name} · ${p.model}로 바꿨습니다`;
            },
        },
    ];
    const allCmds = [...builtins, ...(commands ?? [])];
    const [sel, setSel] = useState(0);
    const [hideSugg, setHideSugg] = useState(false);
    const sugg = hideSugg ? [] : suggest(text, allCmds);
    const commandListId = useId();
    const commandList = useRef<HTMLDivElement>(null);
    const selectedCommand = sugg.length > 0 ? Math.min(sel, sugg.length - 1) : -1;
    const activeCommandId = selectedCommand >= 0 ? `${commandListId}-${sugg[selectedCommand]!.name}` : undefined;
    useLayoutEffect(() => {
        commandList.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView({ block: "nearest", inline: "nearest" });
    }, [activeCommandId]);
    const complete = (c: SlashCommand) => {
        setText(`/${c.name}${c.args ? " " : ""}`);
        setSel(0);
    };

    const send = async () => {
        if ((!text.trim() && attachments.items.length === 0) || busy || sending.current || attachments.busy || !attachments.ready || !!disabled || pendingInvalid) return;
        try { requireServerAction(); } catch (e) { setMsg((e as Error).message); return; }
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
        try { requireServerAction(); } catch (e) { setMsg((e as Error).message); return; }
        const confirmation = original ?? (pending?.raw === raw && pending.sig === sendOptionsSignature(opts, attachments.ids) ? pending : null);
        const ids = confirmation?.attachmentIds ?? attachments.ids;
        if (!confirmation && eff.mode === "model" && (!ready || profileDisabled || profileMissing)) {
            setMsg(!ready ? "기본 모델 설정을 확인한 뒤 보내세요." : "선택한 모델 프로필을 사용할 수 없습니다. 다른 프로필을 명시적으로 선택하세요.");
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
            setOpts(intent);
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
        <Card width="100%" maxWidth="48em" padding={2} elevation="low" xstyle={chatLayout.composer} data-testid="composer">
        <Grid gap={1}>
            {copyError && <GroveText as="p" display="block" type="inherit" color="error" role="alert">기기에 입력 사본을 보관하지 못했습니다. 화면을 떠나기 전에 내용을 복사하세요.</GroveText>}
            {copies.length > 0 && <DetailDialog surface="muted" data-testid="draft-copies" label="다른 입력 사본" title={`다른 입력 사본 ${copies.length}개`}>
                <GroveText as="p" display="block" type="supporting" color="secondary">선택한 사본을 이 탭에 복제합니다. 현재 입력은 별도 사본으로 남기며 자동 전송하지 않습니다.</GroveText>
                {copies.map((copy) => <Stack gap={0} key={copy.key} data-testid="draft-copy">
                    <pre>{copy.draft.text}</pre>
                    {copy.draft.options && <GroveText as="p" display="block" type="supporting" color="secondary">
                        {copy.draft.options.mode === "save" ? "메시지만 저장" : `모델: ${profiles.data?.find((p) => p.id === copy.draft.options!.profileId)?.name ?? copy.draft.options.profileId ?? "기본"} · 추론: ${copy.draft.options.effort ?? "auto"} · 도구 ${copy.draft.options.tools ? "사용" : "끔"}`}
                    </GroveText>}
                    {!!copy.draft.attachments?.length && <GroveText as="p" display="block" type="supporting" color="inherit">첨부: {copy.draft.attachments.map((a) => a.name).join(", ")}</GroveText>}
                    {copy.draft.pending && <GroveText as="p" display="block" type="supporting" color="warning">전송 결과 확인 필요 · 원래 요청 키 유지</GroveText>}
                    <GroveButton variant="secondary" density="compact" data-dialog-close disabled={busy || attachments.busy} onClick={() => restoreCopy(copy.draft)}>이 사본 이어받기</GroveButton>
                </Stack>)}
            </DetailDialog>}
            {pendingInvalid && <Notice tone="yellow" role="alert">
                전송 사본이 손상되어 원래 요청을 확인할 수 없습니다. 서버 대화·실행 기록을 먼저 확인하세요.
                <GroveButton variant="secondary" density="compact" onClick={() => setPendingInvalid(false)}>기록 확인 후 새 전송 허용</GroveButton>
            </Notice>}
            {state?.kind === "server_newer" && (
                <Notice>
                    다른 기기({state.server.device_name}) 또는 입력 사본에서 저장한 서버 초안이 있습니다.
                    <GroveButton variant="secondary" density="compact" onClick={() => loadServer(state.server, "replace")}>불러오기</GroveButton>
                </Notice>
            )}
            {conflict && (
                <Notice tone="yellow" role="alert">
                    서버 초안이 다른 기기({conflict.device_name}) 또는 입력 사본에서 바뀌었습니다. 내 초안은 이 탭에 보존되어 있습니다.
                    <DetailDialog label="서버 초안" title="서버 초안 보기">
                        <pre>{conflict.text}</pre>
                    </DetailDialog>
                    <GroveButton variant="secondary" density="compact" onClick={() => loadServer(conflict, "replace")}>서버 것으로 바꾸기</GroveButton>
                    <GroveButton variant="secondary" density="compact" onClick={() => loadServer(conflict, "append")}>합치기</GroveButton>
                    <GroveButton variant="secondary" density="compact" disabled={!!disabled} onClick={() => { base.current = conflict.revision; setConflict(null); void saveServer(); }}>
                        내 것으로 덮어쓰기
                    </GroveButton>
                </Notice>
            )}
            {pending && !busy && (
                <Notice tone="yellow" role="alert" data-testid="send-unsure">
                    보냈는지 확인할 수 없습니다(연결 문제). 입력은 그대로 보관했고 자동으로 다시 보내지 않습니다.
                    글·모델/도구 옵션·첨부를 바꾸지 않고 확인하면 원래 전송 위치·옵션·같은 요청 키를 사용합니다.
                    {!recovering && <>
                        <DetailDialog label="원래 전송 요청" title="원래 요청 보기"><pre>{pending.raw}</pre>
                            <GroveText as="p" display="block" type="supporting" color="inherit">모델: {pending.options.profileId ?? "없음"} · 첨부 {pending.attachmentIds.length}개 · {pending.follow ? FOLLOW_LABEL[pending.follow] : pending.options.mode === "save" ? "메시지만 저장" : "모델로 보내기"}</GroveText>
                        </DetailDialog>
                        <GroveButton variant="secondary" density="compact" disabled={busy || attachments.busy || !!disabled}
                            onClick={() => void sendText(pending.body, pending.raw, pending)}>원래 요청 결과 확인</GroveButton>
                        <GroveText type="supporting" color="inherit">현재 입력과 새 첨부는 보존합니다. 현재 내용을 보내면 별도의 새 요청입니다.</GroveText>
                    </>}
                </Notice>
            )}
            {sugg.length > 0 && (
                <CommandPaletteList ref={commandList} id={commandListId} xstyle={chatLayout.commands} label="명령" data-testid="slash-list">
                    {sugg.map((c, i) => (
                        <CommandPaletteItem
                            key={c.name}
                            id={`${commandListId}-${c.name}`}
                            value={c.name}
                            isSelected={i === selectedCommand}
                            isHighlighted={i === selectedCommand}
                            onMouseDown={(e) => {
                                e.preventDefault();
                            }}
                            onSelect={() => complete(c)}
                        >
                            <code>/{c.name}{c.args ? ` ${c.args}` : ""}</code> <GroveText type="supporting" color="secondary">{c.description}</GroveText>
                        </CommandPaletteItem>
                    ))}
                </CommandPaletteList>
            )}
            {eff.mode === "model" && boundProfileId === undefined && profiles.data?.length === 0 && (
                <AgentConnect disabled={busy || !!disabled} onConnected={(profile) => {
                    profiles.reload();
                    update({ profileId: profile.id, mode: "model", tools: false });
                }} />
            )}
            <AttachmentSelection draft={attachments} disabled={busy || !!disabled} />
            <TextArea label="메시지 입력" isLabelHidden controlXstyle={composerStyles.inputControl}
                onDragOver={(e) => { if (e.dataTransfer.types.includes("Files")) e.preventDefault(); }}
                onDrop={(e) => { if (e.dataTransfer.files.length) { e.preventDefault(); if (!busy && !disabled) void attachments.add(Array.from(e.dataTransfer.files)); } }}
                onPaste={(e) => { if (e.clipboardData.files.length && !busy && !disabled) { e.preventDefault(); void attachments.add(Array.from(e.clipboardData.files)); } }}
                value={text}
                onChange={(value) => {
                    setText(value);
                    setHideSugg(false);
                    setSel(0);
                }}
                onBlur={() => setHideSugg(true)}
                onFocus={() => setHideSugg(false)}
                aria-autocomplete={sugg.length > 0 ? "list" : undefined}
                aria-controls={sugg.length > 0 ? commandListId : undefined}
                aria-activedescendant={activeCommandId}
                onKeyDown={onKey}
                onCompositionStart={() => (composing.current = true)}
                onCompositionEnd={() => (composing.current = false)}
                enterKeyHint={enterSends ? "send" : "enter"}
                // 연결 차단 사유는 상단 연결 토스트가 알린다. 여기에는 이 대화 고유의 사유만 보인다.
                placeholder={parentDisabled ?? "메시지를 입력하세요"}
                aria-label="메시지 입력"
                rows={1}
                ref={(node) => {
                    if (!node) return;
                    node.style.height = "auto";
                    node.style.height = `${Math.min(node.scrollHeight, 160)}px`;
                }}
                isDisabled={!!parentDisabled}
            />
            <Grid gap={1} xstyle={[chatLayout.bar, composerStyles.toolbar]} data-testid="composer-bar" data-model-expanded={expandedModel}>
                <Stack gap={0} data-composer-fixed xstyle={[composerStyles.attachmentSlot, expandedModel && composerStyles.secondRow]}>
                    <AttachmentPicker draft={attachments} disabled={busy || !!disabled} onIssue={setMsg} />
                </Stack>
                <Stack gap={0} xstyle={[composerStyles.modelSlot, expandedModel && composerStyles.expandedModel]}>
                {((profiles.data?.length ?? 0) > 0 || eff.mode === "save" || eff.profileId) && <ModelSelect
                    profiles={profiles.data ?? []} profileId={eff.profileId} model={eff.model} ready={ready}
                    save={eff.mode === "save"} bound={boundProfileId !== undefined}
                    onExpandedChange={setExpandedModel}
                    onChange={(profileId, model) => { update({ profileId, model, mode: "model" }); setMsg(null); }}>
                    {eff.mode === "model" && <Select label="추론" value={eff.effort ?? "auto"} width="100%"
                        aria-description="auto는 모델 기본값" onChange={(value) => update({ effort: value as SendOptions["effort"] })}
                        options={[{ value: "auto", label: "auto" },
                            ...(eff.effort && eff.effort !== "auto" && !efforts.includes(eff.effort)
                                ? [{ value: eff.effort, label: `${eff.effort} · 미지원`, disabled: true }] : []),
                            ...efforts.map((value) => ({ value, label: value, disabled: selectedProfile?.capabilities?.effort === false }))]} />}
                    {eff.mode === "model" && (fastTier || fastEnabled) && <BooleanSelect label="Fast" value={fastEnabled}
                        disabled={!fastEnabled && !fastTier} help="켜면 사용량이 늘어날 수 있어요."
                        onChange={(on) => update({ serviceTier: on ? fastTier!.id : "default" })} />}
                </ModelSelect>}
                </Stack>
                <Stack gap={0} data-composer-fixed xstyle={[composerStyles.menuSlot, expandedModel && composerStyles.secondRow]}>
                <ActionMenu label="초안·스킬">
                    {running && eff.mode === "model" && <Select label="실행 중 보내기 방식" value={follow} disabled={!!recovering}
                        onChange={(value) => setFollow(value as FollowKind)}
                        options={[{ value: "queue", label: "대기열" }, { value: "steer", label: "지금 반영" }, { value: "interrupt", label: "중단 후 전송" }]} />}
                    {resourceKey.startsWith("session:") && <SessionSkills key={`${projectId}:${resourceKey}`} sessionId={resourceKey.slice("session:".length)} />}
                    <GroveButton variant="secondary" density="compact" onClick={saveServer} disabled={!text || !!disabled} title={disabled ?? "다른 기기에서 이어서 쓰도록 서버에 저장"}>
                        초안 서버 저장
                    </GroveButton>
                </ActionMenu>
                </Stack>
                <Stack gap={0} data-composer-fixed xstyle={[composerStyles.sendSlot, expandedModel && composerStyles.secondRow]}>
                <GroveButton
                    appearance="send"
                    width="100%"
                    aria-label={busy ? checking.current ? "확인 중…" : "보내는 중…" : recovering ? "같은 요청 확인" : running && eff.mode === "model" ? FOLLOW_LABEL[follow] : "보내기"}
                    onClick={send}
                    disabled={busy || pendingInvalid || attachments.busy || !attachments.ready || (!text.trim() && attachments.items.length === 0) || !!disabled || (!recovering && (!!problem || (eff.mode === "model" && (!ready || !eff.profileId || profileDisabled || profileMissing)) || (!!running && eff.mode === "save")))}
                    title={running && eff.mode === "save" ? "실행 중에는 메시지만 저장할 수 없습니다" : `${running && eff.mode === "model" ? FOLLOW_LABEL[follow] : "보내기"} · ${enterSends ? "Enter" : "Ctrl+Enter"}`}
                >
                    <Icon name="send" />
                </GroveButton>
                </Stack>
            </Grid>
            {msg && <GroveText as="p" display="block" type="supporting" color="secondary" role="status">{msg}</GroveText>}
            {problem && <GroveText as="p" display="block" type="supporting" color="warning" role="status">{problem}</GroveText>}
            {eff.mode === "model" && profileDisabled && <GroveText as="p" display="block" type="supporting" color="warning" role="status" data-testid="profile-disabled">선택한 모델 프로필이 비활성화돼 있습니다. 다른 모델로 자동 전환하지 않습니다.</GroveText>}
            {eff.mode === "model" && profileMissing && <GroveText as="p" display="block" type="supporting" color="warning" role="status" data-testid="profile-missing">선택한 모델 프로필이 없습니다. 다른 공급자로 자동 전환하지 않습니다. 모델을 직접 선택하세요.</GroveText>}
            {/* 모델 설정 확인 중에는 전송만 막고 문구를 띄우지 않는다. 실패했을 때만 알린다. */}
            {!ready && eff.mode === "model" && Boolean(defaults.error || profiles.error) && <GroveText as="p" display="block" type="supporting" color="warning" role="status">
                모델 선택 정보를 불러오지 못했습니다.
                <GroveButton variant="secondary" density="compact" onClick={() => { defaults.reload(); profiles.reload(); }}>모델 설정 다시 확인</GroveButton>
            </GroveText>}
        </Grid>
        </Card>
    );
}
