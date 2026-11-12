import { AttachmentList, type Attachment } from "./Attachments";
import { memo, useEffect, useLayoutEffect, useRef, useState } from "react";
import { FileRefContext, Markdown } from "./Markdown";
import { type Prefs, usePrefs } from "../state/device";
import { useFocusRequest } from "../state/focus";
import { ApiError, api, isLoggedIn } from "../api/client";
import type { Definition, Message, MessagePage, ModelProfile, RecentItem, Session, ToolCallRow, Turn } from "../api/generated";
import { useLive, useQuery } from "../state/store";
import { Composer, type FollowKind, type RunCommand, type SendOptions } from "./Composer";
import { AgentRunsPanel } from "./AgentRunsPanel";
import { ChangesPanel } from "./ChangesPanel";
import { ContextMeter } from "./ContextMeter";
import { GoalsPanel } from "./GoalsPanel";
import { TasksPanel } from "./TasksPanel";
import type { Opener } from "./Workspace";
import { WorktreeSelect } from "./WorktreesPanel";
import { loadScrollPosition, saveScrollPosition } from "../state/scrollPosition";
import { VirtualMessages } from "./VirtualMessages";
import { usePaneVisible } from "../state/paneVisibility";

type Props = { tabId: string; sessionId: string; projectId: string; open: Opener };

export function SessionView({ tabId, sessionId, projectId, open }: Props) {
    const visible = usePaneVisible();
    const prefs = usePrefs();
    const session = useQuery<Session>(`session:${sessionId}`, () => api.get(`/sessions/${sessionId}`));
    const latest = useQuery<MessagePage>(`messages:${sessionId}`, () => api.get(`/sessions/${sessionId}/messages?limit=100`));
    const turns = useQuery<Turn[]>(`turns:${sessionId}`, () => api.get(`/sessions/${sessionId}/turns?limit=5`));
    const calls = useQuery<ToolCallRow[]>(`calls:${sessionId}`, () => api.get(`/tool-calls?session_id=${sessionId}&limit=200`));
    const workflows = useQuery<Definition[]>("definitions:workflow", () => api.get("/definitions?kind=workflow"));
    const live = useLive();
    const partial = live.partials[sessionId] as { turn_id: string; text: string; reasoning?: string; tool_calls: string[] } | null | undefined;
    const [older, setOlder] = useState<Message[]>([]);
    const [olderMore, setOlderMore] = useState<boolean | null>(null);
    const latestRef = useRef(latest.data);
    latestRef.current = latest.data;
    const [err, setErr] = useState<string | null>(null);
    const bottom = useRef<HTMLDivElement>(null);
    const s = session.data;

    // 최근 항목 갱신 + 읽음 표시(보고 있는 동안 마지막 메시지까지 읽음)
    const lastSeq = s?.last_message_seq ?? 0;

    // 봇 대화도 보고 있는 동안 도착한 메시지는 읽은 것으로 기록한다(서버 위치는 뒤로 가지 않음).
    const botId = s?.bot_id ?? null;
    const bots = useQuery<{ bots: { id: string; profile_id: string | null }[] }>(botId ? "bots" : null, () => api.get("/bots"));
    useEffect(() => {
        if (visible && botId && lastSeq > 0) void api.post(`/bots/${botId}/seen`, { seq: lastSeq }).catch(() => undefined);
    }, [visible, botId, lastSeq]);
    useEffect(() => {
        if (!s || !visible) return;
        const t = setTimeout(() => {
            void api
                .post<RecentItem>("/recent/touch", { kind: "session", project_id: projectId, resource_id: sessionId, view_state: { last_seen_seq: lastSeq } })
                .catch(() => undefined);
        }, 300);
        return () => clearTimeout(t);
    }, [visible, sessionId, projectId, lastSeq, !!s]); // eslint-disable-line react-hooks/exhaustive-deps

    // 자동 스크롤(UI-009): 맨 아래 근처를 보고 있을 때만 새 내용을 따라 내려간다. 위를 읽는 중이면 위치를 그대로 두고 알림만 띄운다.
    const msgsRef = useRef<HTMLDivElement>(null);
    const [savedPosition] = useState(() => loadScrollPosition(tabId, sessionId));
    const pendingPosition = useRef(savedPosition?.atBottom ? null : savedPosition);
    const stick = useRef(savedPosition?.atBottom ?? true);
    const [unseen, setUnseen] = useState(false);
    const scroller = () => msgsRef.current?.closest(".pane-body") as HTMLElement | null;
    const capturePosition = () => {
        const el = scroller();
        const data = latestRef.current;
        if (!el || !el.clientHeight || !el.clientWidth || !data || pendingPosition.current || !isLoggedIn()) return;
        const viewport = el.getBoundingClientRect();
        const row = [...(msgsRef.current?.querySelectorAll<HTMLElement>(".msg-row") ?? [])].find((node) => {
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
    useEffect(() => {
        const el = scroller();
        if (!el) return;
        const on = () => {
            if (!el.clientHeight || !el.clientWidth) return;
            // 메시지 끝 표시가 스크롤 영역 아래쪽 80px 안에 보이면 '맨 아래를 보는 중'이다(아래 패널·입력창 높이와 무관).
            const b = bottom.current?.getBoundingClientRect();
            stick.current = !!b && b.top <= el.getBoundingClientRect().bottom + 80;
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
    }, [!!latest.data]); // eslint-disable-line react-hooks/exhaustive-deps
    const toBottom = () => {
        pendingPosition.current = null;
        stick.current = true;
        setUnseen(false);
        bottom.current?.scrollIntoView({ block: "end" });
    };
    useEffect(() => {
        if (!visible || pendingPosition.current) return;
        if (stick.current) bottom.current?.scrollIntoView({ block: "end" });
        else if (!savedPosition || (latest.data?.items.at(-1)?.seq ?? 0) > savedPosition.lastSeq || partial?.text) setUnseen(true);
        // 최신 페이지는 항상 최근 N개라 개수가 아니라 마지막 메시지로 새 글을 판단한다.
    }, [visible, latest.data?.items.at(-1)?.seq, partial?.text]);

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
            pendingPosition.current = null;
            stick.current = focusSeq == null;
            if (stick.current) bottom.current?.scrollIntoView({ block: "end" });
            return;
        }
        const el = scroller();
        const row = msgsRef.current?.querySelector<HTMLElement>(`[data-seq="${position.anchorSeq}"]`);
        if (el && row) {
            stick.current = false;
            el.scrollTop += row.getBoundingClientRect().top - el.getBoundingClientRect().top - position.offset;
            pendingPosition.current = null;
            setUnseen((latest.data.items.at(-1)?.seq ?? 0) > position.lastSeq || !!partial?.text);
            capturePosition();
        } else if (hasOlder && (messages[0]?.seq ?? 0) > (position.anchorSeq ?? 0)) {
            if (!loadingOlder.current) {
                loadingOlder.current = true;
                void loadOlder().finally(() => (loadingOlder.current = false));
            }
        } else {
            pendingPosition.current = null;
            stick.current = true;
            bottom.current?.scrollIntoView({ block: "end" });
        }
    }, [visible, focusSeq, latest.data, messages.length]); // eslint-disable-line react-hooks/exhaustive-deps
    useEffect(() => {
        if (highlight == null) return;
        const t = setTimeout(() => setHighlight(null), 4000);
        return () => clearTimeout(t);
    }, [highlight]);
    useEffect(() => {
        if (focusSeq == null || !latest.data) return;
        const el = msgsRef.current?.querySelector<HTMLElement>(`[data-seq="${focusSeq}"]`);
        if (el) {
            stick.current = false;
            el.scrollIntoView({ block: "center" });
            setHighlight(focusSeq);
            setFocusMiss(false);
            focusDone();
            return;
        }
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

    const active = turns.data?.find((t) => ["queued", "running", "awaiting_approval"].includes(t.status));
    const lastTurn = turns.data?.[0];
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
        // 내가 보낸 글과 그 답은 따라간다.
        toBottom();
        if (follow) {
            // 실행 중 추가 메시지(RUN-007): 서버가 실행 상태를 다시 확인하고, 그 사이 끝났으면 바로 새 요청으로 시작한다.
            await api.post(`/sessions/${sessionId}/followups`, { kind: follow, text, attachments, profile_id: o.profileId, agent_id: o.agentId, tools: o.tools, effort: o.effort ?? "auto" }, { key });
            return;
        }
        if (o.mode === "save") await api.post(`/sessions/${sessionId}/messages`, { text, attachments }, { key });
        else await api.post(`/sessions/${sessionId}/turns`, { text, attachments, profile_id: o.profileId, agent_id: o.agentId, tools: o.tools, effort: o.effort ?? "auto" }, { key });
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

    if (session.error) return <div className="err">세션을 불러올 수 없습니다: {(session.error as Error).message}</div>;
    if (!s) return <div className="muted">불러오는 중…</div>;
    const archived = !!s.archived_at;
    const blocked = archived ? "보관된 세션입니다" : unknown.length > 0 ? "결과 확인이 필요한 작업을 먼저 검토하세요" : active ? null : null;

    return (
        <div className="session-view" data-testid="session-view" data-session={sessionId}>
            <header className="view-head">
                <h1>
                    <button className="link" title="이름 바꾸기" onClick={() => {
                        const t = prompt("대화 이름", s.title);
                        if (t && t !== s.title) void act(() => api.patch(`/sessions/${sessionId}`, { expected_revision: s.revision, title: t }));
                    }}>
                        {s.title}
                    </button>
                </h1>
                <select
                    aria-label="워크플로우"
                    value={s.workflow_id ?? "default"}
                    disabled={archived}
                    onChange={(e) => void act(() => api.patch(`/sessions/${sessionId}`, { expected_revision: s.revision, workflow_id: e.target.value === "default" ? null : e.target.value }))}
                >
                    {(workflows.data ?? []).filter((w) => w.enabled || w.id === s.workflow_id).map((w) => (
                        <option key={w.id} value={w.id}>워크플로우: {w.name}</option>
                    ))}
                </select>
                <WorktreeSelect projectId={projectId} sessionId={sessionId} current={s.worktree_id} disabled={archived || !!s.active_turn} onError={setErr} />
                {!archived && (
                    <button
                        className="ghost small"
                        title="모델로 짧은 제목을 만듭니다(모델 비용 발생)"
                        onClick={() =>
                            void act(async () => {
                                const r = await api.post<{ applied: boolean; message?: string }>(`/sessions/${sessionId}/title`, {});
                                if (!r.applied) setErr(`제목을 바꾸지 않았습니다: ${r.message ?? ""}`);
                            })
                        }
                    >
                        제목 생성
                    </button>
                )}
                {s.bot_id && <span className="chip" data-testid="bot-chip" title="모델·persona는 봇 설정을 따릅니다(입력창의 모델·에이전트 선택은 쓰지 않음)">봇 대화</span>}
                {lastTurn?.agent_id && <span className="chip" title="마지막 요청을 처리한 에이전트">에이전트: {lastTurn.agent_id}</span>}
                <ContextMeter sessionId={sessionId} profileId={lastTurn?.profile_id ?? null} busy={!!active || archived} onError={setErr} />
                <button className="ghost small" disabled={archived} onClick={() => {
                    const inherit = confirm("모델 컨텍스트도 이어받을까요?\n확인: 대화와 컨텍스트 계승 / 취소: 대화 기록만 표시하고 새 컨텍스트");
                    void act(async () => {
                        const n = await api.post<Session>(`/sessions/${sessionId}/fork`, { from_seq: s.last_message_seq, inherit_context: inherit });
                        open({ kind: "session", project_id: projectId, resource_id: n.id, title: n.title }, "right");
                    });
                }}>분기</button>
                <button className="ghost small" onClick={() => void act(() => api.patch(`/sessions/${sessionId}`, { expected_revision: s.revision, archived: !archived }))}>
                    {archived ? "복원" : "보관"}
                </button>
                <button className="ghost small" onClick={() => open({ kind: "settings", project_id: projectId, resource_id: `session:${sessionId}`, title: `설정 · ${s.title}` })}>
                    대화 설정
                </button>
                {archived && (
                    <button
                        className="ghost small danger"
                        onClick={() => {
                            const t = prompt(`영구 삭제는 되돌릴 수 없습니다. 메시지·실행 기록·초안이 모두 지워집니다.\n확인하려면 대화 제목을 그대로 입력하세요: ${s.title}`);
                            if (t === null) return;
                            void act(() => api.post(`/sessions/${sessionId}/delete`, { expected_revision: s.revision, confirm_title: t }));
                        }}
                    >
                        영구 삭제
                    </button>
                )}
            </header>
            {s.parent_session_id && (
                <p className="muted small">
                    분기된 대화 · {s.fork_inherits_context ? "모델 컨텍스트 계승" : "대화 기록만 표시(새 컨텍스트)"}
                </p>
            )}
            {err && <p className="err" role="alert">{err}</p>}
            {focusMiss && <p className="muted small" role="status">찾은 메시지가 더 이상 없습니다(삭제·되감기되었을 수 있습니다).</p>}
            {latest.data?.rewind_boundary_seq != null && (
                <p className="muted small" data-testid="rewind-limit">
                    압축된 구간(메시지 seq {latest.data.rewind_boundary_seq}까지)은 되감기할 수 없습니다.
                    이후 사용자 메시지 직전으로만 되감기하며, 파일·Git 변경은 별도입니다.
                </p>
            )}
            <div className="messages" aria-live="polite" data-session-msgs={sessionId} ref={msgsRef}>
                {hasOlder && <button className="ghost" onClick={loadOlder}>이전 메시지</button>}
                <FileRefContext.Provider
                    value={(path, line) => open({ kind: "file", project_id: projectId, resource_id: path, filePath: path, fileLine: line, title: line ? `${path}:${line}` : path }, "right")}
                >
                    <VirtualMessages key={`${tabId}:${latest.data?.timeline_revision ?? 0}`} messages={messages}
                        targetSeq={focusSeq ?? pendingPosition.current?.anchorSeq ?? null} presentationKey={JSON.stringify(prefs)}
                        stick={stick} bottom={bottom} onNavigate={() => { pendingPosition.current = null; stick.current = false; }}
                        render={(m) => (
                        <div key={m.id} className={`msg-row${highlight === m.seq ? " focus-hit" : ""}`} data-seq={m.seq}>
                            <MessageView m={m} prefs={prefs} />
                            {m.role === "user" && (
                                <button
                                    className="ghost small"
                                    aria-label="이 메시지 이전으로 되감기"
                                    disabled={archived || !!active || m.seq <= (latest.data?.rewind_boundary_seq ?? 0)}
                                    onClick={() => rewind(m)}
                                >이전으로 되감기</button>
                            )}
                        </div>
                    )} />
                </FileRefContext.Provider>
                {partial && partial.text !== undefined && (
                    <div className="msg assistant partial" data-testid="partial">
                        <div className="who">응답 중…</div>
                        {prefs.reasoning !== "hidden" && partial.reasoning && (
                            <div className="muted small reasoning-live" data-testid="partial-reasoning">생각 중: {partial.reasoning.slice(-300)}</div>
                        )}
                        <div className="text">{partial.text}</div>
                        {partial.tool_calls?.length > 0 && <div className="muted small">도구 호출 준비: {partial.tool_calls.join(", ")}</div>}
                    </div>
                )}
                <div ref={bottom} />
            </div>
            {unseen && (
                <button className="new-below" data-testid="new-below" onClick={toBottom}>
                    새 메시지 ↓
                </button>
            )}
            <GoalsPanel sessionId={sessionId} disabled={archived} />
            <AgentRunsPanel sessionId={sessionId} projectId={projectId} open={open} onError={setErr} />
            {/* 대화가 바뀌면 패널 상태를 새로 시작한다. 형제끼리 key가 겹치면 React가 패널을 잘못 맞춰 중복으로 그린다. */}
            <TasksPanel key={`tasks:${sessionId}`} sessionId={sessionId} disabled={archived} />
            <ChangesPanel key={`changes:${sessionId}`} sessionId={sessionId} disabled={archived} />
            {questions.map((c) => <QuestionCard key={c.id} c={c} act={act} />)}
            {pending.map((c) => <ApprovalCard key={c.id} c={c} act={act} />)}
            {unknown.map((c) => <UnknownCard key={c.id} c={c} act={act} />)}
            {active && (
                <div className="turn-status" role="status" data-testid="turn-status">
                    {active.status === "awaiting_approval"
                        ? questions.length > 0 && pending.length > 0
                            ? "승인과 답변을 기다리는 중"
                            : questions.length > 0
                              ? "답변을 기다리는 중"
                              : "승인을 기다리는 중"
                        : active.queue
                          ? `실행 차례를 기다리는 중 · ${active.queue.reason === "account" ? "계정 한도" : active.queue.reason === "provider" ? "공급자 한도" : "동시 실행"} ${active.queue.active}/${active.queue.limit}${active.queue.ahead > 0 ? ` · 앞에 ${active.queue.ahead}개` : ""}`
                          : active.status === "queued"
                            ? "대기 중"
                            : "실행 중"}
                    <button className="ghost small" onClick={() => void act(() => api.post(`/turns/${active.id}/cancel`))}>취소</button>
                </div>
            )}
            {active && <ActiveSettings turn={active} workflows={workflows.data ?? []} />}
            {!active && lastTurn && ["failed", "interrupted"].includes(lastTurn.status) && !lastTurn.acknowledged_at && (
                <div className="turn-status err" role="alert" data-testid="turn-ended">
                    마지막 요청이 {lastTurn.status === "failed" ? "실패" : "중단"}했습니다: {(lastTurn.error as { message?: string })?.message ?? ""}
                    <span className="muted small"> (자동으로 다시 실행하지 않습니다)</span>
                    {(lastTurn.error as { scope?: EndScopeData })?.scope && <EndScope s={(lastTurn.error as { scope: EndScopeData }).scope} />}
                    {/* RUN-019: 다시 실행(같은 글·설정)·새 요청 쓰기·포기(배너 닫기, 모든 기기) */}
                    <span className="inline">
                        <button className="ghost small" disabled={archived} onClick={() => void act(() => api.post(`/turns/${lastTurn.id}/retry`))}>
                            다시 실행
                        </button>
                        <button
                            className="ghost small"
                            onClick={() => (document.querySelector(`[data-session="${sessionId}"] textarea[aria-label="메시지 입력"]`) as HTMLTextAreaElement | null)?.focus()}
                        >
                            새 요청 쓰기
                        </button>
                        <button className="ghost small" onClick={() => void act(() => api.post(`/turns/${lastTurn.id}/acknowledge`))}>
                            닫기(포기)
                        </button>
                    </span>
                </div>
            )}
            {!active && lastTurn && <TurnTiming sessionId={sessionId} turnId={lastTurn.id} />}
            <BudgetNote sessionId={sessionId} active={active} />
            <FollowupsPanel sessionId={sessionId} running={!!active} onError={setErr} />
            <Composer projectId={s.project_id} resourceKey={`session:${sessionId}`} copyId={tabId} onSend={send} running={!!active} disabled={blocked} commands={commands}
                boundProfileId={s.bot_id ? bots.data?.bots.find((bot) => bot.id === s.bot_id)?.profile_id ?? null : undefined} />
        </div>
    );
}

const MessageView = memo(function MessageView({ m, prefs }: { m: Message; prefs: Prefs }) {
    const nt0 = (m.content as { type?: string }).type;
    // 답만 보기: 도구 결과·CLI 도구 활동·가져온 도구 기록과 글 없는 도구 호출 메시지를 숨긴다(승인 카드는 별도로 항상 표시).
    if (prefs.answerOnly && (m.role === "tool" || (m.role === "note" && (nt0 === "cli_activity" || nt0 === "imported_tool")))) return null;
    if (prefs.answerOnly && m.role === "assistant" && !(m.content as { text?: string }).text) return null;
    const c = m.content as { attachments?: Attachment[]; reasoning?: string | null; reasoning_chars?: number; text?: string; tool_calls?: { id: string; name: string }[]; name?: string; status?: string; output?: unknown; model?: string; approval_scope?: string | null; args?: unknown; duration_ms?: number | null; truncated?: boolean };
    if (m.role === "note" && nt0 === "completion_deferred") {
        const work = (m.content as { pending_work: { tasks: { id: string }[]; agents: { id: string }[] } }).pending_work;
        return <div className="msg note warn" role="status" data-testid="msg-completion-deferred">
            이 응답 시점에는 소유 작업 결과 반영 전이라 완료를 보류했습니다(진행 중: 백그라운드 {work.tasks.length}개 · 자식 {work.agents.length}개).
            결과를 받은 뒤 모델이 이어서 답합니다. 실행 상태와 결과는 작업·자식 목록에서 확인할 수 있습니다.
        </div>;
    }
    if (m.role === "note" && nt0 === "rewind") {
        const r = m.content as { text: string; removed_count: number };
        return <div className="msg note" data-testid="msg-rewind">{r.text} 활성 이력에서 {r.removed_count}개를 제외했습니다. 원문은 보관되며 자동 복원 UI는 없습니다.</div>;
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
            <details className="msg note warn" data-testid="msg-turn-ended">
                <summary>요청 종료 · {e.message} (<code>{e.code}</code>)</summary>
                <p>상태: {r.status}</p>
                {e.at && <p>발생 시각: <time dateTime={e.at}>{e.at}</time></p>}
                {e.last_progress_at && <p>마지막 진행: <time dateTime={e.last_progress_at}>{e.last_progress_at}</time></p>}
                {e.budget && (
                    <p>
                        적용 예산:
                        {e.budget.max_tokens != null && ` ${e.budget.max_tokens} tokens`}
                        {e.budget.max_minutes != null && ` ${e.budget.max_minutes}분`}
                        {e.budget.max_cost_cents != null && ` ${e.budget.max_cost_cents / 100} ${e.budget.currency ?? "USD"}`}
                    </p>
                )}
                {e.settings?.provider_timeout_secs != null && <p>provider timeout: {e.settings.provider_timeout_secs}초</p>}
                {e.scope && <EndScope s={e.scope} />}
            </details>
        );
    }
    if (m.role === "note" && (m.content as { type?: string }).type === "context_clear") {
        const r = m.content as { idle_minutes: number };
        return <div className="msg note" role="status" data-testid="msg-context-clear">
            idle {r.idle_minutes}분 이상 뒤 모델 context를 초기화했어요. 이전 대화는 요약 없이 모델 입력에서 제외했으며 화면 이력·파일은 남아 있어요.
        </div>;
    }
    if (m.role === "note" && (m.content as { type?: string }).type === "compaction") {
        const r = m.content as { summary: string; auto: boolean; estimated_before?: number; estimated_after?: number };
        return (
            <details className="msg note compaction" data-testid="msg-compaction">
                <summary>
                    이전 대화 요약({r.auto ? "자동" : "수동"} 압축) · 모델에는 이 요약과 이후 대화만 보냅니다
                    {r.estimated_before ? ` · 약 ${r.estimated_before}→${r.estimated_after} tokens` : ""}
                </summary>
                <div className="text">{r.summary}</div>
            </details>
        );
    }
    if (m.role === "note" && (m.content as { type?: string }).type === "compaction_failed") {
        const r = m.content as { error?: { message?: string } };
        return <div className="msg note warn" role="status">자동 압축 실패(대화는 그대로 진행): {r.error?.message}</div>;
    }
    if (m.role === "note" && (m.content as { type?: string }).type === "agent_result") {
        const r = m.content as { agent_id: string; status: string; text: string; truncated: boolean; error?: { message?: string } | null };
        return (
            <details className={`msg note agent ${r.status}`} data-testid="msg-agent-result" open>
                <summary>
                    자식 에이전트 <code>{r.agent_id}</code> · {r.status}
                    {r.error?.message ? ` · ${r.error.message}` : ""}
                </summary>
                {r.text && <div className="text">{r.text}</div>}
                {r.truncated && <p className="muted small">일부만 표시합니다. 전체는 자식 대화에서 보세요.</p>}
            </details>
        );
    }
    if (m.role === "note" && (m.content as { type?: string }).type === "task_result") {
        const r = m.content as { command: string; status: string; exit_code: number | null; reason: string | null; stdout_tail: string; stderr_tail: string; truncated: boolean; log_errors?: unknown[] };
        return (
            <details className={`msg note task ${r.status}`} data-testid="msg-task-result">
                <summary>
                    백그라운드 작업 <code>{r.command}</code> · {r.status}
                    {r.exit_code !== null ? ` (코드 ${r.exit_code})` : ""} {r.reason ? `· ${r.reason}` : ""}
                </summary>
                {r.stdout_tail && <pre className="diff">{r.stdout_tail}</pre>}
                {r.stderr_tail && <pre className="diff err">{r.stderr_tail}</pre>}
                {!!r.log_errors?.length && <p className="err" role="alert">로그 저장에 실패했습니다. 출력이 누락됐을 수 있습니다.</p>}
                {r.truncated && <p className="muted small">끝부분만 표시합니다. 전체 출력은 백그라운드 작업 목록에서 보세요.</p>}
            </details>
        );
    }
    // 가져온 기록(MIG-008, 014): 표시 전용이며 모델 입력에는 user/assistant 텍스트만 들어간다.
    const nt = (m.content as { type?: string }).type;
    if (m.role === "note" && nt === "import_notice") {
        const r = m.content as { source: string; truncated: boolean; interrupted: number; unsupported: string[] };
        return (
            <div className="msg note import" role="note" data-testid="msg-import-notice">
                기존 {r.source === "paseo" ? "Paseo" : r.source} 대화에서 가져왔습니다. 이어서 요청하면 모델에는 주고받은 글만 보내고,
                도구 결과·압축 요약은 보내지 않습니다.
                {r.truncated && " 원본 기록이 잘려 있어 앞부분이 없습니다."}
                {r.interrupted > 0 && ` 실행 중이던 작업 ${r.interrupted}건은 결과를 알 수 없으며 다시 실행하지 않았습니다.`}
            </div>
        );
    }
    if (m.role === "note" && nt === "imported_tool") {
        const r = m.content as { name: string; status: string; text: string };
        return (
            <details className={`msg tool imported ${r.status}`} data-testid="msg-imported-tool" open={prefs.expandTools || undefined}>
                <summary>
                    도구 {r.name} · <span className={`status ${r.status}`}>{r.status === "interrupted" ? "결과 불명(중단)" : r.status}</span> · 가져온 기록
                </summary>
                <pre>{r.text.slice(0, 20000)}</pre>
            </details>
        );
    }
    if (m.role === "note" && nt === "cli_activity") {
        const r = m.content as { items: { kind: string; name: string; input?: unknown; status?: string }[] };
        return (
            <details className="msg tool cli" data-testid="msg-cli-activity" open={prefs.expandTools || undefined}>
                <summary>
                    CLI가 사용한 도구 {r.items.length}개 · {r.items.map((i) => (i.kind === "denied" ? `${i.name}(거부됨)` : i.name)).join(", ")}
                </summary>
                <pre>{JSON.stringify(r.items, null, 2).slice(0, 20000)}</pre>
            </details>
        );
    }
    if (m.role === "note" && (nt === "imported_notice" || nt === "imported_compaction")) {
        const r = m.content as { level?: string; text?: string; pre_tokens?: number };
        return (
            <div className={`msg note ${r.level === "error" || r.level === "warning" ? "warn" : ""}`} data-testid="msg-imported-note">
                {nt === "imported_compaction" ? `원래 대화에서 자동 압축된 지점${r.pre_tokens ? `(약 ${r.pre_tokens} tokens)` : ""} · 요약문은 원본에 없습니다` : r.text}
            </div>
        );
    }
    if (m.role === "tool") {
        return (
            <details className={`msg tool ${c.status}`} data-testid="msg-tool" open={prefs.expandTools || undefined}>
                <summary>
                    도구 {c.name} · <span className={`status ${c.status}`}>{c.status}</span>
                    {c.approval_scope && (
                        <span className="muted small" data-testid="approval-scope">
                            {" "}· {c.approval_scope === "once" ? "이번만 승인" : c.approval_scope === "session" ? "이 대화에서 허용됨" : "정책(tools.allow)으로 허용"}
                        </span>
                    )}
                    {typeof c.duration_ms === "number" && <span className="muted small" data-testid="tool-duration"> · {fmtDuration(c.duration_ms)}</span>}
                    {c.truncated && <span className="muted small" data-testid="tool-truncated"> · 결과 일부만(잘림)</span>}
                </summary>
                {c.args !== undefined && (
                    <>
                        <div className="muted small">인자</div>
                        <pre data-testid="tool-args">{JSON.stringify(c.args, null, 2)?.slice(0, 20000)}</pre>
                    </>
                )}
                <div className="muted small">{c.status === "succeeded" ? "결과" : "결과·오류"}</div>
                <pre data-testid="tool-output">{JSON.stringify(c.output, null, 2)?.slice(0, 20000)}</pre>
            </details>
        );
    }
    return (
        <div className={`msg ${m.role}`} data-testid={`msg-${m.role}`}>
            <div className="who" data-testid="msg-who">
                {m.role === "user"
                    ? (c as { source?: { kind?: string } }).source?.kind === "agent_run"
                        ? "부모 에이전트의 지시"
                        : "나"
                    : m.role === "assistant"
                      ? `모델${c.model ? " · " + c.model : ""}${(m.content as { pending_work?: unknown }).pending_work ? " · 중간 응답(소유 작업 결과 반영 전)" : ""}`
                      : m.role}
            </div>
            {m.role === "assistant" && c.reasoning && prefs.reasoning !== "hidden" && (
                <details className="reasoning" data-testid="msg-reasoning" open={prefs.reasoning === "expanded" || undefined}>
                    <summary className="muted small">
                        생각 과정 · {c.reasoning_chars ?? c.reasoning.length}자{(c.reasoning_chars ?? 0) > [...c.reasoning].length ? " (앞부분만 보관)" : ""}
                    </summary>
                    <div className="text muted">{c.reasoning}</div>
                </details>
            )}
            {c.text && (m.role === "assistant" ? <Markdown text={c.text} /> : <div className="text">{c.text}</div>)}
            {c.text && <CopyButton text={c.text} />}
            {Array.isArray(c.attachments) && c.attachments.length > 0 && <AttachmentList attachments={c.attachments as Attachment[]} />}
            {c.tool_calls && c.tool_calls.length > 0 && <div className="muted small">도구 호출: {c.tool_calls.map((t) => t.name).join(", ")}</div>}
        </div>
    );
});

type Timing = { total_ms: number; approval_wait_ms: number; tool_ms: number; model_and_other_ms: number; running: boolean };

/// 마지막 요청의 경과 시간 분해(서버 시각 기준이라 기기 시계와 무관).
function TurnTiming({ sessionId, turnId }: { sessionId: string; turnId: string }) {
    const q = useQuery<{ timing: Timing }>(`turns:${sessionId}:timing:${turnId}`, () => api.get(`/turns/${turnId}`));
    const t = q.data?.timing;
    if (!t || t.running) return null;
    const s = (ms: number) => `${(ms / 1000).toFixed(1)}초`;
    return (
        <p className="muted small" data-testid="turn-timing">
            마지막 요청 {s(t.total_ms)} · 모델·처리 {s(t.model_and_other_ms)}
            {t.tool_ms > 0 && ` · 도구 ${s(t.tool_ms)}`}
            {t.approval_wait_ms > 0 && ` · 승인 대기 ${s(t.approval_wait_ms)}`}
        </p>
    );
}

function ApprovalCard({ c, act }: { c: ToolCallRow; act: (f: () => Promise<unknown>) => Promise<void> }) {
    const t = c.target as {
        path?: string; command?: string; cwd?: string; preview?: string; diff?: string; bytes?: number; timeout_ms?: number;
        action?: string; agent_id?: string; brief?: string; run_id?: string; hold_ms?: number;
    };
    return (
        <div className="approval" role="group" aria-label="승인 요청" data-testid="approval">
            <div>
                <strong>{c.name}</strong> 승인 요청 {c.expires_at && <span className="muted small">· {new Date(c.expires_at).toLocaleTimeString()}까지</span>}
            </div>
            {t.path && <div>대상: <code>{t.path}</code>{t.bytes !== undefined && ` (${t.bytes}바이트)`}</div>}
            {t.command && (
                <div>
                    명령: <code>{t.command}</code> · 위치: <code>{t.cwd}</code>
                    {t.hold_ms !== undefined && <span className="muted small"> · {t.hold_ms === 0 ? "백그라운드 실행" : `${t.hold_ms}ms 뒤 백그라운드 전환`}</span>}
                </div>
            )}
            {c.name === "apply_patch" && (
                <div data-testid="approval-patch">
                    {((c.target as { files?: { op: string; path: string; move_to?: string | null; diff: string }[] }).files ?? []).map((f) => (
                        <details key={f.path} open>
                            <summary>
                                <code>{f.op === "add" ? "추가" : f.op === "delete" ? "삭제" : f.move_to ? "수정·이동" : "수정"}</code> {f.path}
                                {f.move_to ? ` → ${f.move_to}` : ""}
                            </summary>
                            <pre className="diff">{f.diff}</pre>
                        </details>
                    ))}
                </div>
            )}
            {c.name === "agent" && (
                <div data-testid="approval-agent">
                    {t.action === "spawn" ? "새 자식 에이전트" : "자식 에이전트 후속 지시"}: <code>{t.agent_id ?? t.run_id}</code>
                    {t.brief && <pre className="preview">{t.brief}</pre>}
                    <span className="muted small">자식이 쓰는 파일 변경·명령은 따로 승인을 받습니다. 모델 사용 비용이 듭니다.</span>
                </div>
            )}
            {t.diff && <pre className="diff">{t.diff}</pre>}
            {t.preview && <pre className="preview">{t.preview}</pre>}
            <div className="actions">
                <button onClick={() => void act(() => api.post(`/tool-calls/${c.id}/decision`, { decision: "approve", expected_revision: c.revision }))}>이번만 승인</button>
                {c.name !== "agent" && (
                    <button
                        className="ghost"
                        title={`이 대화에서 ${c.name} 도구는 다시 묻지 않습니다(금지·읽기 전용 정책이 우선, 대화 설정에서 해제)`}
                        onClick={() => void act(() => api.post(`/tool-calls/${c.id}/decision`, { decision: "approve_session", expected_revision: c.revision }))}
                    >
                        이 대화에서 계속 허용
                    </button>
                )}
                <button className="ghost" onClick={() => void act(() => api.post(`/tool-calls/${c.id}/decision`, { decision: "deny", expected_revision: c.revision }))}>거부</button>
            </div>
        </div>
    );
}

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
        <div className="end-scope small" data-testid="end-scope">
            <p>
                진행 범위: 모델 응답 {s.steps}단계 · 최종 답변 없음
                {calls.length > 0 ? ` · 도구 ${calls.map(([k, n]) => `${CALL_STATUS[k] ?? k} ${n}`).join(", ")}` : " · 도구 호출 없음"}
            </p>
            {tasks.length > 0 && (
                <p>
                    계속 실행 중인 백그라운드 작업 {tasks.length}개: {tasks.map((t) => <code key={t.id}>{t.command}</code>)} — 작업 목록에서 확인·취소할 수 있습니다
                </p>
            )}
            {!!s.running_agents?.length && <p>미완료 자식 작업 {s.running_agents.length}개: {s.running_agents.map((a) => <code key={a.id}>{a.agent_id} </code>)} — 자식 목록에서 확인할 수 있습니다</p>}
            <p>
                다음 조치: {unknown > 0 ? "결과가 확정되지 않은 작업을 먼저 확인하세요. " : ""}같은 요청 다시 실행 · 새 요청 쓰기 · 닫기(포기)
            </p>
        </div>
    );
}

function UnknownCard({ c, act }: { c: ToolCallRow; act: (f: () => Promise<unknown>) => Promise<void> }) {
    const [obs, setObs] = useState<{ fingerprint: string; revision: number; observation: unknown } | null>(null);
    const [outcome, setOutcome] = useState("unsure");
    return (
        <div className="approval unknown" role="group" aria-label="결과 확인 필요" data-testid="unknown">
            <div>
                <strong>{c.name}</strong>의 결과를 알 수 없습니다(실행 중 서버가 종료됨). 자동으로 다시 실행하지 않습니다.
            </div>
            <div>대상: <code>{JSON.stringify(c.target).slice(0, 300)}</code></div>
            <button className="ghost small" onClick={() => void act(async () => setObs(await api.get(`/tool-calls/${c.id}/observe`)))}>현재 상태 확인</button>
            {obs && (
                <>
                    <pre>{JSON.stringify(obs.observation, null, 2)}</pre>
                    <label>
                        확인 결과
                        <select value={outcome} onChange={(e) => setOutcome(e.target.value)}>
                            <option value="applied">적용됨</option>
                            <option value="not_applied">적용 안 됨</option>
                            <option value="partial">일부 적용</option>
                            <option value="unsure">모르겠음</option>
                        </select>
                    </label>
                    <button onClick={() => void act(async () => {
                        await api.post(`/tool-calls/${c.id}/review`, { expected_revision: obs.revision, fingerprint: obs.fingerprint, outcome });
                        setObs(null);
                    })}>검토 기록</button>
                </>
            )}
        </div>
    );
}

/// 메시지 원문 복사(UI-011). 표시용 Markdown이 아니라 저장된 원문을 복사한다.
function CopyButton({ text }: { text: string }) {
    const [done, setDone] = useState(false);
    return (
        <button
            className="ghost small msg-copy"
            data-testid="msg-copy"
            onClick={() =>
                void navigator.clipboard?.writeText(text).then(
                    () => {
                        setDone(true);
                        setTimeout(() => setDone(false), 1500);
                    },
                    () => setDone(false),
                )
            }
        >
            {done ? "복사됨" : "메시지 복사"}
        </button>
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
        <section className="followups" data-testid="followups" aria-label="대기 중인 메시지">
            <div className="muted small">
                {running ? "실행이 끝나면 순서대로 보냅니다" : "이전 실행이 완료되지 않아 멈췄습니다. 직접 시작하거나 지우세요"}
            </div>
            <ol>
                {items.map((f, i) => (
                    <li key={f.id} data-testid="followup">
                        <span className="badge">{FOLLOW_KIND[f.kind]}</span>
                        <span className="followup-text">{f.text.length > 120 ? `${f.text.slice(0, 120)}…` : f.text}</span>
                        {!!f.attachments?.length && <AttachmentList attachments={f.attachments} />}
                        {f.last_error && <span className="err small"> · {f.last_error.message}</span>}
                        {!running && i === 0 && (
                            <button className="ghost small" onClick={() => void run(() => api.post(`/sessions/${sessionId}/followups/${f.id}/start`))}>
                                지금 시작
                            </button>
                        )}
                        <button className="ghost small" aria-label={`대기 메시지 삭제: ${f.text.slice(0, 20)}`} onClick={() => void run(() => api.del(`/sessions/${sessionId}/followups/${f.id}`))}>
                            삭제
                        </button>
                    </li>
                ))}
            </ol>
        </section>
    );
}

type Question = { question: string; options: { label: string; description?: string }[]; multi_select: boolean; allow_free_text: boolean };

/// 모델의 질문(UI-016): 단일·복수 선택, 직접 입력, 닫기. 보낸 값은 서버가 질문의 선택지로 다시 검증한다.
function QuestionCard({ c, act }: { c: ToolCallRow; act: (f: () => Promise<unknown>) => Promise<void> }) {
    const q = c.target as Question;
    const [picked, setPicked] = useState<string[]>([]);
    const [text, setText] = useState("");
    const toggle = (label: string) =>
        setPicked((p) => (q.multi_select ? (p.includes(label) ? p.filter((x) => x !== label) : [...p, label]) : [label]));
    const canSend = picked.length > 0 || (q.allow_free_text && text.trim().length > 0);
    const send = (body: Record<string, unknown>) => act(() => api.post(`/tool-calls/${c.id}/answer`, { expected_revision: c.revision, ...body }));
    return (
        <form
            className="approval question"
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
                    <span className="muted small"> · {q.multi_select ? "여러 개 선택 가능" : q.options.length > 0 ? "하나 선택" : "직접 입력"}</span>
                </legend>
                {q.options.map((o) => (
                    <label key={o.label} className="check option">
                        <input type={q.multi_select ? "checkbox" : "radio"} name={`q-${c.id}`} checked={picked.includes(o.label)} onChange={() => toggle(o.label)} />
                        <span>
                            {o.label}
                            {o.description && <span className="muted small"> — {o.description}</span>}
                        </span>
                    </label>
                ))}
                {q.allow_free_text && (
                    <label>
                        {q.options.length > 0 ? "직접 입력(선택)" : "답"}
                        <textarea rows={2} value={text} onChange={(e) => setText(e.target.value)} aria-label="직접 입력" />
                    </label>
                )}
            </fieldset>
            <div className="inline">
                <button type="submit" disabled={!canSend}>
                    답하기
                </button>
                <button type="button" className="ghost" onClick={() => void send({ cancel: true })}>
                    답하지 않고 닫기
                </button>
            </div>
        </form>
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
            <p className="muted small" role="status" data-testid="budget-live">
                예산(접수 시 고정):
                {fixed.max_minutes && (
                    <>
                        {" "}시간 {fixed.max_minutes}분 · {new Date(base).toLocaleTimeString()} 시작 기준 · 남은 {Math.floor(left! / 60)}분 {left! % 60}초
                    </>
                )}
                {fixed.max_tokens && <> · token {fixed.max_tokens} 중 {used} 사용</>}
                {fixed.max_cost_cents && <> · 추정 비용 {(fixed.max_cost_cents / 100).toFixed(2)} {fixed.currency ?? "USD"} 이내</>} · 넘으면 남은 작업을 멈춥니다
            </p>
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
        <p className="muted small" data-testid="budget-next">
            다음 요청 예산:
            {m > 0 && <> 시간 {m}분(시작부터, 승인·답변 대기 포함 · {SOURCE[mins!.source] ?? mins!.source} 설정)</>}
            {t > 0 && <> · token {t}({SOURCE[toks!.source] ?? toks!.source} 설정)</>}
            {c > 0 && <> · 추정 비용 {(c / 100).toFixed(2)}(프로필 가격표 통화, {SOURCE[cost!.source] ?? cost!.source} 설정)</>} · 넘으면 남은 작업을 멈춥니다
        </p>
    );
}

/// 실행 중 요청에 고정된 설정(RUN-009). 접수 때 정해져 실행 중 바꿔도 이 요청에는 적용되지 않는다.
function ActiveSettings({ turn, workflows }: { turn: Turn; workflows: Definition[] }) {
    const profiles = useQuery<ModelProfile[]>("profiles", () => api.get("/model-profiles"));
    const def = (turn.definition ?? {}) as { effort?: string; workflow?: { id?: string }; agent?: { id?: string } };
    const p = profiles.data?.find((x) => x.id === turn.profile_id);
    const wf = workflows.find((w) => w.id === (def.workflow?.id ?? turn.workflow_id));
    return (
        <p className="muted small" data-testid="active-settings">
            이번 요청: {p ? `${p.name} · ${p.model}` : "모델 프로필"} · 강도 {def.effort ?? "auto"} · 워크플로 {wf?.name ?? def.workflow?.id ?? "기본"}
            {def.agent?.id && ` · 에이전트 ${def.agent.id}`} — 실행 중에 모델·강도·워크플로를 바꾸면 다음 요청부터 적용됩니다.
        </p>
    );
}
