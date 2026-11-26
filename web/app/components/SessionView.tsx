import { usePendingAction } from "../state/usePendingAction";
import { HintText } from "../design/HintText";
import { ChatMessage, ChatMessageBubble } from "@astryxdesign/core/Chat";
import { Card } from "@astryxdesign/core/Card";
import { contentStyles } from "../design/content.stylex";
import { Select } from "../design/Select";
import { CodeBlock } from "../design/CodeBlock";
import { StatusBadge } from "../design/StatusBadge";
import { List as GroveList, ListItem as GroveListItem } from "@astryxdesign/core/List";
import { Text as GroveText } from "@astryxdesign/core/Text";
import { Button as GroveButton } from "../design/Button";
import { AttachmentList, OutgoingAttachments, type Attachment } from "./Attachments";
import { OutgoingMessage } from "./OutgoingMessage";
import { ActionMenu, DetailDialog, Panel, ToolsTrigger, Workbench } from "./ui/Controls";
import { Suspense, lazy, memo, useEffect, useLayoutEffect, useRef, useState } from "react";
import { FileLinkContext, FileRefContext, Markdown } from "./Markdown";
import { usePrefs } from "../state/device";
import { absoluteTime } from "../state/time";
import { When } from "./When";
import { useFocusRequest } from "../state/focus";
import { queueText } from "../state/queue";
import { ApiError, api, isLoggedIn, isTransportError } from "../api/client";
import { readConversation } from "../state/workspaceStartup";
import { CONVERSATION_PAGE_SIZE, conversationPagePath, keepOlderPages, mergeMessages, readMessageRange, singleFlight, takeOlderPages } from "../state/conversationPages";
import type { BotRoom, Definition, Followup as FollowupInfo, Message, MessagePage, Project, RecentItem, Session, ToolCallRow, Turn } from "../api/generated";
import { patchData, useLive, useQuery } from "../state/store";
import { acceptSent, acceptedInFollowups, acceptedInMessages, useOutgoing, type Outgoing } from "../state/outgoing";
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
import { subscribeSecondTick } from "../state/secondTick";
import { AssistantIdentity } from "./assistant-identity";
import { ApprovalCard, currentApprovalContract } from "./approvals";
import { TurnTiming } from "./turn-timing/TurnTiming";
import { checkCompatibility, useServerBlockReason } from "./pwa/lifecycle";
import { MessageCopyButton as CopyButton } from "./capabilities/MessageCopyButton";
import { CompactionDetails, type CompactionRecord } from "./compaction/CompactionDetails";
import { PendingServerActionButton, ServerActionButton } from "./pwa/ServerActionButton";
import { Stack } from "@astryxdesign/core/Stack";
import { Spinner } from "@astryxdesign/core/Spinner";
import { CHAT_COLUMN_WIDTH, chatLayout } from "./chat-layout.stylex";
import { LoadingBar } from "./LoadingScreen";
import { QuestionCard } from "./QuestionCard";
import { AssistantResponse, splitResponse, type ResponseContent } from "./AssistantResponse";
import { assistantTranscript, type AssistantRow } from "./assistantTranscript";

const GoalsPanel = lazy(() => import("./GoalsPanel").then(({ GoalsPanel }) => ({ default: GoalsPanel })));

type Props = { tabId: string; sessionId: string; projectId: string; open: Opener; onTitleChange: (title: string) => void };

export function SessionView({ tabId, sessionId, projectId, open, onTitleChange }: Props) {
    const visible = usePaneVisible();
    const [pageVisible, setPageVisible] = useState(() => typeof document !== "undefined" && document.visibilityState === "visible");
    useEffect(() => {
        const changed = () => setPageVisible(document.visibilityState === "visible");
        document.addEventListener("visibilitychange", changed);
        return () => document.removeEventListener("visibilitychange", changed);
    }, []);
    const serverBlocked = useServerBlockReason();
    useEffect(() => visible ? deliveryTiming.watch(sessionId) : undefined, [visible, sessionId]);
    const prefs = usePrefs("progressVisibility", "timeStyle", "clock", "fontSize", "theme");
    const session = useQuery<Session>(`session:${sessionId}`, () => readConversation.session(sessionId));
    useEffect(() => {
        if (session.data) onTitleChange(session.data.title);
    }, [session.data?.title, onTitleChange]);
    const project = useQuery<Project>(`project:${projectId}`, () => api.get(`/projects/${projectId}`));
    const latest = useQuery<MessagePage>(`messages:${sessionId}`, () => readConversation.messages(sessionId));
    const turns = useQuery<Turn[]>(`turns:${sessionId}`, () => readConversation.turns(sessionId));
    const lastTurn = turns.data?.[0];
    const active = turns.data?.find((t) => ["queued", "running", "awaiting_approval"].includes(t.status));
    const failedTurn = !active && lastTurn && ["failed", "interrupted"].includes(lastTurn.status) && !lastTurn.acknowledged_at ? lastTurn : undefined;
    const completedTurnId = lastTurn?.status === "completed" ? lastTurn.id : undefined;
    const calls = useQuery<ToolCallRow[]>(`calls:${sessionId}`, () => readConversation.calls(sessionId));
    const workflows = useQuery<Definition[]>("definitions:workflow", () => api.get("/definitions?kind=workflow"));
    const partial = useLive((live) => {
        const snapshot = live.partials[sessionId] as (ResponseContent & { turn_id: string; tool_calls: string[] }) | null | undefined;
        return visible && active?.status === "running" && snapshot?.turn_id === active.id ? snapshot : undefined;
    });
    // 탭 전환으로 내려갔다 돌아오면 읽던 과거 구간을 다시 받지 않고 이어 붙인다.
    const [initialOlder] = useState(() => latest.data ? takeOlderPages(sessionId, latest.data) : null);
    const [older, setOlder] = useState<Message[]>(initialOlder?.items ?? []);
    const [targetPage, setTargetPage] = useState<MessagePage | null>(null);
    const targetRequest = useRef(0);
    const [rangeError, setRangeError] = useState<{ seq?: number; message: string } | null>(null);
    const previewing = !!targetPage && targetPage.timeline_revision === latest.data?.timeline_revision;
    const previewRef = useRef(false);
    previewRef.current = previewing;
    const [olderMore, setOlderMore] = useState<boolean | null>(initialOlder?.more ?? null);
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
                    reopen: false,
                    ...(completedTurnId ? { seen_completed_turn_id: completedTurnId } : {}),
                })
                .catch((error) => {
                    if (isTransportError(error, true)) void checkCompatibility();
                    else setErr(error instanceof ApiError ? error.message : "대화 확인 상태를 저장하지 못했습니다.");
                });
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
    // 내가 보낸 뒤에는 직접 스크롤하기 전까지 맨 아래에 고정한다. 레이아웃 변화로 생긴 scroll은 고정을 풀지 않는다.
    const pinned = useRef(false);
    // 고정 중 화면 위에 남길 질문은 이 seq 뒤에 새로 보낸 사용자 메시지다.
    const promptAfter = useRef<number | null>(null);
    const followEnd = useRef<(() => boolean) | null>(null);
    const [unseen, setUnseen] = useState(false);
    const sentKey = useOutgoing(`session:${sessionId}`).filter((entry) => entry.copyId === tabId).at(-1)?.key;
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
        if (!followEnd.current) bottom.current?.scrollIntoView({ block: "end" });
        else if (followEnd.current()) setUnseen(true);
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
            const near = !!b && b.top <= messageViewportBottom() + 80;
            stick.current = pinned.current || (!previewRef.current && near);
            // 질문에서 멈춘 고정 상태는 아래에 새 내용이 남아 있으므로 끝이 실제로 보일 때만 알림을 지운다.
            // 80px 기준으로 지우면 멈춤 보정이 다시 알림을 켜며 버튼이 깜빡인다.
            if (pinned.current ? !!b && b.top <= messageViewportBottom() + 1 : near) setUnseen(false);
            capturePosition();
        };
        // 브라우저 scroll anchoring이 아래에 내용이 늘 때 위치를 고치며 scroll 이벤트를 내면 '맨 아래 보는 중'이 꺼진다.
        // 위쪽에 붙이는 이전 페이지는 직접 보정하므로 이 영역에서는 끈다.
        const prevAnchor = el.style.overflowAnchor;
        el.style.overflowAnchor = "none";
        // 입력창 안의 조작(초안 스크롤·Enter 전송)은 대화 스크롤 의도가 아니다.
        const outsideComposer = (e: Event) => !(e.target instanceof Element && e.target.closest('[data-testid="compose-surface"]'));
        const release = (e: Event) => { if (outsideComposer(e)) pinned.current = false; };
        const releaseKey = (e: KeyboardEvent) => {
            const editable = e.target instanceof HTMLElement && (e.target.isContentEditable || e.target.matches("input, textarea, select"));
            if (!editable && ["PageUp", "PageDown", "Home", "End", "ArrowUp", "ArrowDown", " "].includes(e.key)) release(e);
        };
        const scrollbar = (e: PointerEvent) => { if (e.target === el) release(e); };
        el.addEventListener("scroll", on, { passive: true });
        el.addEventListener("wheel", release, { passive: true });
        el.addEventListener("touchmove", release, { passive: true });
        el.addEventListener("keydown", releaseKey);
        el.addEventListener("pointerdown", scrollbar);
        return () => {
            el.removeEventListener("scroll", on);
            el.removeEventListener("wheel", release);
            el.removeEventListener("touchmove", release);
            el.removeEventListener("keydown", releaseKey);
            el.removeEventListener("pointerdown", scrollbar);
            el.style.overflowAnchor = prevAnchor;
        };
    }, [!!s, !!latest.data]); // eslint-disable-line react-hooks/exhaustive-deps
    const toBottom = () => {
        targetRequest.current++;
        setTargetPage(null);
        setRangeError(null);
        clearPendingPosition();
        pinned.current = false;
        stick.current = true;
        setUnseen(false);
        scrollEnd();
    };
    useEffect(() => {
        if (!visible || pendingPosition.current) return;
        if (stick.current) scrollEnd();
        else if (!savedPosition || (latest.data?.items.at(-1)?.seq ?? 0) > savedPosition.lastSeq || partial?.text) setUnseen(true);
        // 최신 페이지는 항상 최근 N개라 개수가 아니라 마지막 메시지로 새 글을 판단한다.
    }, [visible, !!s, latest.data?.items.at(-1)?.seq, partial?.text, sentKey]);

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
            const kept = !seenLatest && latest.data ? takeOlderPages(sessionId, latest.data) : null;
            setOlder(kept?.items ?? []);
            setOlderMore(kept?.more ?? null);
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
    const liveResponse = partial?.text === undefined ? undefined : partial;
    const showProgress = prefs.progressVisibility !== "hidden";
    const transcript = assistantTranscript(previewing ? targetPage.items : messages, previewing ? undefined : liveResponse, showProgress);
    // 방금 보낸 글은 서버 응답 전에도 대화 끝에 보인다. 실행 중에 보낸 추가 메시지는 대기 목록에 보인다.
    const outgoing = useOutgoing(`session:${sessionId}`);
    const sendingRows: Message[] = outgoing.filter((entry) => !entry.follow && !acceptedInMessages(entry, messages)).map((entry, index) => ({
        id: `outgoing:${entry.key}`, session_id: sessionId, seq: (messages.at(-1)?.seq ?? 0) + index + 1, role: "user",
        content: { text: entry.text, outgoing: entry }, turn_id: null, created_at: entry.createdAt,
    }));
    // 이 영역에서 보낸 글은 누른 즉시 맨 아래로 따라가고, 답이 길어져도 보낸 글이 화면 위로 사라지기 전에 멈춘다.
    const followedSend = useRef<string | undefined>(undefined);
    useLayoutEffect(() => {
        if (!sentKey || followedSend.current === sentKey) return;
        followedSend.current = sentKey;
        toBottom();
        promptAfter.current = latestRef.current?.items.at(-1)?.seq ?? 0;
        pinned.current = true;
    }, [sentKey]); // eslint-disable-line react-hooks/exhaustive-deps
    const isActiveTurn = (turnId: string | null) => !!active && active.id === turnId;
    const progressOpen = (turnId: string | null) => prefs.progressVisibility === "expanded" || isActiveTurn(turnId);
    const groupedSeq = (seq: number | null) => seq === null ? null : transcript.anchors.get(seq) ?? seq;
    // 앞에 붙인 페이지와 측정 높이의 위치 보정은 VirtualMessages가 같은 읽기 anchor로 처리한다.
    // 이전 페이지 조회는 대화마다 하나만 진행한다. 첫 응답 전에 다시 눌러도 같은 요청을 공유하고, 도착한 페이지는 seq로 합친다.
    const olderFlight = useRef(singleFlight()).current;
    const [loadingOlder, setLoadingOlder] = useState(false);
    const fetchOlder = (task: (first: number, revision: number) => Promise<{ items: Message[]; more: boolean } | null>, seq?: number) => {
        const first = messages[0]?.seq;
        const revision = latest.data?.timeline_revision;
        if (!first || revision == null) return Promise.resolve();
        setLoadingOlder(true);
        return olderFlight.run(sessionId, async () => {
            setRangeError(null);
            try {
                const page = await task(first, revision);
                setTargetPage(null);
                if (!page || revision !== latestRef.current?.timeline_revision) return;
                setOlder((o) => mergeMessages(page.items, o));
                setOlderMore(page.more);
            } catch (error) {
                setRangeError({ seq, message: error instanceof ApiError ? error.message : "이전 메시지를 불러오지 못했어요." });
            } finally {
                targetRequest.current++;
                setLoadingOlder(false);
            }
        });
    };
    const loadOlder = () => fetchOlder(async (first) => {
        const page = await api.get<MessagePage>(conversationPagePath(sessionId, CONVERSATION_PAGE_SIZE, { before: first }));
        return page.timeline_revision === latestRef.current?.timeline_revision ? { items: page.items, more: page.has_more_before } : null;
    });
    // 목적지가 정해진 이동은 100개씩 거슬러 올라가지 않고, 목적지 주변과 사이 구간을 한 번에 병렬로 읽는다.
    const loadThrough = (seq: number) => fetchOlder((first, revision) => {
        const request = ++targetRequest.current;
        return readMessageRange(sessionId, seq, first, revision, undefined, (page) => {
            if (request === targetRequest.current && revision === latestRef.current?.timeline_revision) setTargetPage(page);
        });
    }, seq);
    const hasOlder = olderMore ?? latest.data?.has_more_before;
    // 화면이 내려가면 읽던 과거 구간을 보관해 돌아올 때 다시 받지 않는다.
    const keepRef = useRef({ sessionId, older, olderMore, latest: latest.data });
    keepRef.current = { sessionId, older, olderMore, latest: latest.data };
    useEffect(() => () => {
        const { older, olderMore, latest } = keepRef.current;
        if (!latest || older.length === 0 || keepRef.current.sessionId !== sessionId || latest.items[0]?.session_id !== sessionId) return;
        const first = latest.items[0]?.seq ?? Number.MAX_SAFE_INTEGER;
        keepOlderPages(sessionId, latest.timeline_revision, [...older.filter((m) => m.seq < first), ...latest.items], olderMore ?? latest.has_more_before);
    }, [sessionId]);

    // 검색 결과에서 연 메시지로 이동(UI-026): 그 메시지가 나올 때까지 이전 페이지를 읽고, 가운데로 옮겨 잠시 강조한다.
    const [focusSeq, focusDone] = useFocusRequest(sessionId);
    // 검색 결과로 이동하면 보낸 직후의 맨 아래 고정을 풀고 그 메시지를 보여준다.
    if (focusSeq != null) pinned.current = false;
    const [highlight, setHighlight] = useState<number | null>(null);
    const [focusMiss, setFocusMiss] = useState(false);
    const position = pendingPosition.current;
    const restorePosition = focusSeq == null && position && position.timelineRevision === latest.data?.timeline_revision
        ? { ...position, anchorSeq: groupedSeq(position.anchorSeq) } : null;
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
        } else if (hasOlder && position.anchorSeq != null && (messages[0]?.seq ?? 0) > position.anchorSeq) {
            if (rangeError?.seq !== position.anchorSeq) void loadThrough(position.anchorSeq);
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
            if (!olderFlight.busy(sessionId) && rangeError?.seq !== focusSeq) void loadThrough(focusSeq);
        } else {
            // 지워졌거나 범위를 벗어남: 이동할 수 없음을 알린다.
            setFocusMiss(true);
            focusDone();
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [focusSeq, messages.length, latest.data, loadingOlder]);

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
        // 내가 보낸 글과 그 답은 직접 스크롤하기 전까지 따라가되, 보낸 질문이 화면 위로 사라지기 전에 멈춘다.
        toBottom();
        promptAfter.current = latestRef.current?.items.at(-1)?.seq ?? 0;
        pinned.current = true;
        // 응답에 담긴 메시지·실행 상태는 이벤트를 기다리지 않고 바로 화면에 반영한다.
        if (follow) {
            // 실행 중 추가 메시지(RUN-007): 서버가 실행 상태를 다시 확인하고, 그 사이 끝났으면 바로 새 요청으로 시작한다.
            const added = await api.post<{ started_turn?: Turn; message?: Message; followup?: FollowupInfo }>(`/sessions/${sessionId}/followups`, { kind: follow, text, attachments, profile_id: o.profileId, model: o.model, agent_id: o.agentId, tools: o.tools, effort: o.effort ?? "auto", service_tier: o.serviceTier, native_command: o.nativeCommand }, request);
            acceptSent(sessionId, { turn: added?.started_turn, message: added?.message, followup: added?.followup });
            return;
        }
        if (o.mode === "save") acceptSent(sessionId, { message: await api.post<Message>(`/sessions/${sessionId}/messages`, { text, attachments }, { key }) });
        else acceptSent(sessionId, await api.post<{ turn?: Turn; message?: Message }>(`/sessions/${sessionId}/turns`, { text, attachments, profile_id: o.profileId, model: o.model, agent_id: o.agentId, tools: o.tools, effort: o.effort ?? "auto", service_tier: o.serviceTier, native_command: o.nativeCommand }, request) ?? {});
    };

    const retry = (turnId: string, options: SendOptions | null) => act(() => options
        ? api.post(`/turns/${turnId}/retry`, { model_selection: {
            profile_id: options.profileId, model: options.model, effort: options.effort ?? "auto", service_tier: options.serviceTier,
        } }, { requires: ["turn_retry_model_selection_v1", ...modelOptionCapabilities(options)] })
        : api.post(`/turns/${turnId}/retry`));

    const rewind = (m: Message) => {
        if (!s || !confirm("이 사용자 메시지와 이후 대화를 활성 이력에서 제외할까요?\n파일·Git 변경과 실행 기록은 되돌리지 않습니다.\n원문은 DB에 보관되지만 이 화면에서 자동 복원할 수 없습니다.")) return;
        void act(() => api.post(`/sessions/${sessionId}/rewind`, {
            message_id: m.id,
            expected_revision: s.revision,
            expected_last_message_seq: s.last_message_seq,
        }));
    };

    // 선택한 응답까지의 대화와 모델 컨텍스트를 이어받는 새 대화를 연다. 원본 대화와 파일은 바꾸지 않는다.
    const forking = usePendingAction();
    const fork = (seq: number, inherit: boolean) => forking.run(async () => {
        const n = await api.post<Session>(`/sessions/${sessionId}/fork`, { from_seq: seq, inherit_context: inherit });
        open({ kind: "session", project_id: projectId, resource_id: n.id, title: n.title }, "right");
        return `분기한 대화를 열었습니다: ${n.title}`;
    });

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
                return await fork(session.data?.last_message_seq ?? 0, a !== "history") ?? "대화를 분기하는 중이에요.";
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
                { id: "session", label: "대화", content: <Panel title="대화 관리">
                    <Select label="워크플로우" value={s.workflow_id ?? "default"}
                        disabled={archived || !!serverBlocked} disabledMessage={serverBlocked ?? undefined}
                        onChange={(value) => void act(() => api.patch(`/sessions/${sessionId}`, { expected_revision: s.revision, workflow_id: value === "default" ? null : value }))}
                        options={(workflows.data ?? []).filter((w) => w.enabled || w.id === s.workflow_id)
                            .map((w) => ({ value: w.id, label: `워크플로우: ${w.name}${!w.enabled ? " (꺼짐 · 다음 요청은 기본 워크플로우)" : ""}` }))} />
                    <WorktreeSelect projectId={projectId} sessionId={sessionId} current={s.worktree_id} disabled={archived || !!s.active_turn || !!serverBlocked} onError={setErr} />
                    <ServerActionButton variant="secondary" density="compact" onClick={() => {
                        const title = prompt("대화 이름", s.title);
                        if (title && title !== s.title) void act(() => api.patch(`/sessions/${sessionId}`, { expected_revision: s.revision, title }));
                    }}>이름 바꾸기</ServerActionButton>
                    {!archived && <ServerActionButton variant="secondary" density="compact"
                        title="모델로 짧은 제목을 만듭니다(모델 비용 발생)" onClick={() => void act(async () => {
                            const r = await api.post<{ applied: boolean; message?: string }>(`/sessions/${sessionId}/title`, {});
                            if (!r.applied) setErr(`제목을 바꾸지 않았습니다: ${r.message ?? ""}`);
                        })}>제목 생성</ServerActionButton>}
                    <ServerActionButton variant="secondary" density="compact" disabled={archived || forking.busy} onClick={() => {
                        const inherit = confirm("모델 컨텍스트도 이어받을까요?\n확인: 대화와 컨텍스트 계승 / 취소: 대화 기록만 표시하고 새 컨텍스트");
                        void act(() => fork(s.last_message_seq, inherit));
                    }}>{forking.busy ? "분기 중…" : "분기"}</ServerActionButton>
                    <ServerActionButton variant="secondary" density="compact" onClick={() => void act(() => api.patch(`/sessions/${sessionId}`, { expected_revision: s.revision, archived: !archived }))}>
                        {archived ? "복원" : "보관"}
                    </ServerActionButton>
                    <GroveButton variant="secondary" appearance="icon" aria-label="대화 설정" title="대화 설정" onClick={() => open({ kind: "settings", project_id: projectId, resource_id: `session:${sessionId}`, title: `설정 · ${s.title}` })}>
                        <Icon name="settings" />
                    </GroveButton>
                    {archived && <ServerActionButton variant="destructive" density="compact" onClick={() => {
                        const t = prompt(`영구 삭제는 되돌릴 수 없습니다. 메시지·실행 기록이 모두 지워집니다.\n확인하려면 대화 제목을 그대로 입력하세요: ${s.title}`);
                        if (t === null) return;
                        void act(() => api.post(`/sessions/${sessionId}/delete`, { expected_revision: s.revision, confirm_title: t }));
                    }}>영구 삭제</ServerActionButton>}
                </Panel> },
            ]}>
            {s.bot_id || room.data ? <Stack as="header" direction="horizontal" align="center" gap={2}>
                {s.bot_id && <HintText data-testid="bot-chip" hint="모델·persona는 봇 설정을 따릅니다(입력창의 모델·에이전트 선택은 쓰지 않음)">봇 대화</HintText>}
                {room.data && <HintText data-testid="bot-room-chip" hint={`@{봇 이름}으로 답할 봇을 지정해요. 여러 봇을 지정하면 순서대로 답하고, 지정하지 않으면 첫 봇이 답해요. 참여: ${room.data.members.map((m) => m.name).join(", ")}`}>봇 그룹</HintText>}
                <ToolsTrigger />
            </Stack> : <ToolsTrigger inlineHeader />}
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
            <Stack gap={4} width="100%" maxWidth={CHAT_COLUMN_WIDTH} xstyle={chatLayout.messages} aria-live="polite" data-session-msgs={sessionId} ref={msgsRef}>
                {rangeError && <GroveText color="error" role="alert">{rangeError.message}{" "}
                    <GroveButton appearance="link" onClick={() => void (rangeError.seq == null ? loadOlder() : loadThrough(rangeError.seq))}>다시 불러오기</GroveButton>
                </GroveText>}
                {previewing && loadingOlder && <GroveText type="supporting" color="secondary" role="status">주변 대화를 불러오는 중…</GroveText>}
                {hasOlder && !previewing && <GroveButton variant="secondary" disabled={loadingOlder} onClick={() => void loadOlder()}>이전 메시지</GroveButton>}
                <FileRefContext.Provider
                    value={project.data ? (path, line) => open({ kind: "file", project_id: projectId, resource_id: path, filePath: path, fileLine: line, title: line ? `${path}:${line}` : path }, "right") : null}
                >
                    <FileLinkContext.Provider value={project.data ? { projectId, rootPath: project.data.root_path } : null}>
                    <VirtualMessages key={`${tabId}:${latest.data?.timeline_revision ?? 0}`} messages={[...transcript.rows.filter((m) =>
                        !(failedTurn && m.turn_id === failedTurn.id && m.role === "note" && (m.content as { type?: string }).type === "turn_ended")), ...sendingRows]}
                        targetSeq={groupedSeq(focusSeq ?? position?.anchorSeq ?? null)} presentationKey={JSON.stringify([prefs.progressVisibility, prefs.timeStyle, prefs.clock, prefs.fontSize, prefs.theme])}
                        onTargetReached={(seq) => {
                            if (focusSeq == null) return;
                            setHighlight(seq);
                            setFocusMiss(false);
                            focusDone();
                        }}
                        restorePosition={restorePosition}
                        onRestored={() => {
                            const position = pendingPosition.current;
                            clearPendingPosition();
                            setUnseen(!!position && (latest.data?.items.at(-1)?.seq ?? 0) > position.lastSeq || !!partial?.text);
                            capturePosition();
                        }}
                        stick={stick} pinned={pinned} bottom={bottom} promptAfter={promptAfter} follow={followEnd} onHeld={() => setUnseen(true)} onNavigate={() => { clearPendingPosition(); pinned.current = false; stick.current = false; }}
                        render={(m) => {
                            const sending = (m.content as { outgoing?: Outgoing }).outgoing;
                            if (sending) return <Stack gap={0} key={m.id} data-seq={m.seq}>
                                <OutgoingMessage message={sending} />
                                <Stack direction="horizontal" align="center" gap={1} xstyle={chatLayout.actions}>
                                    <When at={m.created_at} absolute part="time" titlePart="datetime" />
                                    {!!sending.text && <CopyButton text={sending.text} />}
                                </Stack>
                            </Stack>;
                            const preceding = transcript.preceding.get(m.id);
                            return (
                        <Stack gap={0} key={m.id} xstyle={highlight === m.seq && chatLayout.focusHit} data-seq={m.seq} data-highlighted={highlight === m.seq}>
                            {preceding && <ChatMessage sender="assistant" density="compact" data-testid="pre-steer-progress"
                                name={<AssistantIdentity name={assistantName} imageUrl={assistantImage} />}>
                                <AssistantResponse content={preceding.content} progressStart={preceding.start}
                                    progressOpen={progressOpen(m.turn_id)} progressActive={isActiveTurn(m.turn_id)} />
                            </ChatMessage>}
                            {m.role === "assistant"
                                ? <AssistantTurn row={transcript.assistants.get(m.id)!} name={assistantName} image={assistantImage}
                                    showProgress={showProgress} progressOpen={progressOpen(m.turn_id)} progressActive={isActiveTurn(m.turn_id)}
                                    onFork={archived || forking.busy ? undefined : () => void act(() => fork(transcript.assistants.get(m.id)!.latest.seq, true))} />
                                : <MessageView m={m} />}
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
                    ); }} />
                {transcript.liveTail && (
                    <ChatMessage sender="assistant" density="compact" data-testid="partial"
                        name={<AssistantIdentity name={assistantName} imageUrl={assistantImage}
                            detail={transcript.liveTail.content.text?.trim() ? "응답 중…" : "작업 중…"} />}>
                        <AssistantResponse content={transcript.liveTail.content} progressStart={transcript.liveTail.start} live showProgress={showProgress} />
                    </ChatMessage>
                )}
                    </FileLinkContext.Provider>
                </FileRefContext.Provider>
            </Stack>
            {unseen && (
                <Stack xstyle={chatLayout.below}>
                    <GroveButton data-testid="new-below" onClick={toBottom}>
                        새 메시지 ↓
                    </GroveButton>
                </Stack>
            )}
            {questions.map((c) => <QuestionCard key={c.id} call={c} act={act} onAnswered={calls.reload} />)}
            {pending.length > 0 && (
                <Stack gap={2} width="100%" maxWidth={CHAT_COLUMN_WIDTH} xstyle={chatLayout.centered}>
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
                </Stack>
            )}
            {unknown.map((c) => <UnknownCard key={c.id} c={c} act={act} />)}
            {/* 승인·질문 카드도 '맨 아래'에 포함해야 고정 스크롤이 카드를 입력창 뒤로 밀지 않는다. */}
            <Stack gap={0} ref={bottom} data-testid="msgs-bottom" />
            <Stack gap={1} xstyle={chatLayout.surface} data-testid="compose-surface">
            <Composer projectId={s.project_id} resourceKey={`session:${sessionId}`} copyId={tabId} onSend={send} running={!!active} disabled={blocked} commands={commands}
                beforeComposer={(options, retryDisabled) => <>
            {failedTurn && (
                <Card variant="muted" padding={3} xstyle={chatLayout.turnError} role="alert" data-testid="turn-ended">
                    <Stack gap={2}>
                        <Stack gap={1}>
                            <Stack as="header" direction="horizontal" align="center" justify="between" gap={2}>
                                <Stack direction="horizontal" align="center" gap={1.5}>
                                    <Icon name="warning" size={16} color="warning" />
                                    <GroveText weight="semibold">요청이 {failedTurn.status === "failed" ? "실패" : "중단"}했어요</GroveText>
                                </Stack>
                                <Stack direction="horizontal" align="center" gap={1} xstyle={chatLayout.turnErrorMeta}>
                                    <TurnTiming sessionId={sessionId} turn={failedTurn} messagesReady={false} showStatus={false} />
                                    <ServerActionButton type="button" appearance="icon" density="compact" aria-label="닫기(포기)" title="닫기(포기)"
                                        onClick={() => void act(() => api.post(`/turns/${failedTurn.id}/acknowledge`))}>
                                        <Icon name="close" size={16} />
                                    </ServerActionButton>
                                </Stack>
                            </Stack>
                            <GroveText type="supporting">{(failedTurn.error as EndErrorData)?.message}</GroveText>
                            <GroveText type="supporting" color="secondary">자동으로 다시 실행하지 않아요.</GroveText>
                        </Stack>
                        {(failedTurn.error as EndErrorData)?.scope && <EndScope s={(failedTurn.error as EndErrorData).scope!} warningsOnly />}
                        {failedTurn.evidence && !("corrupt" in failedTurn.evidence) && failedTurn.evidence.cli_execution_attempted && <TurnEvidenceWarning />}
                        <Stack as="footer" direction="horizontal" align="center" wrap="wrap" gap={1.5}>
                            {failedTurn.evidence && <TurnEvidence e={failedTurn.evidence} compact />}
                            <TurnEndRecord status={failedTurn.status} error={(failedTurn.error ?? {}) as EndErrorData} compact />
                            <ServerActionButton type="button" variant="primary" density="compact" disabled={retryDisabled} xstyle={chatLayout.turnErrorRetry}
                                onClick={() => void retry(failedTurn.id, options)}>
                                <Icon name="restore" size={14} />다시 실행
                            </ServerActionButton>
                        </Stack>
                    </Stack>
                </Card>
            )}
            {!active && lastTurn?.status === "cancelled" && lastTurn.evidence && "cli_execution_attempted" in lastTurn.evidence
                && !!lastTurn.evidence.cli_execution_attempted && <TurnEvidence e={lastTurn.evidence} />}
            {!active && !failedTurn && timedTurn && <Stack width="100%" maxWidth="48em" align="end" xstyle={chatLayout.centered}><TurnTiming sessionId={sessionId} turn={timedTurn}
                messagesReady={latest.data?.items.some((m) => m.turn_id === timedTurn.id && m.created_at === timedTurn.finished_at) ?? false} /></Stack>}
            <BudgetNote sessionId={sessionId} active={active} />
            <FollowupsPanel sessionId={sessionId} running={!!active} onError={setErr} />
                </>}
                lastModel={s.last_model}
                statusAccessory={active && <Stack direction="horizontal" align="center" justify="between" gap={2} paddingInline={2} paddingBlock={1}
                    xstyle={chatLayout.turnStatus} data-testid="turn-status">
                    <Stack direction="horizontal" align="center" gap={2} xstyle={chatLayout.turnStatusSummary}>
                        <Stack gap={0} aria-hidden="true" xstyle={chatLayout.turnStatusIndicator}>
                            {active.status === "running" ? <Spinner size="md" shade="inherit" /> : <Icon name="clock" size={16} />}
                        </Stack>
                        <Stack direction="horizontal" align="center" wrap="wrap" gap={2} xstyle={chatLayout.turnStatusSummary}>
                            <GroveText type="supporting" role="status">{active.status === "awaiting_approval"
                                ? questions.length > 0 && pending.length > 0
                                    ? "승인과 답변을 기다리는 중"
                                    : questions.length > 0
                                      ? "답변을 기다리는 중"
                                      : "승인을 기다리는 중"
                                : active.queue
                                  ? queueText(active.queue)
                                  : active.status === "queued"
                                    ? "대기 중"
                                    : "실행 중"}</GroveText>
                            <TurnTiming sessionId={sessionId} turn={active} messagesReady={false} compact showStatus={false} />
                        </Stack>
                    </Stack>
                    <PendingServerActionButton key={active.id} pendingLabel="취소 요청 중…" appearance="choice" density="compact" aria-label="취소" xstyle={chatLayout.turnStatusAction}
                        action={async () => {
                            if (!confirm("진행 중인 요청을 취소할까요?\n이미 변경된 파일은 되돌리지 않아요.")) return;
                            await act(() => api.post(`/turns/${active.id}/cancel`));
                            turns.reload();
                        }}><Icon name="stop" size={16} />취소</PendingServerActionButton>
                </Stack>}
                sendAccessory={<ContextMeter sessionId={sessionId} profileId={active?.profile_id ?? lastTurn?.profile_id ?? null} activeTurnId={active?.id} busy={!!active || archived || !!serverBlocked} onError={setErr} />}
                boundProfileId={room.data ? room.data.members.find((m) => m.profile_id)?.profile_id ?? null : s.bot_id ? bots.data?.bots.find((bot) => bot.id === s.bot_id)?.profile_id ?? null : undefined} />
            </Stack>
            </Workbench>
        </Stack>
    );
}

function TurnEvidenceWarning() {
    return <GroveText type="supporting" color="warning">
        파일이 변경됐을 수 있으니 다시 실행하기 전에 diff를 확인하세요.
    </GroveText>;
}

/// 확정되지 않은 응답의 중단 증거(REC-010). 답변 목록과 분리해 표시하고 모델 입력에는 쓰지 않는다.
function TurnEvidence({ e, compact = false }: { e: NonNullable<Turn["evidence"]>; compact?: boolean }) {
    if ("corrupt" in e) {
        return (
            <GroveText as="p" display="block" type="supporting" color="inherit" data-testid="turn-evidence">
                손상된 중단 시점 기록({e.kind})은 표시할 수 없으며 원본은 보존합니다.
            </GroveText>
        );
    }
    return (
        <Stack gap={1} data-testid="turn-evidence">
        {!compact && e.cli_execution_attempted && <TurnEvidenceWarning />}
        <DetailDialog label="중단 전 응답" title={`확정되지 않은 응답 · ${e.text_chars}자`} appearance={compact ? "link" : undefined}>
            {e.truncated && <GroveText type="supporting" color="secondary">앞부분만 보존했어요.</GroveText>}
            <CodeBlock code={e.text} maxHeight="12em" />
        </DetailDialog>
        </Stack>
    );
}

function AssistantTurn({ row, name, image, showProgress, progressOpen, progressActive, onFork }: {
    row: AssistantRow; name: string; image: string | null; showProgress: boolean; progressOpen: boolean; progressActive: boolean;
    onFork?: () => void;
}) {
    const { latest, content, prior, attachments, live } = row;
    const meta = latest.content as { model?: string; bot?: { name?: string } };
    const { answer } = splitResponse(content);
    const detail = live ? (answer.trim() ? "응답 중…" : "작업 중…")
        : `모델${meta.model ? " · " + meta.model : ""}${content.pending_work ? " · 중간 응답" : ""}`;
    return <ChatMessage sender="assistant" density="compact" data-testid={live ? "partial" : "msg-assistant"}
        name={<GroveText type="inherit" color="secondary" data-testid="msg-who">
            <AssistantIdentity name={meta.bot?.name || name} imageUrl={meta.bot?.name ? null : image} detail={detail} />
        </GroveText>}>
        <AssistantResponse content={content} prior={prior} live={live} showProgress={showProgress} progressOpen={progressOpen}
            progressActive={progressActive} progressStart={row.progressStart} />
        {!live && answer.trim() && <Stack direction="horizontal" align="center" gap={2}>
            <CopyButton text={answer} />
            <When at={latest.created_at} absolute part="time" titlePart="datetime" />
            {onFork && <ActionMenu label="응답 작업">
                <ServerActionButton variant="secondary" density="compact" onClick={onFork}>여기에서 채팅 분기</ServerActionButton>
            </ActionMenu>}
        </Stack>}
        {attachments.length > 0 && <AttachmentList attachments={attachments} gallery />}
    </ChatMessage>;
}

const MessageView = memo(function MessageView({ m }: { m: Message }) {
    const nt0 = (m.content as { type?: string }).type;
    const c = m.content as { text?: string; attachments?: Attachment[] };
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
        const r = m.content as { status: string; error: EndErrorData };
        return <TurnEndRecord status={r.status} error={r.error} />;
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
    if (m.role === "user") {
        const source = (c as { source?: { kind?: string; name?: string } }).source;
        const origin = source?.kind === "agent_run" ? "부모 에이전트의 지시" : source?.kind === "schedule" ? `예약 '${source.name ?? ""}' 실행` : source?.kind === "continuation" ? "예약된 후속 확인" : null;
        return <ChatMessage sender="user" density="compact" data-testid="msg-user">
            <ChatMessageBubble>
                {origin && <GroveText as="div" display="block" type="supporting" color="secondary" data-testid="msg-who">{origin}</GroveText>}
                {c.text && <GroveText as="div" display="block" type="inherit" color="inherit" xstyle={contentStyles.plainText}>{c.text}</GroveText>}
                {Array.isArray(c.attachments) && c.attachments.length > 0 && <AttachmentList attachments={c.attachments as Attachment[]} />}
            </ChatMessageBubble>
        </ChatMessage>;
    }
    return (
        <ChatMessage sender="system" density="compact" data-testid={`msg-${m.role}`}
            name={<GroveText type="inherit" color="secondary" data-testid="msg-who">{m.role}</GroveText>}>
            {c.text && <GroveText as="div" display="block" type="inherit" color="inherit" xstyle={contentStyles.plainText}>{c.text}</GroveText>}
            {c.text && <Stack direction="horizontal" align="center" gap={2}>
                <CopyButton text={c.text} />
            </Stack>}
            {Array.isArray(c.attachments) && c.attachments.length > 0 && <AttachmentList attachments={c.attachments as Attachment[]} />}
        </ChatMessage>
    );
});

type EndErrorData = {
    code?: string; message?: string; at?: string; last_progress_at?: string;
    budget?: { max_minutes?: number };
    settings?: { provider_timeout_secs?: number };
    provider_stream?: { event: string; code?: string; incomplete_reason?: string };
    scope?: EndScopeData;
};

function TurnEndRecord({ status, error: e, compact = false }: { status: string; error: EndErrorData; compact?: boolean }) {
    const prefs = usePrefs("clock", "timeStyle");
    const timeZone = useLive((live) => live.serverTimeZone ?? "UTC");
    return <DetailDialog surface={compact ? undefined : "orange"} appearance={compact ? "link" : undefined} data-testid="msg-turn-ended" label="요청 종료 기록"
        title={compact ? "오류 상세" : <>요청 종료 · {e.message} (<code>{e.code}</code>)</>}>
        {compact && e.message && <GroveText as="p" display="block" type="inherit">{e.message}</GroveText>}
        <GroveText as="p" display="block" type="inherit">상태: {status} · <code>{e.code}</code></GroveText>
        {e.at && <GroveText as="p" display="block" type="inherit">발생 시각: <time dateTime={e.at} title={e.at}>{absoluteTime(e.at, prefs, "datetime", timeZone)}</time></GroveText>}
        {e.last_progress_at && <GroveText as="p" display="block" type="inherit">마지막 진행: <time dateTime={e.last_progress_at} title={e.last_progress_at}>{absoluteTime(e.last_progress_at, prefs, "datetime", timeZone)}</time></GroveText>}
        {e.budget?.max_minutes != null && <GroveText as="p" display="block" type="inherit">적용 예산: {e.budget.max_minutes}분</GroveText>}
        {e.provider_stream && <GroveText as="p" display="block" type="inherit">Codex 이벤트: <code>{e.provider_stream.event}</code></GroveText>}
        {e.provider_stream?.code && <GroveText as="p" display="block" type="inherit">Codex 오류 코드: <code>{e.provider_stream.code}</code></GroveText>}
        {e.provider_stream?.incomplete_reason && <GroveText as="p" display="block" type="inherit">미완료 사유: <code>{e.provider_stream.incomplete_reason}</code></GroveText>}
        {e.settings?.provider_timeout_secs != null && <GroveText as="p" display="block" type="inherit">모델 응답 대기 한도(설정): {e.settings.provider_timeout_secs}초</GroveText>}
        {e.scope && <EndScope s={e.scope} />}
    </DetailDialog>;
}

type EndScopeData = { steps: number; tool_calls: Record<string, number>; running_tasks: { id: string; command: string }[]; running_agents?: { id: string; agent_id: string; child_session_id: string }[] };

/// 중단 시점의 미완료 범위와 다음 조치(RUN-024). 서버가 기록한 값이라 새로고침·다른 기기에서도 같다.
function EndScope({ s, warningsOnly = false }: { s: EndScopeData; warningsOnly?: boolean }) {
    const unknown = (s.tool_calls?.unknown ?? 0) + (s.tool_calls?.running ?? 0);
    const tasks = s.running_tasks ?? [];
    if (warningsOnly && !unknown && !tasks.length && !s.running_agents?.length) return null;
    return (
        <GroveText as="div" display="block" type="supporting" color="inherit" data-testid="end-scope">
            {!warningsOnly && <GroveText as="p" display="block" type="inherit" color="inherit">
                진행 범위: 모델 응답 {s.steps}단계 · 최종 답변 없음
            </GroveText>}
            {tasks.length > 0 && (
                <GroveText as="p" display="block" type="inherit" color="inherit">
                    아직 실행 중인 작업이 {tasks.length}개 있어요. 작업 목록에서 확인하거나 취소할 수 있어요.
                </GroveText>
            )}
            {!!s.running_agents?.length && <GroveText as="p" display="block" type="inherit" color="inherit">미완료 자식 작업 {s.running_agents.length}개: {s.running_agents.map((a) => <code key={a.id}>{a.agent_id} </code>)} — 자식 목록에서 확인할 수 있습니다</GroveText>}
            {(unknown > 0 || !warningsOnly) && <GroveText as="p" display="block" type="inherit" color="inherit">
                {unknown > 0 && "결과가 확정되지 않은 작업을 먼저 확인하세요."}
                {!warningsOnly && " 다음 조치: 같은 요청 다시 실행 · 입력창에서 새 메시지 보내기 · 닫기(포기)"}
            </GroveText>}
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

type Followup = { attachments?: Attachment[]; id: string; kind: FollowKind; text: string; created_at: string; delivery_state?: FollowupInfo["delivery_state"]; last_error?: { code: string; message: string } | null };
const FOLLOW_KIND: Record<FollowKind, string> = { queue: "대기열", steer: "합치기", interrupt: "중단 후 전송" };

/// 실행 중 보낸 추가 메시지(UI-021). 실행 중이면 순서대로 기다리고, 실패·취소로 멈추면 직접 시작하거나 지운다.
function FollowupsPanel({ sessionId, running, onError }: { sessionId: string; running: boolean; onError: (m: string) => void }) {
    const q = useQuery<{ items: Followup[] }>(`followups:${sessionId}`, () => api.get(`/sessions/${sessionId}/followups`));
    const items = q.data?.items ?? [];
    // 방금 보낸 추가 메시지는 서버 응답 전에도 목록 끝에 보인다.
    const sending = useOutgoing(`session:${sessionId}`).filter((entry) => entry.follow && !acceptedInFollowups(entry, items));
    if (items.length === 0 && sending.length === 0) return null;
    const kinds = [...items.map((item) => item.kind), ...sending.map((entry) => entry.follow!)];
    const run = async (f: () => Promise<unknown>) => {
        try {
            await f();
        } catch (e) {
            onError(e instanceof ApiError ? e.message : "처리하지 못했습니다");
        }
        q.reload();
    };
    return (
        <Card variant="muted" padding={2} width="100%" maxWidth="48em" xstyle={chatLayout.centered}
            data-testid="followups" role="region" aria-label="대기 중인 메시지"><Stack gap={2}>
            <GroveText as="div" display="block" type="supporting" color="secondary">
                {items.some((item) => item.delivery_state === "unknown" || item.delivery_state === "rejected") ? "합치기 전달 결과를 확인해 주세요"
                    : !running && items.length > 0 ? "이전 실행이 완료되지 않아 멈췄습니다. 직접 시작하거나 지우세요"
                    : items.some((item) => item.delivery_state === "sending") ? "실행 중인 응답에 전달하고 있습니다"
                    : kinds.every((kind) => kind === "steer") ? "합치기 전달을 기다리고 있습니다"
                    : kinds.every((kind) => kind === "queue") ? "실행이 끝나면 순서대로 보냅니다"
                    : "선택한 방식으로 추가 메시지를 보냅니다"}
            </GroveText>
            <GroveList density="compact" edge="flush" listStyle="decimal">
                {items.map((f, i) => (
                    <GroveListItem key={f.id} data-testid="followup" label={<Stack gap={1}>
                        <Stack direction="horizontal" align="start" gap={1.5} xstyle={chatLayout.bar}>
                            <StatusBadge>{f.delivery_state === "sending" ? "전달 중" : FOLLOW_KIND[f.kind]}</StatusBadge>
                            <GroveText type="inherit" color="inherit" xstyle={[contentStyles.plainText, chatLayout.sessionPreview]}>{f.text.length > 120 ? `${f.text.slice(0, 120)}…` : f.text}</GroveText>
                        </Stack>
                        {!!f.attachments?.length && <AttachmentList attachments={f.attachments} />}
                        {f.last_error && <GroveText type="supporting" color="error"> · {f.last_error.message}</GroveText>}
                    </Stack>} endContent={<Stack direction="horizontal" align="center" gap={1}>
                        {!running && i === 0 && (!f.delivery_state || f.delivery_state === "pending") && (
                            <ServerActionButton variant="secondary" density="compact" onClick={() => void run(() => api.post(`/sessions/${sessionId}/followups/${f.id}/start`))}>
                                지금 시작
                            </ServerActionButton>
                        )}
                        <ServerActionButton variant="secondary" density="compact" disabled={f.delivery_state === "sending"} aria-label={`대기 메시지 삭제: ${f.text.slice(0, 20)}`} onClick={() => {
                            // 누른 즉시 목록에서 빼고, 서버가 거절하면 다시 읽어 되돌린다.
                            patchData<{ items: Followup[] }>(`followups:${sessionId}`, (page) => ({ ...page, items: page.items.filter((item) => item.id !== f.id) }));
                            void run(() => api.del(`/sessions/${sessionId}/followups/${f.id}`));
                        }}>
                            삭제
                        </ServerActionButton>
                    </Stack>} />
                ))}
                {sending.map((entry) => (
                    <GroveListItem key={entry.key} data-testid="followup-outgoing" label={<Stack gap={1}>
                        <Stack direction="horizontal" align="start" gap={1.5} xstyle={chatLayout.bar}>
                            <StatusBadge>{FOLLOW_KIND[entry.follow!]}</StatusBadge>
                            <GroveText type="inherit" color="inherit" xstyle={[contentStyles.plainText, chatLayout.sessionPreview]}>{entry.text.length > 120 ? `${entry.text.slice(0, 120)}…` : entry.text}</GroveText>
                        </Stack>
                        {entry.files.length > 0 && <OutgoingAttachments files={entry.files} />}
                    </Stack>} />
                ))}
            </GroveList>
        </Stack></Card>
    );
}

type Eff = { items: { key: string; effective: unknown; source: string }[] };
const SOURCE: Record<string, string> = { session: "이 대화", project: "프로젝트", server: "서버", default: "기본" };

/// 사용자가 정한 시간 예산(RUN-021). 실행 전에는 다음 요청에 적용될 값과 출처를, 실행 중에는 접수 때 고정된 값·기준 시각·남은 시간을 보인다.
/// 예산이 없으면(기본) 아무것도 표시하지 않는다: 정상 진행을 시간으로 끊지 않는다.
function BudgetNote({ sessionId, active }: { sessionId: string; active?: Turn }) {
    const eff = useQuery<Eff>(`settings:effective:session:${sessionId}`, () => api.get(`/settings/effective?session_id=${sessionId}`));
    const [now, setNow] = useState(Date.now);
    const fixed = (active as unknown as { definition?: { budget?: { max_minutes?: number } } } | undefined)?.definition?.budget;
    useEffect(() => {
        if (!fixed?.max_minutes) return;
        return subscribeSecondTick(() => setNow(Date.now()));
    }, [fixed?.max_minutes]);
    if (active) {
        if (!fixed?.max_minutes) return null;
        const base = new Date(active.created_at).getTime();
        const left = Math.max(0, Math.round((base + fixed.max_minutes * 60_000 - now) / 1000));
        return (
            <GroveText as="p" display="block" type="supporting" color="secondary" role="status" data-testid="budget-live">
                예산(접수 시 고정): 시간 {fixed.max_minutes}분 · <When at={active.created_at} absolute part="time" /> 시작 기준 · 남은 {Math.floor(left / 60)}분 {left % 60}초 · 넘으면 남은 작업을 멈춥니다
            </GroveText>
        );
    }
    const get = (k: string) => eff.data?.items.find((i) => i.key === k);
    const mins = get("runs.budget.max_minutes");
    const m = Number(mins?.effective ?? 0);
    if (!mins || !m) return null;
    return (
        <GroveText as="p" display="block" type="supporting" color="secondary" data-testid="budget-next">
            다음 요청 예산: 시간 {m}분(시작부터, 승인·답변 대기 포함 · {SOURCE[mins.source] ?? mins.source} 설정) · 넘으면 남은 작업을 멈춥니다
        </GroveText>
    );
}
