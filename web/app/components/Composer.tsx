import { Divider } from "@astryxdesign/core/Divider";
import { Grid } from "@astryxdesign/core/Grid";
import { Card } from "@astryxdesign/core/Card";
import { Notice } from "../design/Notice";
import { CHAT_COLUMN_WIDTH, chatLayout } from "./chat-layout.stylex";
import { Select } from "../design/Select";
import { Switch } from "@astryxdesign/core/Switch";
import { composerStyles } from "./composer.stylex";
import { ComposerInput } from "./ComposerInput";
import { CommandPaletteList, CommandPaletteItem } from "@astryxdesign/core/CommandPalette";
import { Stack } from "@astryxdesign/core/Stack";
import { Text as GroveText } from "@astryxdesign/core/Text";
import { Button as GroveButton } from "../design/Button";
import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { DetailDialog } from "./ui/Controls";
import { ApiError, api, authGeneration, isLoggedIn, newKey } from "../api/client";
import type { ModelProfile } from "../api/generated";
import { usePrefs } from "../state/device";
import { useComposerMemory, useComposerMemoryStore } from "../state/useComposerMemory";
import { clearInvalidRecovery, loadRecovery, saveRecovery, settleRecovery, validSendOptions, type PendingSend } from "../state/sendRecovery";
import { EFFORTS, type FollowKind, type SendOptions, capabilityProblem, initialProfile, resolveOptions, sendOptionsSignature, serviceTierForProfile } from "../state/sendOptions";
import { type SlashCommand, parseSlash, suggest } from "../state/slash";
import { useQuery } from "../state/store";
import { addOutgoing, outgoingResource, readOutgoing, removeOutgoing, type DraftFile } from "../state/outgoing";

import { AttachmentPicker, AttachmentSelection, useAttachments } from "./Attachments";
import { AgentConnect } from "./AgentConnect";
import { nativeCommands } from "../api/nativeCommands";
import { nativeSlashCommands, type NativeSlashCommand } from "../state/nativeCommands";
import { useNativeCommandCatalog } from "../state/useNativeCommandCatalog";
import { useCapability } from "../state/capabilities";
import { ModelSelect, useModelCatalog } from "./ModelSelect";
import { catalogModel, modelEfforts } from "./model-catalog";
import { FOLLOW_LABEL, SendButton } from "./SendButton";
import { localRecoveryStorage, requireServerAction, useServerBlockReason } from "./pwa/lifecycle";

export type { SendOptions };

const OPT_KEY = "grove.composer.options";

/// 입력창에는 역할 선택이 없다. 예전 화면이 저장한 역할은 보이지 않은 채 요청에 실리므로 복원하지 않는다.
function loadOpts(): SendOptions {
    try {
        return { mode: "model", profileId: null, ...(JSON.parse(localStorage.getItem(OPT_KEY) ?? "{}") as Partial<SendOptions>), agentId: null };
    } catch {
        return { mode: "model", profileId: null, agentId: null };
    }
}

type Props = {
    projectId: string;
    resourceKey: string; // session:<id> | project:<id>
    copyId: string; // 탭/분할 사본별 로컬 키
    disabled?: string | null;
    /// 이 대화에서 턴이 실행 중이면 기기 설정의 대기열·steer·중단 후 보내기 방식을 쓴다(UI-021).
    running?: boolean;
    runningProfileId?: string | null;
    /// key: 이 전송의 Idempotency-Key. 결과를 모르는 실패 뒤 같은 내용을 다시 보내면 같은 key를 넘겨 서버가 중복 실행하지 않는다.
    /// follow: 실행 중일 때 고른 방식(없으면 일반 전송).
    onSend: (text: string, o: SendOptions, key: string, follow?: FollowKind, attachments?: string[], moveToSession?: (id: string, deliveryKey: string) => void) => Promise<void>;
    /// 이 화면이 제공하는 slash command(UI-024). 입력창 공통 명령(/tools·/save·/model)은 Composer가 가진다.
    commands?: RunCommand[];
    /// 봇 대화는 서버가 결합한 실제 프로필을 쓰며 로컬 선택을 변경하지 않는다.
    boundProfileId?: string | null;
    worktreeId?: string;
    beforeComposer?: (modelOptions: SendOptions | null, disabled: boolean) => ReactNode;
    sendAccessory?: ReactNode;
    statusAccessory?: ReactNode;
};

/// run의 반환 문자열은 상태 줄에 보인다. 실패는 throw.
export type RunCommand = SlashCommand & { run: (arg: string, o: SendOptions) => Promise<string | void> | string | void };

export type { FollowKind } from "../state/sendOptions";

/// 작성 중인 입력은 메모리에만 둔다. 이미 보낸 요청의 결과 확인에만 기기 저장소를 쓴다.
export function Composer({ projectId, resourceKey, copyId, disabled: parentDisabled, running, runningProfileId, onSend, commands, boundProfileId, worktreeId, beforeComposer, sendAccessory, statusAccessory }: Props) {
    const serverBlocked = useServerBlockReason();
    const disabled = parentDisabled ?? serverBlocked;
    const store = localRecoveryStorage();
    const memory = useComposerMemoryStore();
    const selectionKey = `${OPT_KEY}.${resourceKey}#${copyId}`;
    const [initial] = useState(() => loadRecovery(store, resourceKey, copyId));
    const [text, setText] = useComposerMemory(resourceKey, copyId, "text", () => initial.pending?.raw ?? "");
    const [pending, setPending] = useComposerMemory<PendingSend | null>(resourceKey, copyId, "pending", () => initial.pending);
    const [pendingInvalid, setPendingInvalid] = useComposerMemory(resourceKey, copyId, "pendingInvalid", () => initial.invalid);
    const attachments = useAttachments(projectId, resourceKey, copyId, initial.pending?.attachments, initial.pending?.missing);
    const [sending] = useComposerMemory(resourceKey, copyId, "sending", () => ({ current: false }));
    const [checking] = useComposerMemory(resourceKey, copyId, "checking", () => ({ current: false }));
    const [deviceOptions] = useState(loadOpts);
    const [selectionState, setSelectionState] = useState<{ phase: "loading" | "ready"; options: SendOptions }>(() => {
        let restored = initial.pending?.intent;
        if (!restored) {
            try {
                const saved = JSON.parse(localStorage.getItem(selectionKey) ?? "null");
                if (validSendOptions(saved)) restored = { ...saved, agentId: null };
            } catch { /* 모델 선택 저장소를 사용할 수 없으면 기본값을 쓴다. */ }
        }
        return { phase: boundProfileId !== undefined || restored?.profileId ? "ready" : "loading",
            options: restored ?? { ...deviceOptions, profileId: null, model: null } };
    });
    const opts = selectionState.options;
    const setOpts = (value: SendOptions | ((options: SendOptions) => SendOptions)) => setSelectionState((current) => {
        const options = typeof value === "function" ? value(current.options) : value;
        return { phase: options.profileId ? "ready" : current.phase, options };
    });
    // 응답을 기다리는 동안 다른 영역으로 옮겨 다시 그려도, 보낸 쪽은 지금 입력창의 글·첨부를 본다.
    const [selection] = useComposerMemory(resourceKey, copyId, "selection", () => ({ current: { options: opts, ids: attachments.ids, text, files: attachments.items.length } }));
    selection.current = { options: opts, ids: attachments.ids, text, files: attachments.items.length };
    const [owner] = useState(authGeneration);
    const alive = useRef(true);
    useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
    const [busy, setBusy] = useComposerMemory(resourceKey, copyId, "busy", () => false);
    const [msg, setMsg] = useComposerMemory<string | null>(resourceKey, copyId, "message", () => null);
    const [expandedModel, setExpandedModel] = useState(false);
    const [inputFocused, setInputFocused] = useState(false);
    const profiles = useQuery<ModelProfile[]>("profiles", () => api.get("/model-profiles"));
    const defaults = useQuery<{ items: { key: string; effective: unknown }[] }>(boundProfileId === undefined ? `settings:${projectId}` : null,
        () => api.get(`/settings/effective?project_id=${encodeURIComponent(projectId)}`));
    const prefs = usePrefs("runningSendMode", "enterToSend");
    const follow = prefs.runningSendMode;
    const ready = boundProfileId !== undefined || selectionState.phase === "ready";
    useEffect(() => {
        if (!ready || boundProfileId !== undefined || !isLoggedIn() || authGeneration() !== owner) return;
        try { localStorage.setItem(selectionKey, JSON.stringify(opts)); }
        catch { setMsg("이 입력창의 모델 선택을 저장하지 못했어요."); }
    }, [ready, boundProfileId, owner, selectionKey, opts]);
    useEffect(() => {
        if (ready || !profiles.data || !defaults.data) return;
        const configured = defaults.data.items.find((item) => item.key === "model.default_profile")?.effective;
        const ids = [...profiles.data].sort((a, b) => Number(a.enabled === false) - Number(b.enabled === false)).map((profile) => profile.id);
        setSelectionState((current) => current.phase === "ready" ? current : {
            phase: "ready", options: { ...current.options, profileId: initialProfile(configured, deviceOptions.profileId, ids),
                model: initialProfile(configured, deviceOptions.profileId, ids) === deviceOptions.profileId ? deviceOptions.model : null },
        });
    }, [ready, profiles.data, defaults.data, deviceOptions.profileId]);

    // 화면 선택과 보내는 값이 같도록 매 렌더 계산한다(기본 프로필을 상태로 복사하지 않음).
    const resolved = resolveOptions(
        opts,
        profiles.data && [...profiles.data].sort((a, b) => Number(a.enabled === false) - Number(b.enabled === false)).map((p) => p.id),
    );
    const bound = boundProfileId === undefined ? resolved : { ...resolved, profileId: boundProfileId, model: null, agentId: null };
    const selectedProfile = profiles.data?.find((p) => p.id === bound.profileId);
    // 예전 로컬 기본값(tools: false)은 새 요청에 쓰지 않는다. 전송 복구는 원래 요청을 그대로 쓴다.
    const eff = { ...bound, tools: bound.toolOverride,
        serviceTier: serviceTierForProfile(bound.serviceTier, selectedProfile?.capabilities) };
    const catalog = useModelCatalog(selectedProfile);
    const nativeSupported = useCapability("native_skills_v1");
    // 선택한 CLI의 명령 목록은 입력창을 쓰기 시작하면 미리 받고, "/" 입력 때 오래된 목록만 갱신한다.
    const nativeEligible = eff.mode === "model" && ready && nativeSupported === true && !disabled
        && ["claude_code", "codex_cli"].includes(selectedProfile?.protocol ?? "");
    const slashMode = text.trimStart().startsWith("/") && !text.trimStart().startsWith("//");
    const nativeActive = nativeEligible && slashMode;
    const nativeSession = resourceKey.startsWith("session:") ? resourceKey.slice(8) : undefined;
    const nativeKey = nativeEligible ? `native-commands:${JSON.stringify([projectId, resourceKey, worktreeId, selectedProfile!.id, selectedProfile!.revision])}` : null;
    const nativeCatalog = useNativeCommandCatalog(nativeKey, inputFocused, slashMode,
        () => nativeCommands(projectId, selectedProfile!.id, nativeSession, worktreeId));
    const selectedModel = catalogModel(catalog.data?.models, selectedProfile, eff.model);
    const efforts = modelEfforts(selectedProfile, selectedModel);
    const tiers = selectedProfile?.capabilities.fast ? selectedModel?.service_tiers ?? [] : [];
    const fastTier = tiers.find((tier) => tier.id === "priority");
    const fastEnabled = !!eff.serviceTier && eff.serviceTier !== "default";
    const profileDisabled = selectedProfile?.enabled === false;
    const profileMissing = !!eff.profileId && profiles.data !== undefined && !selectedProfile;
    const problem = capabilityProblem(selectedProfile?.capabilities, eff, attachments.items.some((item) =>
        (item.attachment?.mime ?? item.file?.type)?.startsWith("image/")), selectedModel);
    const update = (patch: Partial<SendOptions>) => {
        setOpts((o) => ({ ...o, ...patch }));
        // 다른 탭이 저장한 값을 오래된 입력창의 초기값으로 덮어쓰지 않는다.
        if (!isLoggedIn() || authGeneration() !== owner) return;
        try { localStorage.setItem(OPT_KEY, JSON.stringify({ ...loadOpts(), ...patch })); }
        catch { setMsg("이 기기의 모델 선택을 저장하지 못했어요."); }
    };
    // 모바일(터치) 키보드에는 Shift가 불편하므로 Enter는 항상 줄바꿈이고, 보내기 버튼으로 보낸다.
    const enterSends = prefs.enterToSend && !(typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches);
    // 결과를 알 수 없는 전송(네트워크 끊김·서버 오류)의 key. 같은 내용·옵션으로 다시 보낼 때만 재사용한다(UI-028).
    const recovering = !pending?.missing && pending?.raw === text && pending.sig === sendOptionsSignature(opts, attachments.ids) ? pending : null;
    const runningFollow = running && eff.mode === "model" && !recovering ? follow : undefined;
    const steerHint = runningFollow && profiles.data?.find((p) => p.id === runningProfileId)?.protocol === "claude_code"
        ? "현재 Claude 실행이 끝난 뒤 반영돼요." : undefined;
    const showSteerHint = steerHint && runningFollow === "steer" && (text.trim() || attachments.items.length > 0);
    const steerHintId = useId();
    // slash command: 공통 명령 + 화면 명령. 등록된 이름만 명령이고 나머지 "/"는 보내지 않는다(//로 시작하면 글).
    const builtins: RunCommand[] = [
        {
            name: "tools",
            args: "on|off",
            description: "Grove 도구 루프 켜기·끄기(CLI 자체 도구와 별개)",
            run: (a) => {
                const on = a ? a === "on" : !(eff.tools ?? (selectedProfile?.capabilities.tools !== false));
                update({ toolOverride: on });
                return `Grove 도구 사용을 ${on ? "켰습니다" : "껐습니다"}`;
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
    const localCommands = [...builtins, ...(commands ?? [])];
    const allCmds: (RunCommand | NativeSlashCommand)[] = [
        ...localCommands, ...nativeSlashCommands(nativeCatalog.data?.commands ?? [], localCommands),
    ];
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

    const send = async (once?: FollowKind) => {
        if ((!text.trim() && attachments.items.length === 0) || busy || sending.current || (attachments.failed && !recovering) || !!disabled || pendingInvalid) return;
        try { requireServerAction(); } catch (e) { setMsg((e as Error).message); return; }
        if (recovering) { await sendText(recovering.body, text); return; }
        const parsed = parseSlash(text, allCmds.map((c) => c.name.toLowerCase()));
        if (parsed.kind === "unknown") {
            setMsg(nativeActive && (nativeCatalog.loading || nativeCatalog.error || !nativeCatalog.data)
                ? nativeCatalog.error instanceof Error ? nativeCatalog.error.message : "CLI 스킬·명령 목록을 확인한 뒤 보내세요."
                : `알 수 없는 명령 /${parsed.name}입니다. '/'를 입력하면 명령 목록이 보이고, '/'로 시작하는 글은 '//'로 시작해 보내세요.`);
            return;
        }
        if (parsed.kind === "command") {
            const c = allCmds.find((x) => x.name.toLowerCase() === parsed.name)!;
            if ("nativeId" in c) {
                await sendText(text, text, undefined, c.nativeId, once);
                return;
            }
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
        await sendText(parsed.text, text, undefined, undefined, once);
    };

    /// body: 실제로 보낼 글("//" 이스케이프를 푼 값), raw: 입력창 원문.
    /// 새 전송은 누른 즉시 입력창을 비우고 보낸 글을 대화에 먼저 보인다. 서버가 받지 못하면 입력창으로 되돌린다.
    /// 결과 확인(같은 요청 키)은 입력을 그대로 두고, 접수가 확인된 뒤에만 비운다.
    const sendText = async (body: string, raw: string, original?: PendingSend, nativeCommand?: string, once?: FollowKind) => {
        if (busy || sending.current || !!disabled || pendingInvalid) return;
        try { requireServerAction(); } catch (e) { setMsg((e as Error).message); return; }
        const confirmation = original ?? (!pending?.missing && pending?.raw === raw && pending.sig === sendOptionsSignature(opts, attachments.ids) ? pending : null);
        if (!confirmation && attachments.failed) return;
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
        const options = confirmation?.options ?? { ...eff, ...(nativeCommand ? { nativeCommand } : {}) };
        const kind = confirmation ? confirmation.follow : running ? once ?? follow : undefined;
        let intent = opts;
        if (!confirmation && options.mode === "model" && boundProfileId === undefined) {
            // 보내기를 누른 순간 보이는 기본 모델도 사용자가 선택한 대상이다.
            intent = { ...opts, profileId: options.profileId };
            setOpts(intent);
        }
        const key = confirmation?.key ?? newKey();
        selection.current = { ...selection.current, options: intent };
        const persistUploads = (items: DraftFile[]) => {
            if (!store) throw new Error("send recovery storage unavailable");
            const missing = items.flatMap((item, index) => !item.attachment && item.file
                ? [{ index, name: item.file.name, size: item.file.size }] : []);
            if (!missing.length) return;
            const ready = items.flatMap((item) => item.attachment ? [item.attachment] : []);
            const ids = ready.map((item) => item.id);
            const record = { body: requestBody, raw, key, intent, options, follow: kind,
                sig: sendOptionsSignature(intent, ids), attachmentIds: ids, attachments: ready, missing };
            saveRecovery(store, resourceKey, copyId, record);
            setPending(record);
        };
        if (!confirmation && attachments.busy) {
            try { persistUploads(attachments.items); }
            catch {
                sending.current = false;
                setBusy(false);
                setMsg("전송 사본을 보관하지 못해 보내지 않았습니다. 기기 저장 공간을 확인하세요.");
                return;
            }
        }
        const draft = confirmation ? null : attachments.take((items) => {
            if (authGeneration() === owner) {
                // 저장 공간이 부족하면 앞서 보관한 사본을 유지한다.
                try { persistUploads(items); } catch { /* 최종 전송 전 다시 보관한다. */ }
            }
        });
        // 기다리는 동안 새로 쓴 글·첨부는 지우지 않고, 보내지 못한 내용을 그 앞에 돌려놓는다.
        const giveBack = (files: DraftFile[]) => {
            setText((cur) => (raw && cur ? `${raw}\n${cur}` : raw || cur));
            attachments.restore(files);
        };
        try {
            let files: DraftFile[] = [];
            if (draft) {
                setText((cur) => (cur === raw ? "" : cur));
                selection.current = { ...selection.current, text: "", files: 0 };
                addOutgoing({ key, resource: outgoingResource(resourceKey, copyId), copyId, text: requestBody, files: draft.items, follow: kind });
                // 올리는 중인 첨부가 있으면 다 올라간 뒤에 보낸다. 글과 사진은 이미 대화에 보인다.
                files = await draft.settled;
                if (authGeneration() !== owner) return;
                if (files.some((file) => !file.attachment)) {
                    giveBack(files);
                    if (alive.current) setMsg("첨부를 올리지 못해 보내지 않았어요.");
                    return;
                }
            }
            const sent = confirmation?.attachments ?? files.map((file) => file.attachment!);
            const ids = confirmation?.attachmentIds ?? sent.map((attachment) => attachment.id);
            const sig = confirmation?.sig ?? sendOptionsSignature(intent, ids);
            const snapshot: PendingSend = { body: requestBody, raw, sig, key, intent: confirmation?.intent ?? intent,
                options: { ...options }, follow: kind, attachmentIds: [...ids], attachments: sent };
            try {
                if (!store) throw new Error("send recovery storage unavailable");
                saveRecovery(store, resourceKey, copyId, snapshot);
                if (pending?.missing && pending.key !== key) settleRecovery(store, resourceKey, pending.key);
            } catch {
                if (draft) giveBack(files);
                setMsg("전송 사본을 보관하지 못해 보내지 않았습니다. 기기 저장 공간을 확인하세요.");
                return;
            }
            setPending(snapshot);
            let receipt = snapshot;
            let resource = resourceKey;
            const moveToSession = (id: string, deliveryKey: string) => {
                if (authGeneration() !== owner) throw new Error("인증이 변경됐어요.");
                const destination = `session:${id}`;
                const next = { ...snapshot, key: deliveryKey };
                saveRecovery(store, destination, copyId, next);
                settleRecovery(store, resourceKey, key);
                receipt = next;
                resource = destination;
                setPending(next);
                memory.move(resourceKey, destination, copyId);
                const outgoing = readOutgoing(outgoingResource(resourceKey, copyId)).find((entry) => entry.key === key);
                if (outgoing) {
                    removeOutgoing(key);
                    addOutgoing({ ...outgoing, resource: destination });
                }
            };
            try {
                await onSend(requestBody, options, key, kind, ids, moveToSession);
                if (authGeneration() !== owner) return;
                settleRecovery(store, resource, receipt.key);
                setPending(null);
                if (!draft) {
                    const sameSelection = sendOptionsSignature(selection.current.options, selection.current.ids) === sig;
                    attachments.clearSent(ids);
                    // 확인하는 동안 새로 입력한 글은 지우지 않는다(확인한 글 그대로일 때만 비움).
                    setText((cur) => (sameSelection && cur === raw ? "" : cur));
                }
            } catch (e) {
                if (authGeneration() !== owner) return;
                // 응답을 못 받았거나 서버 오류면 실제로 처리됐는지 모른다: 자동 재전송하지 않고 같은 요청 키로 확인하게 한다.
                const unknown = !(e instanceof ApiError) || e.status >= 500 || e.status === 408
                    || (e.details as { result_unknown?: boolean } | undefined)?.result_unknown === true;
                if (unknown) {
                    setPending(receipt);
                    // 그사이 다음 글을 쓰기 시작했으면 섞지 않는다. 원래 요청은 안내의 '원래 요청 결과 확인'으로 확인한다.
                    if (draft && selection.current.text === "" && selection.current.files === 0) giveBack(files);
                } else {
                    settleRecovery(store, resource, receipt.key);
                    setPending(null);
                    if (draft) giveBack(files);
                    setMsg(e.message);
                }
            }
        } finally {
            removeOutgoing(key);
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

    const retryOptions = boundProfileId === undefined && eff.mode === "model" ? eff : null;
    const retryDisabled = !!disabled || busy || !!(retryOptions && (!ready || !selectedProfile || profileDisabled
        || capabilityProblem(selectedProfile.capabilities, { ...retryOptions, tools: undefined }, false, selectedModel)));
    return <>
        {beforeComposer?.(retryOptions, retryDisabled)}
        <Card width="100%" maxWidth={CHAT_COLUMN_WIDTH} padding={0} elevation="low" xstyle={chatLayout.composer} data-ui="composer" data-testid="composer">
        {statusAccessory}
        <Grid gap={1} xstyle={composerStyles.content}>
            {pendingInvalid && <Notice tone="yellow" role="alert">
                전송 사본이 손상되어 원래 요청을 확인할 수 없습니다. 서버 대화·실행 기록을 먼저 확인하세요.
                <GroveButton variant="secondary" density="compact" onClick={() => {
                    try {
                        if (!store) throw new Error("send recovery storage unavailable");
                        clearInvalidRecovery(store, resourceKey);
                        setPendingInvalid(false);
                    } catch { setMsg("전송 확인 기록을 정리하지 못했어요. 기기 저장소를 확인하세요."); }
                }}>기록 확인 후 새 전송 허용</GroveButton>
            </Notice>}
            {pending?.missing && !busy && <Notice tone="yellow" role="status">
                업로드 도중 전송이 중단됐어요. 복원한 글과 첨부를 확인하고 보내 주세요.
                <GroveButton variant="secondary" density="compact" onClick={() => {
                    if (store) settleRecovery(store, resourceKey, pending.key);
                    setPending(null);
                }}>복구 기록 닫기</GroveButton>
            </Notice>}
            {pending && !pending.missing && !busy && (
                <Notice tone="yellow" role="alert" data-testid="send-unsure">
                    보냈는지 확인할 수 없습니다(연결 문제). 입력은 그대로 보관했고 자동으로 다시 보내지 않습니다.
                    글·모델/도구 옵션·첨부를 바꾸지 않고 확인하면 원래 전송 위치·옵션·같은 요청 키를 사용합니다.
                    {!recovering && <>
                        <DetailDialog label="원래 전송 요청" title="원래 요청 보기"><pre>{pending.raw}</pre>
                            <GroveText as="p" display="block" type="supporting" color="inherit">모델: {pending.options.profileId ?? "없음"} · 첨부 {pending.attachmentIds.length}개 · {pending.follow ? FOLLOW_LABEL[pending.follow] : pending.options.mode === "save" ? "메시지만 저장" : "모델로 보내기"}</GroveText>
                        </DetailDialog>
                        <GroveButton variant="secondary" density="compact" disabled={busy || !!disabled}
                            onClick={() => void sendText(pending.body, pending.raw, pending)}>원래 요청 결과 확인</GroveButton>
                        <GroveText type="supporting" color="inherit">현재 입력과 새 첨부는 보존합니다. 현재 내용을 보내면 별도의 새 요청입니다.</GroveText>
                    </>}
                </Notice>
            )}
            {nativeActive && nativeCatalog.loading && !nativeCatalog.data && <GroveText type="supporting" color="secondary" role="status">CLI 스킬·명령을 읽는 중…</GroveText>}
            {nativeActive && nativeCatalog.error instanceof Error && <GroveText type="supporting" color="error" role="alert">{nativeCatalog.error.message}</GroveText>}
            {nativeActive && nativeCatalog.data?.has_errors && <GroveText type="supporting" color="warning" role="status">일부 스킬을 읽지 못했어요. CLI 설정을 확인하세요.</GroveText>}
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
                    update({ profileId: profile.id, mode: "model", toolOverride: undefined });
                }} />
            )}
            <AttachmentSelection draft={attachments} disabled={!!disabled} />
            <ComposerInput onFiles={(files) => { if (!disabled) void attachments.add(files); }}
                value={text}
                onChange={(value) => {
                    setText(value);
                    setHideSugg(false);
                    setSel(0);
                }}
                onBlur={() => { setHideSugg(true); setInputFocused(false); }}
                onFocus={() => { setHideSugg(false); setInputFocused(true); }}
                aria-autocomplete={sugg.length > 0 ? "list" : undefined}
                aria-controls={sugg.length > 0 ? commandListId : undefined}
                aria-activedescendant={activeCommandId}
                onKeyDown={onKey}
                onCompositionStart={() => (composing.current = true)}
                onCompositionEnd={() => (composing.current = false)}
                enterKeyHint={enterSends ? "send" : "enter"}
                // 연결 차단 사유는 상단 연결 토스트가 알린다. 여기에는 이 대화 고유의 사유만 보인다.
                placeholder={parentDisabled ?? "메시지를 입력하세요"}
                isDisabled={!!parentDisabled}
            />
            <Grid gap={1} xstyle={[chatLayout.bar, composerStyles.toolbar]} data-testid="composer-bar" data-model-expanded={expandedModel}>
                <Stack gap={0} data-composer-fixed xstyle={[composerStyles.attachmentSlot, expandedModel && composerStyles.secondRow]}>
                    <AttachmentPicker key={resourceKey} draft={attachments} disabled={!!disabled} onIssue={setMsg} />
                </Stack>
                <Stack gap={0} xstyle={[composerStyles.modelSlot, expandedModel && composerStyles.expandedModel]}>
                {((profiles.data?.length ?? 0) > 0 || eff.mode === "save" || eff.profileId) && <ModelSelect
                    profiles={profiles.data ?? []} profileId={eff.profileId} model={eff.model} ready={ready}
                    effort={eff.mode === "model" ? eff.effort ?? "auto" : undefined} fast={fastEnabled}
                    save={eff.mode === "save"} bound={boundProfileId !== undefined}
                    onExpandedChange={setExpandedModel}
                    onFavorite={(favorite) => {
                        update({ profileId: favorite.profile_id, model: favorite.model, mode: "model",
                            effort: favorite.effort as SendOptions["effort"], serviceTier: favorite.fast ? "priority" : "default" });
                        setMsg(null);
                    }}
                    onChange={(profileId, model) => { update({ profileId, model, mode: "model" }); setMsg(null); }}>
                    {eff.mode === "model" && <Stack direction="horizontal" align="center" justify="between" gap={2} minHeight={44}>
                        <GroveText type="inherit" color="secondary">추론</GroveText>
                        <Select label="추론" hideLabel variant="ghost" value={eff.effort ?? "auto"}
                            controlStyle={{ minHeight: 44 }}
                            aria-description="auto는 모델 기본값" onChange={(value) => update({ effort: value as SendOptions["effort"] })}
                            options={[{ value: "auto", label: "auto" },
                                ...(eff.effort && eff.effort !== "auto" && !efforts.includes(eff.effort)
                                    ? [{ value: eff.effort, label: `${eff.effort} · 미지원`, disabled: true }] : []),
                                ...efforts.map((value) => ({ value, label: value, disabled: selectedProfile?.capabilities?.effort === false }))]} />
                    </Stack>}
                    {eff.mode === "model" && (fastTier || fastEnabled) && <>
                        <Divider />
                        <Stack minHeight={44} justify="center">
                            <Switch label="Fast" value={fastEnabled}
                                width="100%" size="sm" labelPosition="start" labelSpacing="spread"
                                isDisabled={!fastEnabled && !fastTier} labelTooltip="켜면 사용량이 늘어날 수 있어요."
                                onChange={(on) => update({ serviceTier: on ? fastTier!.id : "default" })} />
                        </Stack>
                    </>}
                </ModelSelect>}
                </Stack>
                <Stack direction="horizontal" align="center" gap={1} data-composer-fixed xstyle={[composerStyles.sendSlot, expandedModel && composerStyles.secondRow]}>
                {sendAccessory}
                <SendButton
                    label={busy ? checking.current ? "확인 중…" : "보내는 중…" : recovering ? "같은 요청 확인" : running && eff.mode === "model" ? FOLLOW_LABEL[follow] : "보내기"}
                    onSend={(once) => void send(once)}
                    follow={runningFollow}
                    steerHint={steerHint}
                    describedBy={showSteerHint ? steerHintId : undefined}
                    disabled={busy || pendingInvalid || (!text.trim() && attachments.items.length === 0) || !!disabled || (!recovering && (attachments.failed || !!problem || (eff.mode === "model" && (!ready || !eff.profileId || profileDisabled || profileMissing)) || (!!running && eff.mode === "save")))}
                    title={running && eff.mode === "save" ? "실행 중에는 메시지만 저장할 수 없습니다" : `${running && eff.mode === "model" ? FOLLOW_LABEL[follow] : "보내기"} · ${enterSends ? "Enter" : "Ctrl+Enter"}`}
                />
                </Stack>
            </Grid>
            {showSteerHint && <GroveText as="p" id={steerHintId} display="block" type="supporting" color="secondary">{steerHint}</GroveText>}
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
    </>;
}
