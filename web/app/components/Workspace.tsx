import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiError, api } from "../api/client";
import { EventStream } from "../api/events";
import type { Project } from "../api/generated";
import { applyPrefs, isNarrow, layoutKey, loadPrefs } from "../state/device";
import * as L from "../state/layout";
import { applyEvent, resyncAll, setLive, useLive, useQuery } from "../state/store";
import { AddProjectDialog } from "./AddProject";
import { BotsPanel } from "./BotsPanel";
import { NotificationsPanel } from "./NotificationsPanel";
import { RecentPanel } from "./RecentPanel";
import { SearchPanel } from "./SearchPanel";
import { SplitView } from "./SplitView";

export type OpenTarget = Omit<L.Tab, "id">;
export type Opener = (t: OpenTarget, how?: "here" | "right" | "down") => void;

const LOCAL_LAYOUT = "grove.layout.";
const PROJECT_SORT = "grove.projectSort";

function useNarrow(): boolean {
    const [n, setN] = useState(isNarrow());
    useEffect(() => {
        const m = window.matchMedia("(max-width: 760px)");
        const f = () => setN(m.matches);
        m.addEventListener("change", f);
        return () => m.removeEventListener("change", f);
    }, []);
    return n;
}

export function Workspace() {
    const narrow = useNarrow();
    const live = useLive();
    const [layout, setLayout] = useState<L.Layout | null>(null);
    const [sidebar, setSidebar] = useState(!isNarrow());
    const [notice, setNotice] = useState<string | null>(null);
    const revision = useRef(0);
    const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const key = useMemo(() => layoutKey(), [narrow]); // eslint-disable-line react-hooks/exhaustive-deps
    // 프로젝트 목록 정렬은 기기별 선택(PROJECT-002): 이름순 또는 최근 활동순.
    const [projectSort, setProjectSort] = useState<"name" | "recent">(() => (localStorage.getItem(PROJECT_SORT) === "recent" ? "recent" : "name"));
    const projects = useQuery<Project[]>(`projects:${projectSort}`, () => api.get(`/projects?sort=${projectSort}`));

    useEffect(() => applyPrefs(loadPrefs()), []);

    // 이벤트 stream
    const stream = useRef<EventStream | null>(null);
    useEffect(() => {
        const s = new EventStream({
            onEvent: applyEvent,
            onPartial: (sid, snap) => setLive((l) => ({ ...l, partials: { ...l.partials, [sid]: snap } })),
            onResync: () => resyncAll(),
            onStatus: (status, retryAt) => setLive((l) => ({ ...l, status, retryAt })),
        });
        stream.current = s;
        s.start(null);
        return () => s.stop();
    }, []);

    // 화면에 보이는 세션만 상세 stream 구독
    useEffect(() => {
        if (!layout) return;
        const visible = L.leaves(layout.root)
            .map((leaf) => leaf.tabs.find((t) => t.id === leaf.active_tab))
            .filter((t): t is L.Tab => !!t && t.kind === "session" && !!t.resource_id)
            .map((t) => t.resource_id!);
        stream.current?.setSessions(visible);
    }, [layout]);

    // 기기별 배치 복원: 서버 → 로컬 사본 → 빈 배치
    useEffect(() => {
        let alive = true;
        setLayout(null);
        void (async () => {
            let restored: L.Layout | null = null;
            try {
                const r = await api.get<{ layout: unknown; revision: number }>(`/layouts/${key}`);
                revision.current = r.revision;
                if (L.isValid(r.layout)) restored = r.layout;
            } catch {
                /* 오프라인이면 로컬 사본 */
            }
            if (!restored) {
                try {
                    const local = JSON.parse(localStorage.getItem(LOCAL_LAYOUT + key) ?? "null");
                    if (L.isValid(local)) restored = local;
                } catch {
                    /* 손상된 사본 무시 */
                }
            }
            if (alive) setLayout(restored ?? L.emptyLayout());
        })();
        return () => {
            alive = false;
        };
    }, [key]);

    const persist = useCallback(
        (next: L.Layout) => {
            localStorage.setItem(LOCAL_LAYOUT + key, JSON.stringify(next));
            if (saveTimer.current) clearTimeout(saveTimer.current);
            saveTimer.current = setTimeout(async () => {
                const put = () => api.put<{ revision: number }>(`/layouts/${key}`, { expected_revision: revision.current, layout: next });
                try {
                    revision.current = (await put()).revision;
                } catch (e) {
                    if (e instanceof ApiError && e.code === "revision_conflict") {
                        // 같은 기기의 다른 창이 바꿨다: 이 창의 배치를 최신 revision 위에 저장한다(기기 UI 상태, 마지막 저장 우선).
                        const cur = (e.details as { current?: { revision?: number } })?.current;
                        revision.current = cur?.revision ?? revision.current;
                        try {
                            revision.current = (await put()).revision;
                            setNotice("다른 창에서 바뀐 배치를 이 창의 배치로 덮어썼습니다");
                        } catch {
                            setNotice("배치를 서버에 저장하지 못했습니다(이 기기에는 보존)");
                        }
                    } else {
                        setNotice("배치를 서버에 저장하지 못했습니다(이 기기에는 보존)");
                    }
                }
            }, 500);
        },
        [key],
    );

    const update = useCallback(
        (f: (l: L.Layout) => L.Layout) => {
            setLayout((cur) => {
                if (!cur) return cur;
                const next = f(cur);
                if (next !== cur) persist(next);
                return next;
            });
        },
        [persist],
    );

    const open: Opener = useCallback(
        (t, how = "here") => {
            update((l) => {
                const leaf = L.focusedLeaf(l);
                if (how === "here" || narrow) return L.openTab(l, leaf.id, t);
                return L.splitLeaf(l, leaf.id, how === "right" ? "row" : "column", t);
            });
            if (narrow) setSidebar(false);
        },
        [update, narrow],
    );

    const [adding, setAdding] = useState(false);
    const projectAdded = (p: Project) => {
        setAdding(false);
        projects.reload();
        open({ kind: "project", project_id: p.id, resource_id: p.id, title: p.name });
    };

    return (
        <div className={`ws ${narrow ? "narrow" : ""}`}>
            <header className="topbar">
                <button className="ghost icon" aria-label="사이드바" aria-expanded={sidebar} onClick={() => setSidebar((s) => !s)}>
                    ☰
                </button>
                <img src="/icon.svg" alt="" width={22} height={22} />
                <strong>Grove</strong>
                <ConnStatus status={live.status} retryAt={live.retryAt} onRetry={() => stream.current?.retryNow()} />
                <span className="spacer" />
                <button className="ghost" onClick={() => setAdding(true)}>
                    + 프로젝트
                </button>
                <button className="ghost" onClick={() => open({ kind: "settings", title: "설정" })}>
                    설정
                </button>
            </header>
            {adding && <AddProjectDialog onDone={projectAdded} onClose={() => setAdding(false)} />}
            {notice && (
                <div className="notice" role="status">
                    {notice} <button className="ghost" onClick={() => setNotice(null)}>닫기</button>
                </div>
            )}
            <div className="body">
                {sidebar && (
                    <aside className="sidebar">
                        <NotificationsPanel open={open} />
                        <BotsPanel open={open} />
                        <SearchPanel open={open} />
                        <RecentPanel open={open} />
                        <section className="projects">
                            <h2>
                                프로젝트{" "}
                                <select
                                    className="small"
                                    aria-label="프로젝트 정렬"
                                    value={projectSort}
                                    onChange={(e) => {
                                        const v = e.target.value === "recent" ? "recent" : "name";
                                        localStorage.setItem(PROJECT_SORT, v);
                                        setProjectSort(v);
                                    }}
                                >
                                    <option value="name">이름순</option>
                                    <option value="recent">최근 활동순</option>
                                </select>
                            </h2>
                            {(projects.data ?? []).map((p) => (
                                <div key={p.id} className="row" data-testid="project-row">
                                    <button className="link" onClick={() => open({ kind: "project", project_id: p.id, resource_id: p.id, title: p.name })} title={p.root_path}>
                                        {p.icon && <span className="project-icon" aria-hidden>{p.icon}</span>} {p.name} {!p.available && <em className="warn">(경로 없음)</em>}
                                    </button>
                                    {!narrow && (
                                        <span className="row-actions">
                                            <button className="ghost small" title="오른쪽에 열기" onClick={() => open({ kind: "project", project_id: p.id, resource_id: p.id, title: p.name }, "right")}>
                                                ⇥
                                            </button>
                                            <button className="ghost small" title="아래에 열기" onClick={() => open({ kind: "project", project_id: p.id, resource_id: p.id, title: p.name }, "down")}>
                                                ⤓
                                            </button>
                                        </span>
                                    )}
                                </div>
                            ))}
                            {projects.data?.length === 0 && <p className="muted">프로젝트를 추가하세요.</p>}
                        </section>
                    </aside>
                )}
                <main className="main">
                    {layout ? <SplitView layout={layout} update={update} open={open} narrow={narrow} projects={projects.data ?? []} /> : <div className="boot">배치 불러오는 중…</div>}
                </main>
            </div>
        </div>
    );
}

/// 서버 연결 상태(UI-027). 끊기면 네트워크 문제인지 서버 문제인지와 다음 재시도까지 남은 시간을 보이고, 바로 재시도할 수 있다.
function ConnStatus({ status, retryAt, onRetry }: { status: string; retryAt?: number; onRetry: () => void }) {
    const [now, setNow] = useState(Date.now());
    const [online, setOnline] = useState(typeof navigator === "undefined" ? true : navigator.onLine);
    useEffect(() => {
        const on = () => setOnline(navigator.onLine);
        window.addEventListener("online", on);
        window.addEventListener("offline", on);
        return () => {
            window.removeEventListener("online", on);
            window.removeEventListener("offline", on);
        };
    }, []);
    useEffect(() => {
        if (status !== "offline") return;
        const t = setInterval(() => setNow(Date.now()), 1000);
        return () => clearInterval(t);
    }, [status]);
    const left = retryAt ? Math.max(0, Math.ceil((retryAt - now) / 1000)) : 0;
    const label =
        status === "live"
            ? "연결됨"
            : status === "connecting"
              ? "연결 중"
              : status === "reconnecting"
                ? "재연결 중"
                : status === "auth_expired"
                  ? "로그인 만료"
                  : !online
                    ? "오프라인 · 네트워크 없음"
                    : `서버 연결 끊김 · ${left}초 후 재시도`;
    return (
        <span className={`conn ${status}`} title="서버 연결 상태" data-testid="conn" role="status">
            {label}
            {status === "offline" && (
                <button className="ghost small" onClick={onRetry}>
                    지금 재연결
                </button>
            )}
        </span>
    );
}
