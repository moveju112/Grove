import { HintText } from "../design/HintText";
import { ChatMessage, ChatMessageBubble } from "@astryxdesign/core/Chat";
import { Card } from "@astryxdesign/core/Card";
import { contentStyles } from "../design/content.stylex";
import { Select } from "../design/Select";
import { CodeBlock } from "../design/CodeBlock";
import { StatusBadge } from "../design/StatusBadge";
import { List as GroveList, ListItem as GroveListItem } from "@astryxdesign/core/List";
import { Heading as GroveHeading } from "@astryxdesign/core/Heading";
import { Text as GroveText } from "@astryxdesign/core/Text";
import { Button as GroveButton } from "../design/Button";
import { AttachmentList, type Attachment } from "./Attachments";
import { ActionMenu, DetailDialog, ToolsTrigger, Workbench } from "./ui/Controls";
import { Suspense, lazy, memo, useEffect, useLayoutEffect, useRef, useState } from "react";
import { FileRefContext, Markdown } from "./Markdown";
import { type Prefs, usePrefs } from "../state/device";
import { When } from "./When";
import { useFocusRequest } from "../state/focus";
import { queueText } from "../state/queue";
import { ApiError, api, isLoggedIn } from "../api/client";
import type { BotRoom, Definition, Message, MessagePage, ModelProfile, RecentItem, Session, ToolCallRow, Turn } from "../api/generated";
import { useLive, useQuery } from "../state/store";
import { Composer, type FollowKind, type RunCommand, type SendOptions } from "./Composer";
import { modelOptionCapabilities } from "../state/sendOptions";
import { Icon } from "./icons";
import { AgentRunsPanel, useAgentRuns } from "./AgentRunsPanel";
import { ChangesPanel } from "./ChangesPanel";
import { FilesView } from "./FilesView";
import { ContextMeter } from "./ContextMeter";
import { HelpTip } from "./HelpTip";
import { TasksPanel } from "./TasksPanel";
import { RemoteWatchesPanel } from "./RemoteWatchesPanel";
import type { Opener } from "./Workspace";
import { WorktreeSelect } from "./WorktreesPanel";
import { loadScrollPosition, saveScrollPosition } from "../state/scrollPosition";
import { VirtualMessages } from "./VirtualMessages";
import { usePaneVisible } from "../state/paneVisibility";
import { deliveryTiming } from "../state/deliveryTiming";
import { useBotAvatar } from "../state/botAvatar";
import { useCapability } from "../state/capabilities";
import { AssistantIdentity } from "./assistant-identity";
import { ApprovalCard, currentApprovalContract } from "./approvals";
import { TurnTiming } from "./turn-timing/TurnTiming";
import { useServerBlockReason } from "./pwa/lifecycle";
import { MessageCopyButton as CopyButton } from "./capabilities/MessageCopyButton";
import { CompactionDetails, type CompactionRecord } from "./compaction/CompactionDetails";
import { ServerActionButton } from "./pwa/ServerActionButton";
import { Stack } from "@astryxdesign/core/Stack";
import { chatLayout } from "./chat-layout.stylex";
import { LoadingBar } from "./LoadingScreen";
import { TextArea } from "../design/Fields";
import { AssistantResponse, splitResponse, type ResponseContent } from "./AssistantResponse";
import { cliActivitySummary, type CliActivity } from "./cli-activity";

const GoalsPanel = lazy(() => import("./GoalsPanel").then(({ GoalsPanel }) => ({ default: GoalsPanel })));

type Props = { tabId: string; sessionId: string; projectId: string; open: Opener };

export function SessionView({ tabId, sessionId, projectId, open }: Props) {
    const visible = usePaneVisible();
    const [pageVisible, setPageVisible] = useState(() => typeof document !== "undefined" && document.visibilityState === "visible");
    useEffect(() => {
        const changed = () => setPageVisible(document.visibilityState === "visible");
        document.addEventListener("visibilitychange", changed);
        return () => document.removeEventListener("visibilitychange", changed);
    }, []);
    const serverBlocked = useServerBlockReason();
    useEffect(() => visible ? deliveryTiming.watch(sessionId) : undefined, [visible, sessionId]);
    const prefs = usePrefs();
    const session = useQuery<Session>(`session:${sessionId}`, () => api.get(`/sessions/${sessionId}`));
    const latest = useQuery<MessagePage>(`messages:${sessionId}`, () => api.get(`/sessions/${sessionId}/messages?limit=100`));
    const turns = useQuery<Turn[]>(`turns:${sessionId}`, () => api.get(`/sessions/${sessionId}/turns?limit=5`));
    const lastTurn = turns.data?.[0];
    const active = turns.data?.find((t) => ["queued", "running", "awaiting_approval"].includes(t.status));
    const completedTurnId = lastTurn?.status === "completed" ? lastTurn.id : undefined;
    const calls = useQuery<ToolCallRow[]>(`calls:${sessionId}`, () => api.get(`/tool-calls?session_id=${sessionId}&limit=200`));
    const workflows = useQuery<Definition[]>("definitions:workflow", () => api.get("/definitions?kind=workflow"));
    const partial = useLive((live) => {
        const snapshot = live.partials[sessionId] as (ResponseContent & { turn_id: string; tool_calls: string[] }) | null | undefined;
        return visible && active?.status === "running" && snapshot?.turn_id === active.id ? snapshot : undefined;
    });
    const [older, setOlder] = useState<Message[]>([]);
    const [olderMore, setOlderMore] = useState<boolean | null>(null);
    const latestRef = useRef(latest.data);
    latestRef.current = latest.data;
    const [err, setErr] = useState<string | null>(null);
    const bottom = useRef<HTMLDivElement>(null);
    const s = session.data;
    const roomsSupported = useCapability("bot_rooms_v1");
    const room = useQuery<BotRoom | null>(roomsSupported === false ? null : `bot-room:${sessionId}`,
        () => api.get(`/sessions/${sessionId}/bot-room`, { requires: ["bot_rooms_v1"] }));
    const background = useQuery<{ tasks: { status: string }[] }>(`tasks:${sessionId}`, () => api.get(`/sessions/${sessionId}/tasks`));
    const delegated = useAgentRuns(sessionId);

    // 최근 항목 갱신 + 읽음 표시(보고 있는 동안 마지막 메시지까지 읽음)
    const lastSeq = s?.last_message_seq ?? 0;

    // 봇 대화도 보고 있는 동안 도착한 메시지는 읽은 것으로 기록한다(서버 위치는 뒤로 가지 않음).
    const botId = s?.bot_id ?? null;
    const bots = useQuery<{ bots: { id: string; name: string; avatar_sha256: string | null; profile_id: string | null }[] }>(botId ? "bots" : null, () => api.get("/bots"));
    const bot = bots.data?.bots.find((b) => b.id === botId);
    const assistantImage = useBotAvatar(botId, bot?.avatar_sha256 ?? null);
    const activeBotName = (turns.data?.find((t) => ["queued", "running", "awaiting_approval"].includes(t.status))?.definition as { bot?: { name?: string } } | undefined)?.bot?.name;
    const assistantName = room.data ? activeBotName ?? "어시스턴트" : bot?.name ?? "어시스턴트";
    useEffect(() => {
        if (visible && pageVisible && document.visibilityState === "visible" && botId && lastSeq > 0) void api.post(`/bots/${botId}/seen`, { seq: lastSeq }).catch(() => undefined);
    }, [visible, pageVisible, botId, lastSeq]);
    useEffect(() => {
        if (!s || !visible || !pageVisible || serverBlocked) return;
        const t = setTimeout(() => {
            if (document.visibilityState !== "visible") return;
            void api
                .post<RecentItem>("/recent/touch", {
                    kind: "session", project_id: projectId, resource_id: sessionId, view_state: { last_seen_seq: lastSeq },
                    ...(completedTurnId ? { seen_completed_turn_id: completedTurnId } : {}),
                })
                .catch((error) => setErr(error instanceof ApiError ? error.message : "대화 확인 상태를 저장하지 못했습니다."));
        }, 300);
        return () => clearTimeout(t);
    }, [visible, pageVisible, serverBlocked, sessionId, projectId, lastSeq, completedTurnId, !!s]); // eslint-disable-line react-hooks/exhaustive-deps

    // 자동 스크롤(UI-009): 맨 아래 근처를 보고 있을 때만 새 내용을 따라 내려간다. 위를 읽는 중이면 위치를 그대로 두고 알림만 띄운다.
    const msgsRef = useRef<HTMLDivElement>(null);
    const [savedPosition] = useState(() => loadScrollPosition(tabId, sessionId));
    const pendingPosition = useRef(savedPosition?.atBottom ? null : savedPosition);
    const [, restoredPosition] = useState(0);
    const clearPendingPosition = () => {
        if (!pendingPosition.current) return;
        pendingPosition.current = null;
        // 가상 목록에 targetSeq 해제를 같은 layout 단계에서 전달한다.
        // ref만 지우면 다음 측정이 복원 전 anchor를 다시 적용할 수 있다.
        restoredPosition((version) => version + 1);
    };
    const stick = useRef(savedPosition?.atBottom ?? true);
    const [unseen, setUnseen] = useState(false);
    const scroller = () => msgsRef.current?.closest('[data-testid="pane-body"]') as HTMLElement | null;
    const composerElement = () => msgsRef.current?.closest('[data-testid="session-view"]')?.querySelector<HTMLElement>('[data-testid="compose-surface"]');
    const messageViewportBottom = () => {
        const edge = scroller()?.getBoundingClientRect().bottom ?? 0;
        const composer = composerElement();
        return composer ? Math.min(edge, composer.getBoundingClientRect().top - 12) : edge;
    };
    const updateScrollMargin = () => {
        const el = scroller();
        const marker = bottom.current;
        if (!el || !marker) return;
        // sticky 입력창 뒤가 아니라 실제로 읽을 수 있는 영역 끝에 최신 메시지를 맞춘다.
        marker.style.scrollMarginBottom = `${Math.max(0, el.getBoundingClientRect().bottom - messageViewportBottom())}px`;
    };
    const scrollEnd = () => {
        updateScrollMargin();
        bottom.current?.scrollIntoView({ block: "end" });
    };
    const capturePosition = () => {
        const el = scroller();
        const data = latestRef.current;
        if (!el || !el.clientHeight || !el.clientWidth || !data || pendingPosition.current || !isLoggedIn()) return;
        const viewport = el.getBoundingClientRect();
        const row = [...(msgsRef.current?.querySelectorAll<HTMLElement>("[data-seq]") ?? [])].find((node) => {
            const rect = node.getBoundingClientRect();
            return rect.bottom > viewport.top && rect.top < viewport.bottom;
        });
        if (!stick.current && !row) return;
        saveScrollPosition(tabId, {
            sessionId, timelineRevision: data.timeline_revision, lastSeq: data.items.at(-1)?.seq ?? 0,
            atBottom: stick.current, anchorSeq: stick.current ? null : Number(row!.dataset.seq),
            offset: stick.current ? 0 : row!.getBoundingClientRect().top - viewport.top,
        });
    };
    useLayoutEffect(() => () => capturePosition(), [tabId, sessionId]); // eslint-disable-line react-hooks/exhaustive-deps
    useLayoutEffect(() => {
        const el = scroller();
        if (!el) return;
        const on = () => {
            if (!el.clientHeight || !el.clientWidth) return;
            // 메시지 끝 표시가 스크롤 영역 아래쪽 80px 안에 보이면 '맨 아래를 보는 중'이다(아래 패널·입력창 높이와 무관).
            const b = bottom.current?.getBoundingClientRect();
            stick.current = !!b && b.top <= messageViewportBottom() + 80;
            if (stick.current) setUnseen(false);
            capturePosition();
        };
        // 브라우저 scroll anchoring이 아래에 내용이 늘 때 위치를 고치며 scroll 이벤트를 내면 '맨 아래 보는 중'이 꺼진다.
        // 위쪽에 붙이는 이전 페이지는 직접 보정하므로 이 영역에서는 끈다.
        const prevAnchor = el.style.overflowAnchor;
        el.style.overflowAnchor = "none";
        el.addEventListener("scroll", on, { passive: true });
        return () => {
            el.removeEventListener("scroll", on);
            el.style.overflowAnchor = prevAnchor;
        };
    }, [!!s, !!latest.data]); // eslint-disable-line react-hooks/exhaustive-deps
    const toBottom = () => {
        clearPendingPosition();
        stick.current = true;
        setUnseen(false);
        scrollEnd();
    };
    useEffect(() => {
        if (!visible || pendingPosition.current) return;
        if (stick.current) scrollEnd();
        else if (!savedPosition || (latest.data?.items.at(-1)?.seq ?? 0) > savedPosition.lastSeq || partial?.text || partial?.reasoning) setUnseen(true);
        // 최신 페이지는 항상 최근 N개라 개수가 아니라 마지막 메시지로 새 글을 판단한다.
    }, [visible, !!s, latest.data?.items.at(-1)?.seq, partial?.text, partial?.reasoning]);

    useLayoutEffect(() => {
        const composer = composerElement();
        const el = scroller();
        if (!visible || !composer || !el) return;
        // resize가 수동 scroll 이벤트보다 먼저 와도 사용자가 읽던 위치를 덮지 않는다.
        // 위치 보정은 VirtualMessages가 맡고 여기서는 가려지는 영역만 갱신한다.
        const observer = new ResizeObserver(updateScrollMargin);
        observer.observe(composer);
        observer.observe(el);
        return () => observer.disconnect();
    }, [visible, !!s, !!latest.data]); // eslint-disable-line react-hooks/exhaustive-deps

    // 최신 화면은 '최근 N개' 창이다. 새 메시지로 창이 밀리면 빠져나간 메시지를 이전 목록으로 옮겨, 읽던 메시지가 사라지지 않게 한다(UI-008).
    // 같은 렌더 안에서 옮겨야 한다: effect로 옮기면 한 번은 위쪽 메시지가 빠졌다 다시 붙어 내용이 밀리고 스크롤이 어긋난다.
    const [seenLatest, setSeenLatest] = useState(latest.data);
    if (latest.data !== seenLatest) {
        if (latest.data?.timeline_revision !== seenLatest?.timeline_revision) {
            setOlder([]);
            setOlderMore(null);
        } else {
            const first = latest.data?.items[0]?.seq;
            const slid = first == null ? [] : (seenLatest?.items ?? []).filter((m) => m.seq < first);
            if (slid.length > 0) {
                setOlder((o) => [...o.filter((m) => m.seq < slid[0]!.seq), ...slid]);
                if (older.length === 0) setOlderMore(seenLatest?.has_more_before ?? false);
            }
        }
        setSeenLatest(latest.data);
    }
    const latestFirst = latest.data?.items[0]?.seq ?? Number.MAX_SAFE_INTEGER;
    const messages = [...older.filter((m) => m.seq < latestFirst), ...(latest.data?.items ?? [])];
    const answeredTurns = new Set(messages.filter((m) => {
        return m.role === "assistant" && splitResponse(m.content as ResponseContent).answer.trim();
    }).map((m) => m.turn_id));
    if (partial && splitResponse(partial).answer.trim()) answeredTurns.add(partial.turn_id);
    // 앞에 붙인 페이지와 측정 높이의 위치 보정은 VirtualMessages가 같은 읽기 anchor로 처리한다.
    const loadOlder = async () => {
        const first = messages[0]?.seq;
        if (!first) return;
        const page = await api.get<MessagePage>(`/sessions/${sessionId}/messages?limit=100&before_seq=${first}`);
        if (page.timeline_revision !== latestRef.current?.timeline_revision) return;
        setOlder((o) => [...page.items, ...o]);
        setOlderMore(page.has_more_before);
    };
    const hasOlder = olderMore ?? latest.data?.has_more_before;

    // 검색 결과에서 연 메시지로 이동(UI-026): 그 메시지가 나올 때까지 이전 페이지를 읽고, 가운데로 옮겨 잠시 강조한다.
    const [focusSeq, focusDone] = useFocusRequest(sessionId);
    const [highlight, setHighlight] = useState<number | null>(null);
    const [focusMiss, setFocusMiss] = useState(false);
    const loadingOlder = useRef(false);
    useLayoutEffect(() => {
        const position = pendingPosition.current;
        if (!visible || !position || !latest.data) return;
        if (focusSeq != null || position.timelineRevision !== latest.data.timeline_revision) {
            clearPendingPosition();
            stick.current = focusSeq == null;
            if (stick.current) bottom.current?.scrollIntoView({ block: "end" });
            return;
        }
        if (messages.some((message) => message.seq === position.anchorSeq)) {
            // 실제 위치는 VirtualMessages가 행 측정과 함께 복원한다.
            return;
        } else if (hasOlder && (messages[0]?.seq ?? 0) > (position.anchorSeq ?? 0)) {
            if (!loadingOlder.current) {
                loadingOlder.current = true;
                void loadOlder().finally(() => (loadingOlder.current = false));
            }
        } else {
            clearPendingPosition();
            stick.current = true;
            bottom.current?.scrollIntoView({ block: "end" });
        }
    }, [visible, !!s, focusSeq, latest.data, messages.length]); // eslint-disable-line react-hooks/exhaustive-deps
    useEffect(() => {
        if (highlight == null) return;
        const t = setTimeout(() => setHighlight(null), 4000);
        return () => clearTimeout(t);
    }, [highlight]);
    useEffect(() => {
        if (focusSeq == null || !latest.data) return;
        if (messages.some((message) => message.seq === focusSeq)) return;
        const first = messages[0]?.seq;
        if (first != null && first > focusSeq && hasOlder) {
            if (!loadingOlder.current) {
                loadingOlder.current = true;
                void loadOlder().finally(() => (loadingOlder.current = false));
            }
        } else {
            // 지워졌거나 범위를 벗어남: 이동할 수 없음을 알린다.
            setFocusMiss(true);
            focusDone();
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [focusSeq, messages.length, latest.data]);

    const timedTurn = active ?? lastTurn;
    const pending = (calls.data ?? []).filter((c) => c.status === "pending_approval");
    // 질문 대기(RUN-014): 승인 대기와 다른 호출 상태로 구분해 따로 보여 준다.
    const questions = (calls.data ?? []).filter((c) => (c.status as string) === "awaiting_input");
    const unknown = (calls.data ?? []).filter((c) => c.status === "unknown" && !c.reviewed_at);

    const act = async (f: () => Promise<unknown>) => {
        setErr(null);
        try {
            await f();
        } catch (e) {
            setErr(e instanceof ApiError ? e.message : "요청 실패");
            session.reload();
        }
    };

    const send = async (text: string, o: SendOptions, key: string, follow?: FollowKind, attachments: string[] = []) => {
        const request = { key, requires: [...modelOptionCapabilities(o), ...(room.data ? ["bot_rooms_v1"] : [])] };
        // 내가 보낸 글과 그 답은 따라간다.
        toBottom();
        if (follow) {
            // 실행 중 추가 메시지(RUN-007): 서버가 실행 상태를 다시 확인하고, 그 사이 끝났으면 바로 새 요청으로 시작한다.
            await api.post(`/sessions/${sessionId}/followups`, { kind: follow, text, attachments, profile_id: o.profileId, model: o.model, agent_id: o.agentId, tools: o.tools, effort: o.effort ?? "auto", service_tier: o.serviceTier }, request);
            return;
        }
        if (o.mode === "save") await api.post(`/sessions/${sessionId}/messages`, { text, attachments }, { key });
        else await api.post(`/sessions/${sessionId}/turns`, { text, attachments, profile_id: o.profileId, model: o.model, agent_id: o.agentId, tools: o.tools, effort: o.effort ?? "auto", service_tier: o.serviceTier }, request);
    };

    const rewind = (m: Message) => {
        if (!s || !confirm("이 사용자 메시지와 이후 대화를 활성 이력에서 제외할까요?\n파일·Git 변경과 실행 기록은 되돌리지 않습니다.\n원문은 DB에 보관되지만 이 화면에서 자동 복원할 수 없습니다.")) return;
        void act(() => api.post(`/sessions/${sessionId}/rewind`, {
            message_id: m.id,
            expected_revision: s.revision,
            expected_last_message_seq: s.last_message_seq,
        }));
    };

    // 대화 명령(UI-024). 실패는 Composer 상태 줄에 보인다.
    const commands: RunCommand[] = [
        {
            name: "compact",
            description: "지금까지 대화를 요약해 모델 컨텍스트 줄이기",
            run: async (_a, o) => {
                if (!o.profileId) throw new Error("요약에 쓸 모델 프로필을 고르세요");
                const r = await api.post<{ compacted: boolean; reason?: string }>(`/sessions/${sessionId}/compact`, { profile_id: o.profileId });
                return r.compacted ? "대화를 압축했습니다" : r.reason ?? "압축할 내용이 없습니다";
            },
        },
        {
            name: "fork",
            args: "context|history",
            description: "지금까지를 새 대화로 분기(context: 모델 컨텍스트 계승, history: 기록만)",
            run: async (a) => {
                if (a && a !== "context" && a !== "history") throw new Error("/fork context 또는 /fork history");
                const n = await api.post<Session>(`/sessions/${sessionId}/fork`, { from_seq: session.data?.last_message_seq ?? 0, inherit_context: a !== "history" });
                open({ kind: "session", project_id: projectId, resource_id: n.id, title: n.title }, "right");
                return `분기한 대화를 열었습니다: ${n.title}`;
            },
        },
        {
            name: "new",
            args: "제목",
            description: "이 프로젝트에 새 대화 열기",
            run: async (a) => {
                const n = await api.post<Session>(`/projects/${projectId}/sessions`, { title: a || "새 대화" });
                open({ kind: "session", project_id: projectId, resource_id: n.id, title: n.title }, "right");
                return `새 대화를 열었습니다: ${n.title}`;
            },
        },
        {
            name: "help",
            description: "도움말과 단축키",
            run: () => {
                open({ kind: "settings", title: "설정" }, "right");
                return "설정에서 '도움말'을 검색하세요";
            },
        },
    ];

    if (session.error) return <GroveText as="div" display="block" type="inherit" color="error">세션을 불러올 수 없습니다: {(session.error as Error).message}</GroveText>;
    if (!s) return <GroveText as="div" display="block" type="inherit" color="secondary">불러오는 중…</GroveText>;
    const archived = !!s.archived_at;
    const blocked = archived ? "보관된 세션입니다" : unknown.length > 0 ? "결과 확인이 필요한 작업을 먼저 검토하세요" : active ? null : null;

    return (
        <Stack as="section" gap={2} xstyle={chatLayout.view} data-testid="session-view" data-session={sessionId}>
            <Workbench label="대화 도구" tools={[
                { id: "changes", label: "변경", icon: "changes", content: <ChangesPanel key={`changes:${sessionId}`} sessionId={sessionId} projectId={projectId} open={open} disabled={archived} /> },
                { id: "files", label: "파일", icon: "file", lazy: true, content: <FilesView tabId={`${tabId}:files`} projectId={projectId} /> },
                { id: "tasks", label: "작업", icon: "terminal", activity: background.data?.tasks.filter((t) => t.status === "running").length, content: <TasksPanel key={`tasks:${sessionId}`} sessionId={sessionId} disabled={archived} /> },
                { id: "goals", label: "Goal", content: <Suspense fallback={<LoadingBar label="Goal 불러오는 중…" />}>
                    <GoalsPanel sessionId={sessionId} disabled={archived} />
                </Suspense> },
                { id: "agents", label: "에이전트", activity: delegated.data?.runs.filter((r) => r.status === "running").length, content: <AgentRunsPanel sessionId={sessionId} projectId={projectId} open={open} onError={setErr} /> },
                { id: "watches", label: "원격 감시", content: <RemoteWatchesPanel key={`remote-watches:${sessionId}`} sessionId={sessionId} disabled={archived} /> },
            ]}>
            <Stack as="header" direction="horizontal" align="center" gap={2}>
                <GroveHeading level={1} color="inherit" xstyle={chatLayout.headerTitle}>
                    <ServerActionButton appearance="link" title="이름 바꾸기" onClick={() => {
                        const t = prompt("대화 이름", s.title);
                        if (t && t !== s.title) void act(() => api.patch(`/sessions/${sessionId}`, { expected_revision: s.revision, title: t }));
                    }}>
                        {s.title}
                    </ServerActionButton>
                </GroveHeading>
                {s.bot_id && <HintText data-testid="bot-chip" hint="모델·persona는 봇 설정을 따릅니다(입력창의 모델·에이전트 선택은 쓰지 않음)">봇 대화</HintText>}
                {room.data && <HintText data-testid="bot-room-chip" hint={`@{봇 이름}으로 답할 봇을 지정해요. 여러 봇을 지정하면 순서대로 답하고, 지정하지 않으면 첫 봇이 답해요. 참여: ${room.data.members.map((m) => m.name).join(", ")}`}>봇 그룹</HintText>}
                {lastTurn?.agent_id && <HintText hint="마지막 요청을 처리한 에이전트">에이전트: {lastTurn.agent_id}</HintText>}
                <ActionMenu label="대화 작업">
                <Select
                    label="워크플로우" hideLabel
                    value={s.workflow_id ?? "default"}
                    disabled={archived || !!serverBlocked}
                    disabledMessage={serverBlocked ?? undefined}
                    onChange={(value) => void act(() => api.patch(`/sessions/${sessionId}`, { expected_revision: s.revision, workflow_id: value === "default" ? null : value }))}
                    options={(workflows.data ?? []).filter((w) => w.enabled || w.id === s.workflow_id)
                        .map((w) => ({ value: w.id, label: `워크플로우: ${w.name}${!w.enabled ? " (꺼짐 · 다음 요청은 기본 워크플로우)" : ""}` }))}
                />
                <WorktreeSelect projectId={projectId} sessionId={sessionId} current={s.worktree_id} disabled={archived || !!s.active_turn || !!serverBlocked} onError={setErr} />
                {!archived && (
                    <ServerActionButton
                        variant="secondary" density="compact"
                        title="모델로 짧은 제목을 만듭니다(모델 비용 발생)"
                        onClick={() =>
                            void act(async () => {
                                const r = await api.post<{ applied: boolean; message?: string }>(`/sessions/${sessionId}/title`, {});
                                if (!r.applied) setErr(`제목을 바꾸지 않았습니다: ${r.message ?? ""}`);
                            })
                        }
                    >
                        제목 생성
                    </ServerActionButton>
                )}
                <ContextMeter sessionId={sessionId} profileId={lastTurn?.profile_id ?? null} busy={!!active || archived || !!serverBlocked} onError={setErr} />
                <ServerActionButton variant="secondary" density="compact" disabled={archived} onClick={() => {
                    const inherit = confirm("모델 컨텍스트도 이어받을까요?\n확인: 대화와 컨텍스트 계승 / 취소: 대화 기록만 표시하고 새 컨텍스트");
                    void act(async () => {
                        const n = await api.post<Session>(`/sessions/${sessionId}/fork`, { from_seq: s.last_message_seq, inherit_context: inherit });
                        open({ kind: "session", project_id: projectId, resource_id: n.id, title: n.title }, "right");
                    });
                }}>분기</ServerActionButton>
                <ServerActionButton variant="secondary" density="compact" onClick={() => void act(() => api.patch(`/sessions/${sessionId}`, { expected_revision: s.revision, archived: !archived }))}>
                    {archived ? "복원" : "보관"}
                </ServerActionButton>
                <GroveButton variant="secondary" density="compact" onClick={() => open({ kind: "settings", project_id: projectId, resource_id: `session:${sessionId}`, title: `설정 · ${s.title}` })}>
                    대화 설정
                </GroveButton>
                {archived && (
                    <ServerActionButton
                        variant="destructive" density="compact"
                        onClick={() => {
                            const t = prompt(`영구 삭제는 되돌릴 수 없습니다. 메시지·실행 기록·초안이 모두 지워집니다.\n확인하려면 대화 제목을 그대로 입력하세요: ${s.title}`);
                            if (t === null) return;
                            void act(() => api.post(`/sessions/${sessionId}/delete`, { expected_revision: s.revision, confirm_title: t }));
                        }}
                    >
                        영구 삭제
                    </ServerActionButton>
                )}
                </ActionMenu>
                <ToolsTrigger />
            </Stack>
            {s.parent_session_id && (
                <GroveText as="p" display="block" type="supporting" color="secondary">
                    분기된 대화 · {s.fork_inherits_context ? "모델 컨텍스트 계승" : "대화 기록만 표시(새 컨텍스트)"}
                </GroveText>
            )}
            {err && <GroveText as="p" display="block" type="inherit" color="error" role="alert">{err}</GroveText>}
            {focusMiss && <GroveText as="p" display="block" type="supporting" color="secondary" role="status">찾은 메시지가 더 이상 없습니다(삭제·되감기되었을 수 있습니다).</GroveText>}
            {latest.data?.rewind_boundary_seq != null && (
                <GroveText as="p" display="block" type="supporting" color="secondary" data-testid="rewind-limit">
                    seq {latest.data.rewind_boundary_seq}까지 되감기 불가 · 파일·Git 변경은 별도
                    <HelpTip label="대화 되감기 도움말">압축 구간 이후 사용자 메시지 직전으로만 되감기할 수 있습니다.</HelpTip>
                </GroveText>
            )}
            <Stack gap={4} width="100%" maxWidth="48em" xstyle={chatLayout.messages} aria-live="polite" data-session-msgs={sessionId} ref={msgsRef}>
                {hasOlder && <GroveButton variant="secondary" onClick={loadOlder}>이전 메시지</GroveButton>}
                <FileRefContext.Provider
                    value={(path, line) => open({ kind: "file", project_id: projectId, resource_id: path, filePath: path, fileLine: line, title: line ? `${path}:${line}` : path }, "right")}
                >
                    <VirtualMessages key={`${tabId}:${latest.data?.timeline_revision ?? 0}`} messages={messages}
                        targetSeq={focusSeq ?? pendingPosition.current?.anchorSeq ?? null} presentationKey={JSON.stringify(prefs)}
                        onTargetReached={(seq) => {
                            if (focusSeq == null) return;
                            setHighlight(seq);
                            setFocusMiss(false);
                            focusDone();
                        }}
                        restorePosition={focusSeq == null && pendingPosition.current?.timelineRevision === latest.data?.timeline_revision ? pendingPosition.current : null}
                        onRestored={() => {
                            const position = pendingPosition.current;
                            clearPendingPosition();
                            setUnseen(!!position && (latest.data?.items.at(-1)?.seq ?? 0) > position.lastSeq || !!partial?.text);
                            capturePosition();
                        }}
                        stick={stick} bottom={bottom} onNavigate={() => { clearPendingPosition(); stick.current = false; }}
                        render={(m) => (
                        <Stack gap={0} key={m.id} xstyle={highlight === m.seq && chatLayout.focusHit} data-seq={m.seq} data-highlighted={highlight === m.seq}>
                            <MessageView m={m} prefs={prefs} assistantName={assistantName} assistantImage={assistantImage}
                                answered={!!m.turn_id && answeredTurns.has(m.turn_id)} />
                            {m.role === "user" && (
                                <Stack direction="horizontal" align="center" gap={1} xstyle={chatLayout.actions}>
                                <When at={m.created_at} absolute part="time" titlePart="datetime" />
                                {!!(m.content as { text?: string }).text && <CopyButton text={(m.content as { text: string }).text} />}
                                <ActionMenu label="메시지 작업">
                                <ServerActionButton
                                    variant="secondary" density="compact"
                                    aria-label="이 메시지 이전으로 되감기"
                                    disabled={archived || !!active || m.seq <= (latest.data?.rewind_boundary_seq ?? 0)}
                                    onClick={() => rewind(m)}
                                >이전으로 되감기</ServerActionButton>
                                </ActionMenu>
                                </Stack>
                            )}
                        </Stack>
                    )} />
                </FileRefContext.Provider>
                {partial && partial.text !== undefined && (
                    <ChatMessage sender="assistant" density="compact" data-testid="partial"
                        name={<><AssistantIdentity name={assistantName} imageUrl={assistantImage} /> {partial.text?.trim() ? "응답 중…" : partial.reasoning ? "추론 중…" : "작업 중…"}</>}>
                        <AssistantResponse content={partial} mode={prefs.reasoning} live answered={answeredTurns.has(partial.turn_id)} />
                        {partial.tool_calls?.length > 0 && <GroveText as="div" display="block" type="supporting" color="secondary">도구 호출 준비: {partial.tool_calls.join(", ")}</GroveText>}
                    </ChatMessage>
                )}
                <Stack gap={0} ref={bottom} />
            </Stack>
            {unseen && (
                <GroveButton xstyle={chatLayout.below} data-testid="new-below" onClick={toBottom}>
                    새 메시지 ↓
                </GroveButton>
            )}
            {questions.map((c) => <QuestionCard key={c.id} c={c} act={act} />)}
            {pending.map((c) => <ApprovalCard key={c.id} call={c} {...currentApprovalContract(c.name)}
                blockedReason={serverBlocked}
                onDecision={async (r) => {
                    const result = await api.post<ToolCallRow>(`/tool-calls/${r.id}/decision`, { decision: r.decision, expected_revision: r.revision });
                    calls.reload();
                    return result;
                }}
                onRefresh={async (r) => {
                    await api.get<ToolCallRow>(`/tool-calls/${r.id}`);
                    calls.reload();
                }}
            />)}
            {unknown.map((c) => <UnknownCard key={c.id} c={c} act={act} />)}
            <Stack gap={1} xstyle={chatLayout.surface} data-testid="compose-surface">
            {active && (
                <Stack direction="horizontal" align="center" wrap="wrap" gap={2} role="status" data-testid="turn-status">
                    {active.status === "awaiting_approval"
                        ? questions.length > 0 && pending.length > 0
                            ? "승인과 답변을 기다리는 중"
                            : questions.length > 0
                              ? "답변을 기다리는 중"
                              : "승인을 기다리는 중"
                        : active.queue
                          ? queueText(active.queue)
                          : active.status === "queued"
                            ? "대기 중"
                            : "실행 중"}
                    <TurnTiming sessionId={sessionId} turn={active} messagesReady={false} />
                    <DetailDialog label="실행 설정" title="실행 설정" showExpand={false} trigger={<Icon name="help" size={14} />}>
                        <ActiveSettings turn={active} workflows={workflows.data ?? []} />
                    </DetailDialog>
                    <ServerActionButton variant="secondary" density="compact" onClick={() => void act(() => api.post(`/turns/${active.id}/cancel`))}>취소</ServerActionButton>
                </Stack>
            )}
            {!active && lastTurn && ["failed", "interrupted"].includes(lastTurn.status) && !lastTurn.acknowledged_at && (
                <Stack direction="horizontal" align="center" wrap="wrap" gap={2} role="alert" data-testid="turn-ended">
                    마지막 요청이 {lastTurn.status === "failed" ? "실패" : "중단"}했습니다: {(lastTurn.error as { message?: string })?.message ?? ""}
                    <GroveText type="supporting" color="secondary"> (자동으로 다시 실행하지 않습니다)</GroveText>
                    {(lastTurn.error as { scope?: EndScopeData })?.scope && <EndScope s={(lastTurn.error as { scope: EndScopeData }).scope} />}
                    {lastTurn.evidence && <TurnEvidence e={lastTurn.evidence} />}
                    {/* RUN-019: 다시 실행(같은 글·설정)·새 요청 쓰기·포기(배너 닫기, 모든 기기) */}
                    <Stack direction="horizontal" align="center" gap={1.5}>
                        <ServerActionButton variant="secondary" density="compact" disabled={archived} onClick={() => void act(() => api.post(`/turns/${lastTurn.id}/retry`))}>
                            다시 실행
                        </ServerActionButton>
                        <GroveButton
                            variant="secondary" density="compact"
                            onClick={() => (document.querySelector(`[data-session="${sessionId}"] textarea[aria-label="메시지 입력"]`) as HTMLTextAreaElement | null)?.focus()}
                        >
                            새 요청 쓰기
                        </GroveButton>
                        <ServerActionButton variant="secondary" density="compact" onClick={() => void act(() => api.post(`/turns/${lastTurn.id}/acknowledge`))}>
                            닫기(포기)
                        </ServerActionButton>
                    </Stack>
                </Stack>
            )}
            {!active && lastTurn?.status === "cancelled" && lastTurn.evidence && "cli_execution_attempted" in lastTurn.evidence
                && !!lastTurn.evidence.cli_execution_attempted && <TurnEvidence e={lastTurn.evidence} />}
            {!active && timedTurn && <TurnTiming sessionId={sessionId} turn={timedTurn}
                messagesReady={latest.data?.items.some((m) => m.turn_id === timedTurn.id && m.created_at === timedTurn.finished_at) ?? false} />}
            <BudgetNote sessionId={sessionId} active={active} />
            <FollowupsPanel sessionId={sessionId} running={!!active} onError={setErr} />
            <Composer projectId={s.project_id} resourceKey={`session:${sessionId}`} copyId={tabId} onSend={send} running={!!active} disabled={blocked} commands={commands}
                boundProfileId={room.data ? room.data.members.find((m) => m.profile_id)?.profile_id ?? null : s.bot_id ? bots.data?.bots.find((bot) => bot.id === s.bot_id)?.profile_id ?? null : undefined} />
            </Stack>
            </Workbench>
        </Stack>
    );
}

/// 확정되지 않은 응답의 중단 증거(REC-010). 답변 목록과 분리해 표시하고 모델 입력에는 쓰지 않는다.
function TurnEvidence({ e }: { e: NonNullable<Turn["evidence"]> }) {
    if ("corrupt" in e) {
        return (
            <GroveText as="p" display="block" type="supporting" color="inherit" data-testid="turn-evidence">
                손상된 중단 시점 기록({e.kind})은 표시할 수 없으며 원본은 보존합니다.
            </GroveText>
        );
    }
    return (
        <DetailDialog data-testid="turn-evidence" label="중단 전 응답" title={<>
                {e.cli_execution_attempted ? "CLI 작업 중단 · 변경 여부 확인 필요" : "중단 전까지 받은 응답"}(확정되지 않음 · {e.text_chars}자{e.truncated ? ", 앞부분만 보존" : ""}
                {e.tool_calls.length > 0 ? ` · 계획 중이던 도구 ${e.tool_calls.join(", ")}(실행 안 함)` : ""})
            </>}>
            <CodeBlock code={e.text} maxHeight="12em" />
            {e.cli_execution_attempted && <GroveText as="p" display="block" type="supporting" color="warning">
                {e.cli_activity_count ? `CLI 도구 활동 ${e.cli_activity_count}건을 받았어요.` : "CLI 도구 활동 보고 전에 중단됐을 수 있어요."}
                {" "}중단해도 이미 바뀐 파일은 되돌아가지 않아요.
                다시 실행하기 전에 파일과 diff를 확인하세요.
            </GroveText>}
            {e.cli_activity?.map((item, index) => <GroveText key={index} display="block" type="supporting" color="secondary">
                {item.name} · {item.status ?? "결과 미확인"}
            </GroveText>)}
        </DetailDialog>
    );
}

const MessageView = memo(function MessageView({ m, prefs, assistantName, assistantImage, answered }: { m: Message; prefs: Prefs; assistantName: string; assistantImage: string | null; answered: boolean }) {
    const replyingBot = (m.content as { bot?: { name?: string } }).bot;
    if (replyingBot?.name) { assistantName = replyingBot.name; assistantImage = null; }
    const nt0 = (m.content as { type?: string }).type;
    // 답만 보기: 도구 결과·CLI 도구 활동과 글 없는 도구 호출 메시지를 숨긴다(승인 카드는 별도로 항상 표시).
    if (prefs.answerOnly && (m.role === "tool" || (m.role === "note" && nt0 === "cli_activity"))) return null;
    if (prefs.answerOnly && m.role === "assistant" && !(m.content as { text?: string }).text) return null;
    const c = m.content as Omit<ResponseContent, "tool_calls"> & { attachments?: Attachment[]; tool_calls?: { id: string; name: string }[]; name?: string; status?: string; output?: unknown; model?: string; approval_scope?: string | null; args?: unknown; duration_ms?: number | null; truncated?: boolean };
    if (m.role === "note" && (nt0 === "bot_room_next" || nt0 === "bot_room_stopped")) {
        return <GroveText as="div" display="block" type="supporting" color={nt0 === "bot_room_stopped" ? "warning" : "secondary"}
            role={nt0 === "bot_room_stopped" ? "alert" : undefined}>{c.text}</GroveText>;
    }
    if (m.role === "note" && nt0 === "model_fallback") {
        const r = m.content as {
            original_profile_id: string; reason: string; status: number;
            from: { name: string; model: string }; to: { name: string; model: string; base_url: string };
        };
        return <DetailDialog surface="orange" data-testid="msg-model-fallback" label="모델 전환 기록"
            title={<>모델 fallback · {r.from.name} ({r.from.model}) → {r.to.name} ({r.to.model}) · HTTP {r.status}</>}>
            <GroveText as="p" display="block" type="inherit" color="inherit">이후 호출 대상: {r.to.base_url} · {r.to.model}</GroveText>
            <GroveText as="p" display="block" type="inherit" color="inherit">원래 선택: {r.original_profile_id} · 전환 이유: {r.reason} · 동일 모델 재시도 뒤 첫 응답 전에 확인한 순서로 전환했습니다.</GroveText>
        </DetailDialog>;
    }
    if (m.role === "note" && nt0 === "completion_deferred") {
        const work = (m.content as { pending_work: { tasks: { id: string }[]; agents: { id: string }[] } }).pending_work;
        return <GroveText as="div" display="block" type="supporting" color="warning" role="status" data-testid="msg-completion-deferred">
            이 응답 시점에는 소유 작업 결과 반영 전이라 완료를 보류했습니다(진행 중: 백그라운드 {work.tasks.length}개 · 자식 {work.agents.length}개).
            결과를 받은 뒤 모델이 이어서 답합니다. 실행 상태와 결과는 작업·자식 목록에서 확인할 수 있습니다.
        </GroveText>;
    }
    if (m.role === "note" && nt0 === "remote_watch_result") {
        const r = m.content as { title: string; status: string; remote_value: string | null };
        const word: Record<string, string> = { succeeded: "원격 성공", failed: "원격 실패", timed_out: "감시 시간 초과(결과 불명)", stopped: "감시 중단" };
        return <GroveText as="div" display="block" type="supporting" color="secondary" data-testid="msg-remote-watch">원격 작업 {r.title}: {word[r.status] ?? r.status}{r.remote_value ? ` · 원격 상태 ${r.remote_value}` : ""}</GroveText>;
    }
    if (m.role === "note" && nt0 === "rewind") {
        const r = m.content as { text: string; removed_count: number };
        return <GroveText as="div" display="block" type="supporting" color="secondary" data-testid="msg-rewind">{r.text} 활성 이력에서 {r.removed_count}개를 제외했습니다. 원문은 보관되며 자동 복원 UI는 없습니다.</GroveText>;
    }
    if (m.role === "note" && nt0 === "turn_ended") {
        const r = m.content as {
            status: string;
            error: {
                code: string; message: string; at?: string; last_progress_at?: string;
                budget?: { max_tokens?: number; max_minutes?: number; max_cost_cents?: number; currency?: string };
                settings?: { provider_timeout_secs?: number };
                scope?: EndScopeData;
            };
        };
        const e = r.error;
        return (
            <DetailDialog surface="orange" data-testid="msg-turn-ended" label="요청 종료 기록"
                title={<>요청 종료 · {e.message} (<code>{e.code}</code>)</>}>
                <GroveText as="p" display="block" type="inherit" color="inherit">상태: {r.status}</GroveText>
                {e.at && <GroveText as="p" display="block" type="inherit" color="inherit">발생 시각: <time dateTime={e.at}>{e.at}</time></GroveText>}
                {e.last_progress_at && <GroveText as="p" display="block" type="inherit" color="inherit">마지막 진행: <time dateTime={e.last_progress_at}>{e.last_progress_at}</time></GroveText>}
                {e.budget && (
                    <GroveText as="p" display="block" type="inherit" color="inherit">
                        적용 예산:
                        {e.budget.max_tokens != null && ` ${e.budget.max_tokens} tokens`}
                        {e.budget.max_minutes != null && ` ${e.budget.max_minutes}분`}
                        {e.budget.max_cost_cents != null && ` ${e.budget.max_cost_cents / 100} ${e.budget.currency ?? "USD"}`}
                    </GroveText>
                )}
                {e.settings?.provider_timeout_secs != null && <GroveText as="p" display="block" type="inherit" color="inherit">provider timeout: {e.settings.provider_timeout_secs}초</GroveText>}
                {e.scope && <EndScope s={e.scope} />}
            </DetailDialog>
        );
    }
    if (m.role === "note" && (m.content as { type?: string }).type === "context_clear") {
        const r = m.content as { idle_minutes: number };
        return <GroveText as="div" display="block" type="supporting" color="secondary" role="status" data-testid="msg-context-clear">
            idle {r.idle_minutes}분 이상 뒤 모델 context를 초기화했어요. 이전 대화는 요약 없이 모델 입력에서 제외했으며 화면 이력·파일은 남아 있어요.
        </GroveText>;
    }
    if (m.role === "note" && (m.content as { type?: string }).type === "compaction") {
        return <CompactionDetails sessionId={m.session_id} record={m.content as CompactionRecord} />;
    }
    if (m.role === "note" && (m.content as { type?: string }).type === "compaction_failed") {
        const r = m.content as { error?: { message?: string } };
        return <GroveText as="div" display="block" type="supporting" color="warning" role="status">자동 압축 실패(적용하지 않음, 대화는 원문 그대로 진행): {r.error?.message}</GroveText>;
    }
    if (m.role === "note" && (m.content as { type?: string }).type === "compaction_paused") {
        const r = m.content as { failures: number; limit: number };
        return <GroveText as="div" display="block" type="supporting" color="warning" role="status" data-testid="msg-compaction-paused">자동 압축이 연속 {r.failures}번 실패해 이 대화의 자동 압축을 멈췄습니다(한도 {r.limit}). 수동 압축이 성공하면 다시 시도합니다.</GroveText>;
    }
    if (m.role === "note" && (m.content as { type?: string }).type === "agent_result") {
        const r = m.content as { agent_id: string; status: string; text: string; truncated: boolean; error?: { message?: string } | null };
        return (
            <DetailDialog surface="muted" data-testid="msg-agent-result" label="자식 에이전트 결과" inline title={<>
                    자식 에이전트 <code>{r.agent_id}</code> · {r.status}
                    {r.error?.message ? ` · ${r.error.message}` : ""}
                </>}>
                {r.text && <GroveText as="div" display="block" type="inherit" color="inherit" xstyle={contentStyles.plainText}>{r.text}</GroveText>}
                {r.truncated && <GroveText as="p" display="block" type="supporting" color="secondary">일부만 표시합니다. 전체는 자식 대화에서 보세요.</GroveText>}
            </DetailDialog>
        );
    }
    if (m.role === "note" && (m.content as { type?: string }).type === "task_result") {
        const r = m.content as { command: string; status: string; exit_code: number | null; reason: string | null; stdout_tail: string; stderr_tail: string; truncated: boolean; log_errors?: unknown[] };
        return (
            <DetailDialog surface="muted" data-testid="msg-task-result" label="백그라운드 작업 결과" title={<>
                    백그라운드 작업 <code>{r.command}</code> · {r.status}
                    {r.exit_code !== null ? ` (코드 ${r.exit_code})` : ""} {r.reason ? `· ${r.reason}` : ""}
                </>}>
                {r.stdout_tail && <CodeBlock code={r.stdout_tail} />}
                {r.stderr_tail && <GroveText as="div" display="block" color="error"><pre>{r.stderr_tail}</pre></GroveText>}
                {!!r.log_errors?.length && <GroveText as="p" display="block" type="inherit" color="error" role="alert">로그 저장에 실패했습니다. 출력이 누락됐을 수 있습니다.</GroveText>}
                {r.truncated && <GroveText as="p" display="block" type="supporting" color="secondary">끝부분만 표시합니다. 전체 출력은 백그라운드 작업 목록에서 보세요.</GroveText>}
            </DetailDialog>
        );
    }
    const nt = (m.content as { type?: string }).type;
    if (m.role === "note" && nt === "cli_activity") {
        const r = m.content as { items: CliActivity[] };
        return (
            <DetailDialog surface="muted" data-testid="msg-cli-activity" label="CLI 도구 활동" inline={prefs.expandTools}
                title={cliActivitySummary(r.items)}>
                <pre>{JSON.stringify(r.items, null, 2).slice(0, 20000)}</pre>
            </DetailDialog>
        );
    }
    if (m.role === "tool") {
        return (
            <DetailDialog surface="muted" data-testid="msg-tool" label="도구 실행 세부" inline={prefs.expandTools} title={<>
                    도구 {c.name} · <StatusBadge status={c.status}>{c.status}</StatusBadge>
                    {c.approval_scope && (
                        <GroveText type="supporting" color="secondary" data-testid="approval-scope">
                            {" "}· {c.approval_scope === "once" ? "이번만 승인" : c.approval_scope === "session" ? "이 대화에서 허용됨" : "정책(tools.allow)으로 허용"}
                        </GroveText>
                    )}
                    {typeof c.duration_ms === "number" && <GroveText type="supporting" color="secondary" data-testid="tool-duration"> · {fmtDuration(c.duration_ms)}</GroveText>}
                    {c.truncated && <GroveText type="supporting" color="secondary" data-testid="tool-truncated"> · 결과 일부만(잘림)</GroveText>}
                </>}>
                {c.args !== undefined && (
                    <>
                        <GroveText as="div" display="block" type="supporting" color="secondary">인자</GroveText>
                        <pre data-testid="tool-args">{JSON.stringify(c.args, null, 2)?.slice(0, 20000)}</pre>
                    </>
                )}
                <GroveText as="div" display="block" type="supporting" color="secondary">{c.status === "succeeded" ? "결과" : "결과·오류"}</GroveText>
                <pre data-testid="tool-output">{JSON.stringify(c.output, null, 2)?.slice(0, 20000)}</pre>
            </DetailDialog>
        );
    }
    if (m.role === "user") {
        const source = (c as { source?: { kind?: string; name?: string } }).source;
        const origin = source?.kind === "agent_run" ? "부모 에이전트의 지시" : source?.kind === "schedule" ? `예약 '${source.name ?? ""}' 실행` : null;
        return <ChatMessage sender="user" density="compact" data-testid="msg-user">
            <ChatMessageBubble>
                {origin && <GroveText as="div" display="block" type="supporting" color="secondary" data-testid="msg-who">{origin}</GroveText>}
                {c.text && <GroveText as="div" display="block" type="inherit" color="inherit" xstyle={contentStyles.plainText}>{c.text}</GroveText>}
                {Array.isArray(c.attachments) && c.attachments.length > 0 && <AttachmentList attachments={c.attachments as Attachment[]} />}
            </ChatMessageBubble>
        </ChatMessage>;
    }
    return (
        <ChatMessage sender={m.role === "assistant" ? "assistant" : "system"} density="compact" data-testid={`msg-${m.role}`}
            name={<GroveText type="inherit" color="secondary" data-testid="msg-who">
                {m.role === "assistant"
                      ? <><AssistantIdentity name={assistantName} imageUrl={assistantImage} />{` 모델${c.model ? " · " + c.model : ""}${(m.content as { pending_work?: unknown }).pending_work ? " · 중간 응답(소유 작업 결과 반영 전)" : ""}`}</>
                      : m.role}
            </GroveText>}>
            {m.role === "assistant" ? <AssistantResponse content={c} mode={prefs.reasoning} answered={answered} />
                : c.text && <GroveText as="div" display="block" type="inherit" color="inherit" xstyle={contentStyles.plainText}>{c.text}</GroveText>}
            {c.text && <Stack direction="horizontal" align="center" gap={2}>
                <CopyButton text={m.role === "assistant" ? splitResponse(c).answer || c.text : c.text} />
                {m.role === "assistant" && <When at={m.created_at} absolute part="time" titlePart="datetime" />}
            </Stack>}
            {Array.isArray(c.attachments) && c.attachments.length > 0 && <AttachmentList attachments={c.attachments as Attachment[]} />}
            {c.tool_calls && c.tool_calls.length > 0 && <GroveText as="div" display="block" type="supporting" color="secondary">도구 호출: {c.tool_calls.map((t) => t.name).join(", ")}</GroveText>}
        </ChatMessage>
    );
});

type EndScopeData = { steps: number; tool_calls: Record<string, number>; running_tasks: { id: string; command: string }[]; running_agents?: { id: string; agent_id: string; child_session_id: string }[] };

// tool_calls.status 값(store.rs CHECK 제약)과 같은 이름.
const CALL_STATUS: Record<string, string> = {
    succeeded: "완료",
    failed: "실패",
    cancelled: "실행 안 함·취소",
    denied: "거부",
    expired: "승인 만료",
    unknown: "결과 불명",
    running: "실행 중(결과 미확정)",
    approved: "승인됨(실행 전)",
    pending_approval: "승인 대기",
    awaiting_input: "답변 대기",
};

/// 중단 시점의 미완료 범위와 다음 조치(RUN-024). 서버가 기록한 값이라 새로고침·다른 기기에서도 같다.
function EndScope({ s }: { s: EndScopeData }) {
    const calls = Object.entries(s.tool_calls ?? {});
    const unknown = (s.tool_calls?.unknown ?? 0) + (s.tool_calls?.running ?? 0);
    const tasks = s.running_tasks ?? [];
    return (
        <GroveText as="div" display="block" type="supporting" color="inherit" data-testid="end-scope">
            <GroveText as="p" display="block" type="inherit" color="inherit">
                진행 범위: 모델 응답 {s.steps}단계 · 최종 답변 없음
                {calls.length > 0 ? ` · 도구 ${calls.map(([k, n]) => `${CALL_STATUS[k] ?? k} ${n}`).join(", ")}` : " · 도구 호출 없음"}
            </GroveText>
            {tasks.length > 0 && (
                <GroveText as="p" display="block" type="inherit" color="inherit">
                    계속 실행 중인 백그라운드 작업 {tasks.length}개: {tasks.map((t) => <code key={t.id}>{t.command}</code>)} — 작업 목록에서 확인·취소할 수 있습니다
                </GroveText>
            )}
            {!!s.running_agents?.length && <GroveText as="p" display="block" type="inherit" color="inherit">미완료 자식 작업 {s.running_agents.length}개: {s.running_agents.map((a) => <code key={a.id}>{a.agent_id} </code>)} — 자식 목록에서 확인할 수 있습니다</GroveText>}
            <GroveText as="p" display="block" type="inherit" color="inherit">
                다음 조치: {unknown > 0 ? "결과가 확정되지 않은 작업을 먼저 확인하세요. " : ""}같은 요청 다시 실행 · 새 요청 쓰기 · 닫기(포기)
            </GroveText>
        </GroveText>
    );
}

function UnknownCard({ c, act }: { c: ToolCallRow; act: (f: () => Promise<unknown>) => Promise<void> }) {
    const [obs, setObs] = useState<{ fingerprint: string; revision: number; observation: unknown } | null>(null);
    const [outcome, setOutcome] = useState("unsure");
    return (
        <Card variant="red" padding={2} role="group" aria-label="결과 확인 필요" data-testid="unknown"><Stack gap={2}>
            <GroveText as="div" display="block" type="inherit" color="inherit">
                <strong>{c.name}</strong>의 결과를 알 수 없습니다. 자동으로 다시 실행하지 않습니다.
            </GroveText>
            {(c.result as {error?:{message?:string}}|null)?.error?.message && <GroveText as="p" display="block" type="supporting" color="inherit">{(c.result as {error:{message:string}}).error.message}</GroveText>}
            <GroveText as="div" display="block" type="inherit" color="inherit">대상: <code>{JSON.stringify(c.target).slice(0, 300)}</code></GroveText>
            <GroveButton variant="secondary" density="compact" onClick={() => void act(async () => setObs(await api.get(`/tool-calls/${c.id}/observe`)))}>현재 상태 확인</GroveButton>
            {obs && (
                <>
                    <pre>{JSON.stringify(obs.observation, null, 2)}</pre>
                    <Select label="확인 결과" value={outcome} onChange={setOutcome}
                        options={[{ value: "applied", label: "적용됨" }, { value: "not_applied", label: "적용 안 됨" },
                            { value: "partial", label: "일부 적용" }, { value: "unsure", label: "모르겠음" }]} />
                    <ServerActionButton onClick={() => void act(async () => {
                        await api.post(`/tool-calls/${c.id}/review`, { expected_revision: obs.revision, fingerprint: obs.fingerprint, outcome });
                        setObs(null);
                    })}>검토 기록</ServerActionButton>
                </>
            )}
        </Stack></Card>
    );
}

function fmtDuration(ms: number): string {
    return ms < 1000 ? `${ms}ms` : ms < 60_000 ? `${(ms / 1000).toFixed(1)}초` : `${Math.floor(ms / 60_000)}분 ${Math.round((ms % 60_000) / 1000)}초`;
}

type Followup = { attachments?: Attachment[]; id: string; kind: FollowKind; text: string; created_at: string; last_error?: { code: string; message: string } | null };
const FOLLOW_KIND: Record<FollowKind, string> = { queue: "대기", steer: "반영 예정", interrupt: "끼어들기" };

/// 실행 중 보낸 추가 메시지(UI-021). 실행 중이면 순서대로 기다리고, 실패·취소로 멈추면 직접 시작하거나 지운다.
function FollowupsPanel({ sessionId, running, onError }: { sessionId: string; running: boolean; onError: (m: string) => void }) {
    const q = useQuery<{ items: Followup[] }>(`followups:${sessionId}`, () => api.get(`/sessions/${sessionId}/followups`));
    const items = q.data?.items ?? [];
    if (items.length === 0) return null;
    const run = async (f: () => Promise<unknown>) => {
        try {
            await f();
        } catch (e) {
            onError(e instanceof ApiError ? e.message : "처리하지 못했습니다");
        }
        q.reload();
    };
    return (
        <Card variant="muted" padding={2} data-testid="followups" role="region" aria-label="대기 중인 메시지"><Stack gap={2}>
            <GroveText as="div" display="block" type="supporting" color="secondary">
                {running ? "실행이 끝나면 순서대로 보냅니다" : "이전 실행이 완료되지 않아 멈췄습니다. 직접 시작하거나 지우세요"}
            </GroveText>
            <GroveList density="compact" edge="flush" listStyle="decimal">
                {items.map((f, i) => (
                    <GroveListItem key={f.id} data-testid="followup" label={<>
                        <StatusBadge>{FOLLOW_KIND[f.kind]}</StatusBadge>
                        <GroveText type="inherit" color="inherit" xstyle={contentStyles.plainText}>{f.text.length > 120 ? `${f.text.slice(0, 120)}…` : f.text}</GroveText>
                        {!!f.attachments?.length && <AttachmentList attachments={f.attachments} />}
                        {f.last_error && <GroveText type="supporting" color="error"> · {f.last_error.message}</GroveText>}
                        {!running && i === 0 && (
                            <ServerActionButton variant="secondary" density="compact" onClick={() => void run(() => api.post(`/sessions/${sessionId}/followups/${f.id}/start`))}>
                                지금 시작
                            </ServerActionButton>
                        )}
                        <ServerActionButton variant="secondary" density="compact" aria-label={`대기 메시지 삭제: ${f.text.slice(0, 20)}`} onClick={() => void run(() => api.del(`/sessions/${sessionId}/followups/${f.id}`))}>
                            삭제
                        </ServerActionButton>
                    </>} />
                ))}
            </GroveList>
        </Stack></Card>
    );
}

type Question = { question: string; options: { label: string; description?: string }[]; multi_select: boolean; allow_free_text: boolean };

/// 모델의 질문(UI-016): 단일·복수 선택, 직접 입력, 닫기. 보낸 값은 서버가 질문의 선택지로 다시 검증한다.
function QuestionCard({ c, act }: { c: ToolCallRow; act: (f: () => Promise<unknown>) => Promise<void> }) {
    const q = c.target as Question;
    const [picked, setPicked] = useState<string[]>([]);
    const [text, setText] = useState("");
    const canSend = picked.length > 0 || (q.allow_free_text && text.trim().length > 0);
    const send = (body: Record<string, unknown>) => act(() => api.post(`/tool-calls/${c.id}/answer`, { expected_revision: c.revision, ...body }));
    return (
        <Card variant="orange" padding={2}><Stack as="form" gap={2}
            aria-label="모델의 질문"
            data-testid="question"
            onSubmit={(e) => {
                e.preventDefault();
                if (canSend) void send({ choices: picked, text: q.allow_free_text && text.trim() ? text : null });
            }}
        >
            <fieldset>
                <legend>
                    <strong>질문</strong> {q.question}
                    <GroveText type="supporting" color="secondary"> · {q.multi_select ? "여러 개 선택 가능" : q.options.length > 0 ? "하나 선택" : "직접 입력"}</GroveText>
                </legend>
                {q.options.length > 0 && Array.from({ length: q.multi_select ? Math.min(picked.length + 1, q.options.length) : 1 }, (_, index) => (
                    <Select key={index} label={q.multi_select ? `선택 ${index + 1}` : "답변 선택"} value={picked[index] ?? ""}
                            onChange={(value) => setPicked((previous) => {
                                const next = [...previous];
                                next[index] = value;
                                return next.filter(Boolean);
                            })}
                            options={[{ value: "", label: "선택 안 함" }, ...q.options.map((option) => ({
                                value: option.label, label: option.label, description: option.description,
                                disabled: picked.includes(option.label) && picked[index] !== option.label,
                            }))]} />
                ))}
                {q.allow_free_text && (
                    <TextArea label={q.options.length > 0 ? "직접 입력(선택)" : "답"} aria-label="직접 입력"
                        rows={2} value={text} onChange={setText} />
                )}
            </fieldset>
            <Stack direction="horizontal" align="center" gap={1.5}>
                <ServerActionButton type="submit" disabled={!canSend}>
                    답하기
                </ServerActionButton>
                <ServerActionButton type="button" variant="secondary" onClick={() => void send({ cancel: true })}>
                    답하지 않고 닫기
                </ServerActionButton>
            </Stack>
        </Stack></Card>
    );
}

type Eff = { items: { key: string; effective: unknown; source: string }[] };
const SOURCE: Record<string, string> = { session: "이 대화", project: "프로젝트", server: "서버", default: "기본" };

/// 사용자가 정한 예산(RUN-021). 실행 전에는 다음 요청에 적용될 값과 출처를, 실행 중에는 접수 때 고정된 값·기준 시각·남은 시간·사용량을 보인다.
/// 예산이 없으면(기본) 아무것도 표시하지 않는다: 정상 진행을 시간으로 끊지 않는다.
function BudgetNote({ sessionId, active }: { sessionId: string; active?: Turn }) {
    const eff = useQuery<Eff>(`settings:effective:session:${sessionId}`, () => api.get(`/settings/effective?session_id=${sessionId}`));
    const [now, setNow] = useState(Date.now());
    const fixed = (active as unknown as { definition?: { budget?: { max_tokens?: number; max_minutes?: number; max_cost_cents?: number; currency?: string } } } | undefined)?.definition?.budget;
    useEffect(() => {
        if (!fixed?.max_minutes) return;
        const t = setInterval(() => setNow(Date.now()), 1000);
        return () => clearInterval(t);
    }, [fixed?.max_minutes]);
    if (active) {
        if (!fixed) return null;
        const base = new Date(active.created_at).getTime();
        const usage = (active.usage ?? {}) as { input_tokens?: number; output_tokens?: number };
        const used = (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0);
        const left = fixed.max_minutes ? Math.max(0, Math.round((base + fixed.max_minutes * 60_000 - now) / 1000)) : null;
        return (
            <GroveText as="p" display="block" type="supporting" color="secondary" role="status" data-testid="budget-live">
                예산(접수 시 고정):
                {fixed.max_minutes && (
                    <>
                        {" "}시간 {fixed.max_minutes}분 · <When at={active.created_at} absolute part="time" /> 시작 기준 · 남은 {Math.floor(left! / 60)}분 {left! % 60}초
                    </>
                )}
                {fixed.max_tokens && <> · token {fixed.max_tokens} 중 {used} 사용</>}
                {fixed.max_cost_cents && <> · 추정 비용 {(fixed.max_cost_cents / 100).toFixed(2)} {fixed.currency ?? "USD"} 이내</>} · 넘으면 남은 작업을 멈춥니다
            </GroveText>
        );
    }
    const get = (k: string) => eff.data?.items.find((i) => i.key === k);
    const mins = get("runs.budget.max_minutes");
    const toks = get("runs.budget.max_tokens");
    const cost = get("runs.budget.max_cost_cents");
    const m = Number(mins?.effective ?? 0);
    const t = Number(toks?.effective ?? 0);
    const c = Number(cost?.effective ?? 0);
    if (!m && !t && !c) return null;
    return (
        <GroveText as="p" display="block" type="supporting" color="secondary" data-testid="budget-next">
            다음 요청 예산:
            {m > 0 && <> 시간 {m}분(시작부터, 승인·답변 대기 포함 · {SOURCE[mins!.source] ?? mins!.source} 설정)</>}
            {t > 0 && <> · token {t}({SOURCE[toks!.source] ?? toks!.source} 설정)</>}
            {c > 0 && <> · 추정 비용 {(c / 100).toFixed(2)}(프로필 가격표 통화, {SOURCE[cost!.source] ?? cost!.source} 설정)</>} · 넘으면 남은 작업을 멈춥니다
        </GroveText>
    );
}

/// 요청한 강도와 provider에 실제로 보낸 값을 구분한다(EFF-009). 보내지 않은 값은 적용된 것처럼 쓰지 않는다.
export function effortApplied(a: { field: string | null; value: string | number | null } | undefined): string {
    if (!a) return "";
    if (!a.field) return "(보내지 않음: 모델 기본값)";
    return `(실제 전송 ${a.field}=${a.value})`;
}

/// 실행 중 요청에 고정된 설정(RUN-009). 접수 때 정해져 실행 중 바꿔도 이 요청에는 적용되지 않는다.
function ActiveSettings({ turn, workflows }: { turn: Turn; workflows: Definition[] }) {
    const profiles = useQuery<ModelProfile[]>("profiles", () => api.get("/model-profiles"));
    const def = (turn.definition ?? {}) as {
        effort?: string; effort_applied?: { field: string | null; value: string | number | null }; service_tier?: string;
        workflow?: { id?: string; disabled_selection?: string }; agent?: { id?: string };
    };
    const p = profiles.data?.find((x) => x.id === turn.profile_id);
    const wf = workflows.find((w) => w.id === (def.workflow?.id ?? turn.workflow_id));
    const skipped = def.workflow?.disabled_selection;
    const skippedName = skipped && (workflows.find((w) => w.id === skipped)?.name ?? skipped);
    return (
        <GroveText as="p" display="block" type="supporting" color="secondary" data-testid="active-settings">
            이번 요청: {p ? `${p.name} · ${p.model}` : "모델 프로필"} · 추론 {def.effort ?? "auto"}
            {def.service_tier && ` · 속도 ${def.service_tier === "priority" ? "Fast" : def.service_tier === "default" ? "Normal" : def.service_tier}`}
            <GroveText type="inherit" color="inherit" data-testid="effort-applied">{effortApplied(def.effort_applied)}</GroveText> · 워크플로 {wf?.name ?? def.workflow?.id ?? "기본"}
            {skippedName && `(꺼진 ${skippedName} 대신)`}
            {def.agent?.id && ` · 에이전트 ${def.agent.id}`}
            <HelpTip label="실행 중 설정 도움말">모델·추론·속도·워크플로 변경은 다음 요청부터 적용됩니다.</HelpTip>
        </GroveText>
    );
}
