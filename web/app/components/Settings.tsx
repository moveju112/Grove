import { useCallback, useEffect, useMemo, useState } from "react";
import { ActionMenu, DetailDialog } from "./ui/Controls";
import { HelpTip } from "./HelpTip";
import { ApiError, PROTOCOL, api, logout } from "../api/client";
import { ServerActionButton } from "./pwa/ServerActionButton";
import type { Definition, DefinitionDetail, DeviceInfo, ModelProfile, SecretInfo } from "../api/generated";
import { type Prefs, defaultPrefs, savePrefs, usePrefs } from "../state/device";
import { When } from "./When";
import { notificationPermission, showAttention } from "../state/attention";
import { MAX_RECENT_WINDOWS, normalizeRecentWindows, RECENT_WINDOW_OPTIONS, recentWindowLabel } from "../state/recentWindow";
import { useLive, useQuery } from "../state/store";
import { type SettingDef, type SettingsTarget, ScopedSettings } from "./ScopedSettings";
import { UsagePanel } from "./UsagePanel";
import { Pairings } from "./Pairing";
import { Hosts } from "./Hosts";
import { ProfileCatalog } from "./ProfileCatalog";
import { LocalModelConnection } from "./local-models/LocalModelConnection";
import { ProfileCapabilities } from "./ProfileCapabilities";
import { ProfileContextPolicy } from "./ProfileContextPolicy";
import { ProfileFallback } from "./ProfileFallback";
import { Memories } from "./Memories";
import { useCapability } from "../state/capabilities";
import { DeviceSettingsReset } from "./SettingsReset";
import { McpServers } from "./McpServers";
import { DiagnosticsBundle } from "./DiagnosticsBundle";
import { SourceSettings } from "./source-settings/SourceSettings";
import { TurnTimingSetting } from "./turn-timing/TurnTimingSetting";
import { HooksSettings } from "./hooks/HooksSettings";
import { ExecSettings } from "./exec-settings/ExecSettings";
import { isExecSetting } from "../api/execSettings";
import { BrowserCapabilitiesSettings, currentNotificationIssue, useBrowserCapabilities } from "./capabilities/BrowserCapabilities";
import { requestNotificationAccess } from "./capabilities/browser";
import { UpdateSettings } from "./update/UpdateSettings";
import { settingLinkKey } from "./settings-links/reveal";
import { useSettingsLink } from "./settings-links/useSettingsLink";
import { DefinitionUpdates } from "./definition-updates/DefinitionUpdates";
import { useDefinitionDraft } from "./definition-updates/useDefinitionDraft";
import { useExecLinkLayout } from "./settings-links/useExecLinkLayout";
import { AgentOverview } from "./agent-overview/AgentOverview";
import { BotsPanel } from "./BotsPanel";
import { AgentConnect } from "./AgentConnect";
import type { Opener } from "./Workspace";
import { SettingsGroup } from "./SettingsGroup";
import { Icon, type IconName } from "./icons";
import { Button } from "../design/Button";
import { Stack } from "@astryxdesign/core/Stack";
import { Heading, Text } from "@astryxdesign/core/Text";
import { List, ListItem } from "@astryxdesign/core/List";
import { TextInput, TextArea } from "../design/Fields";
import { Slider } from "@astryxdesign/core/Slider";
import { Select } from "../design/Select";
import { BooleanSelect } from "./BooleanSelect";

// 설정 registry(CONFIG-001): 메뉴·이름·검색어·적용 범위. 검색은 이 표를 기준으로 한다.
type Item = { id: string; menu: Menu; label: string; keywords: string; scope: "이 기기" | "서버 전체" | "전역·프로젝트" };
type Menu = "model" | "agents" | "display" | "devices" | "server";
const MENUS: [Menu, string][] = [
    ["model", "모델·키"],
    ["agents", "에이전트·워크플로우"],
    ["display", "화면·입력"],
    ["devices", "기기·연결"],
    ["server", "서버·데이터"],
];
export const ITEMS: Item[] = [
    { id: "bots", menu: "agents", label: "봇", keywords: "bot persona 봇", scope: "서버 전체" },
    { id: "secrets", menu: "model", label: "API 키", keywords: "key secret 비밀 openai anthropic gemini", scope: "서버 전체" },
    { id: "profiles", menu: "model", label: "모델 프로필", keywords: "model provider endpoint url 모델 timeout temperature max_tokens", scope: "서버 전체" },
    { id: "definitions", menu: "agents", label: "에이전트·워크플로우 편집", keywords: "agent workflow prompt 지침 기본값 복원 비교", scope: "서버 전체" },
    { id: "source-settings", menu: "agents", label: "원본 Claude/Codex 설정", keywords: "원본 출처 읽기 전용 claude codex source settings", scope: "전역·프로젝트" },
    { id: "memories", menu: "agents", label: "확인한 장기 기억", keywords: "memory preference 기억 선호 제약 전역 프로젝트", scope: "전역·프로젝트" },
    { id: "mcp", menu: "agents", label: "MCP 서버", keywords: "mcp transport stdio http sse 도구 연결 secret", scope: "서버 전체" },
    { id: "hooks", menu: "agents", label: "hook 설정", keywords: "hook 훅 이벤트 matcher 명령 활성화", scope: "전역·프로젝트" },
    { id: "exec-settings", menu: "agents", label: "셸·자원 한도·격리·작업 위치", keywords: "exec shell limits isolation cwd bash sh cpu memory 셸 자원 한도 격리 기본 작업 위치 대화", scope: "전역·프로젝트" },
    { id: "theme", menu: "display", label: "테마", keywords: "dark light 다크 라이트 색", scope: "이 기기" },
    { id: "font", menu: "display", label: "글자 크기", keywords: "font size 글꼴", scope: "이 기기" },
    { id: "enter", menu: "display", label: "Enter로 보내기", keywords: "enter send 입력 단축키", scope: "이 기기" },
    { id: "recent", menu: "display", label: "최근 항목 시간 범위", keywords: "recent window 최근 범위 분 시간 오늘", scope: "이 기기" },
    { id: "notify", menu: "display", label: "알림·소리", keywords: "notification alert sound 알림 소리 완료 승인 예약 업데이트", scope: "이 기기" },
    { id: "time", menu: "display", label: "시간 표시", keywords: "time clock 24 12 시계 시각 상대 날짜 턴 경과 소요 대기", scope: "이 기기" },
    { id: "transcript", menu: "display", label: "대화 표시", keywords: "reasoning 생각 thinking answer only 답만 도구 세부 펼침", scope: "이 기기" },
    { id: "devices", menu: "devices", label: "등록 기기", keywords: "device token pair 기기 토큰 페어링 폐기 분실", scope: "서버 전체" },
    { id: "browser-capabilities", menu: "devices", label: "브라우저 기능·권한", keywords: "이 기기 browser notification clipboard 알림 복사 붙여넣기 파일 첨부 드래그 HTTPS 보안 권한", scope: "이 기기" },
    { id: "logout", menu: "devices", label: "로그아웃", keywords: "logout sign out", scope: "이 기기" },
    { id: "usage", menu: "model", label: "사용량·비용", keywords: "usage cost token price 사용량 비용 토큰 가격", scope: "서버 전체" },
    { id: "health", menu: "server", label: "서버 상태·버전·진단", keywords: "version health schema diagnostics 버전 상태 진단 정보 복사", scope: "서버 전체" },
    { id: "server-update", menu: "server", label: "서버 업데이트", keywords: "update stable beta channel protocol schema 버전 채널 확인 자동 적용", scope: "서버 전체" },
    { id: "help", menu: "server", label: "도움말", keywords: "help shortcut 도움말 단축키 사용법", scope: "이 기기" },
    { id: "backup", menu: "server", label: "백업·복원", keywords: "backup snapshot restore 백업 복원", scope: "서버 전체" },
];

export function Settings({ projectId, projectName, sessionId, open }: { projectId?: string; projectName?: string; sessionId?: string; open: Opener }) {
    const [menu, setMenu] = useState<Menu>(projectId ? "agents" : "model");
    const [q, setQ] = useState("");
    const [showAdvanced, setShowAdvanced] = useState(false);
    const registry = useQuery<SettingDef[]>("settings-registry", () => api.get("/settings/registry"));
    const session = useQuery<{ title: string } | null>(`session:${sessionId ?? "-"}`, () => (sessionId ? api.get(`/sessions/${sessionId}`) : Promise.resolve(null)));
    const target: SettingsTarget = { projectId, projectName, sessionId, sessionTitle: session.data?.title };
    const memoriesSupported = useCapability("user_memories_v1");
    const mcpSupported = useCapability("mcp_settings_v1");

    // 직접 링크(#setting-<key>): 해당 메뉴를 열고 고급 항목이면 펼친 뒤 그 항목으로 이동한다(SETTINGS-021).
    const prepareLink = useCallback((d: SettingDef) => {
        if (!MENUS.some(([id]) => id === d.menu)) return false;
        setQ("");
        setMenu(d.menu as Menu);
        if (d.advanced) setShowAdvanced(true);
        return true;
    }, []);
    const link = useSettingsLink(registry, JSON.stringify([projectId, sessionId]), prepareLink);
    const execLink = Boolean(link.key && (registry.data ?? []).some((definition) => definition.key === link.key && isExecSetting(definition)));
    const execLayoutReady = useExecLinkLayout(execLink, projectId, mcpSupported);
    const overviewTargetKey = JSON.stringify([projectId ?? null, sessionId ?? null]);
    const [readyOverviewTarget, setReadyOverviewTarget] = useState<string | null>(null);
    const onOverviewLayoutChange = useCallback((ready: boolean) => {
        setReadyOverviewTarget(ready ? overviewTargetKey : null);
    }, [overviewTargetKey]);
    const onLinkReady = useCallback((key: string, element: HTMLElement | null) => {
        if (element && execLink && (!execLayoutReady || (menu === "agents" && readyOverviewTarget !== overviewTargetKey))) return;
        link.ready(key, element);
    }, [execLink, execLayoutReady, menu, readyOverviewTarget, overviewTargetKey, link.ready]);
    const needle = q.trim().toLowerCase();
    const results = useMemo(() => (needle ? ITEMS.filter((i) => (i.id !== "memories" || memoriesSupported !== false)
        && (i.id !== "mcp" || mcpSupported !== false)
        && (i.label + " " + i.keywords).toLowerCase().includes(needle)) : null), [needle, memoriesSupported, mcpSupported]);
    const serverDefs = (registry.data ?? []).filter((d) =>
        needle ? (d.label + " " + d.keywords + " " + d.description).toLowerCase().includes(needle) : d.menu === menu && (showAdvanced || !d.advanced),
    );
    const hiddenAdvanced = !needle ? (registry.data ?? []).filter((d) => d.menu === menu && d.advanced).length : 0;
    const visible = (id: string) => (results ? results.some((r) => r.id === id) : ITEMS.find((i) => i.id === id)?.menu === menu);
    const total = (results?.length ?? 0) + (needle ? serverDefs.length : 0);
    return (
        <Stack className="settings" ref={link.root}
            onWheelCapture={link.cancel} onTouchMoveCapture={link.cancel}
            onKeyDownCapture={link.cancel} onPointerDownCapture={link.cancel}
            onClick={(event) => {
                if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
                const anchor = (event.target as Element).closest<HTMLAnchorElement>("a");
                if (!anchor || !event.currentTarget.contains(anchor)) return;
                const key = settingLinkKey(anchor.getAttribute("href") ?? "");
                if (!key) return;
                event.preventDefault();
                history.replaceState(history.state, "", anchor.getAttribute("href")!);
                link.open(key);
            }}>
            <Stack as="nav" className="settings-nav" aria-label="설정 메뉴">
                <TextInput type="search" label="설정 검색" isLabelHidden placeholder="설정 검색" value={q}
                    onChange={(value) => { link.cancel(); setQ(value); }} containerClassName="settings-search" />
                <Stack className="settings-menu">
                {MENUS.map(([m, label]) => (
                    <Button key={m} aria-current={!results && menu === m ? "page" : undefined} className={!results && menu === m ? "settings-menu-item on" : "settings-menu-item"} onClick={() => { link.cancel(); setQ(""); setMenu(m); }}>
                        {label}
                    </Button>
                ))}
                </Stack>
                {sessionId ? (
                    <Text as="p" display="block" type="supporting" color="secondary" data-testid="settings-origin">
                        대화 · {session.data?.title ?? sessionId} ({projectName ?? projectId})
                    </Text>
                ) : (
                    projectId && <Text as="p" display="block" type="supporting" color="secondary" data-testid="settings-origin">프로젝트 · {projectName ?? projectId}</Text>
                )}
            </Stack>
            <Stack className="settings-body">
                <Heading level={1} color="inherit" className="settings-heading">{needle ? "검색 결과" : MENUS.find(([id]) => id === menu)?.[1]}</Heading>
                {link.pending && <Text as="p" display="block" type="inherit" color="secondary" role="status">링크한 설정을 불러오는 중…</Text>}
                {link.error && <Text as="p" display="block" type="inherit" color="error" role="alert">{link.error}</Text>}
                {needle && <Text as="p" display="block" type="inherit" color="secondary">검색 결과 {total}개{total === 0 && " — 다른 낱말로 찾아보세요"}</Text>}
                {serverDefs.filter((d) => !isExecSetting(d)).length > 0 && <ScopedSettings grouped defs={serverDefs.filter((d) => !isExecSetting(d))} target={target}
                    linkedKey={link.key} onLinkReady={onLinkReady}
                    resetDefs={!needle ? (registry.data ?? []).filter((d) => d.menu === menu) : undefined} area={MENUS.find(([id]) => id === menu)?.[1]} />}
                {hiddenAdvanced > 0 && !showAdvanced && (
                    <Button className="ghost" onClick={() => setShowAdvanced(true)}>고급 항목 {hiddenAdvanced}개 펼치기</Button>
                )}
                {visible("secrets") && <Section item="secrets"><Secrets /></Section>}
                {visible("profiles") && <Section item="profiles"><Profiles /></Section>}
                {visible("definitions") && <Section item="definitions"><Definitions target={target} onOverviewLayoutChange={onOverviewLayoutChange} /></Section>}
                {visible("source-settings") && <Section item="source-settings"><SourceSettings projectId={projectId} /></Section>}
                {visible("mcp") && mcpSupported !== false && <Section item="mcp"><McpServers /></Section>}
                {visible("hooks") && <Section item="hooks"><HooksSettings projectId={projectId} projectName={projectName} /></Section>}
                {(visible("exec-settings") || serverDefs.some(isExecSetting)) && <Section item="exec-settings"><ExecSettings
                    linkedKey={link.key} onLinkReady={onLinkReady}
                    defs={(needle && visible("exec-settings") ? registry.data ?? [] : serverDefs).filter(isExecSetting)} target={target} /></Section>}
                {visible("memories") && memoriesSupported !== false && <Section item="memories"><Memories projectId={projectId} projectName={projectName} sessionId={sessionId} /></Section>}
                {(["theme", "font", "enter", "recent", "notify", "time", "transcript"] as const).some(visible) && <DisplayPrefs show={visible} />}
                {visible("bots") && <Section item="bots"><BotsPanel open={open} /></Section>}
                {visible("devices") && <Devices />}
                {visible("browser-capabilities") && <Section item="browser-capabilities"><BrowserCapabilitiesSettings /></Section>}
                {visible("help") && <Section item="help"><Help /></Section>}
                {visible("logout") && <Section item="logout"><ServerActionButton onClick={() => void logout()}>이 브라우저에서 로그아웃</ServerActionButton></Section>}
                {visible("usage") && <UsagePanel />}
                {visible("health") && <Section item="health"><Health /></Section>}
                {visible("server-update") && <Section item="server-update"><UpdateSettings /></Section>}
                {visible("backup") && (
                    <Section item="backup">
                        <dl>
                            <dt>백업</dt><dd><code>grove snapshot &lt;파일&gt;</code></dd>
                            <dt>복원</dt><dd><code>grove restore &lt;파일&gt; &lt;새 데이터 디렉터리&gt;</code></dd>
                        </dl>
                    </Section>
                )}
            </Stack>
        </Stack>
    );
}

const GROUP_ICONS: Record<string, IconName> = {
    devices: "monitor", "browser-capabilities": "shield", logout: "user",
    profiles: "server", definitions: "edit", "source-settings": "edit",
    mcp: "link", hooks: "settings", notify: "bell", health: "server", backup: "server",
};

function Section({ item, children }: { item: string; children: React.ReactNode }) {
    const it = ITEMS.find((i) => i.id === item)!;
    return (
        <SettingsGroup title={it.label} scope={it.scope} icon={GROUP_ICONS[item]}
            id={`setting-${item}`} testId={`setting-${item}`}>
            {children}
        </SettingsGroup>
    );
}

function useSave() {
    const [state, setState] = useState<{ kind: "idle" | "saving" | "saved" | "error"; msg?: string }>({ kind: "idle" });
    const run = async (f: () => Promise<unknown>) => {
        setState({ kind: "saving" });
        try {
            await f();
            setState({ kind: "saved" });
        } catch (e) {
            setState({ kind: "error", msg: e instanceof ApiError ? e.message : "저장 실패" });
        }
    };
    const view =
        state.kind === "idle" ? null : (
            <Text as="span" type="inherit" color="inherit" className={`save-state ${state.kind}`} role="status">
                {state.kind === "saving" ? "저장 중…" : state.kind === "saved" ? "저장됨" : `저장 실패(기존 값 유지): ${state.msg}`}
            </Text>
        );
    return { run, view };
}

function DisplayPrefs({ show }: { show: (id: string) => boolean }) {
    const p = usePrefs();
    const set = (n: Prefs) => {
        savePrefs(n);
    };
    return (
        <>
            {show("theme") && (
                <Section item="theme">
                    <Select label="테마" hideLabel value={p.theme}
                        onChange={(value) => set({ ...p, theme: value as Prefs["theme"] })}
                        options={[{ value: "system", label: "시스템" }, { value: "light", label: "밝게" },
                            { value: "dark", label: "어둡게" }, { value: "soft", label: "부드럽게(soft)" }]} />
                    <DeviceSettingsReset fields={["theme"]} label="테마 기본값 복원" />
                </Section>
            )}
            {show("font") && (
                <Section item="font">
                    <Slider label="글자 크기" isLabelHidden min={12} max={20} value={p.fontSize}
                        onChange={(value: number) => set({ ...p, fontSize: value })} formatValue={(value) => `${value}px`} valueDisplay="text" />
                    <DeviceSettingsReset fields={["fontSize"]} label="글자 크기 기본값 복원" />
                </Section>
            )}
            {show("enter") && (
                <Section item="enter">
                    <BooleanSelect label="Enter로 보내기"
                        value={p.enterToSend} onChange={(value) => set({ ...p, enterToSend: value })}
                        help="Shift+Enter는 줄바꿈에 사용합니다. 터치 키보드의 Enter는 항상 줄바꿈입니다." />
                    <DeviceSettingsReset fields={["enterToSend"]} label="입력 기본값 복원" />
                </Section>
            )}
            {show("recent") && (
                <Section item="recent">
                    <fieldset>
                        <legend className="small">최근 목록 위에 보일 범위(최대 {MAX_RECENT_WINDOWS}개)</legend>
                        {Array.from({ length: MAX_RECENT_WINDOWS }, (_, index) => <Select key={index}
                            label={`최근 시간 범위 ${index + 1}`} value={p.recentWindows[index] ?? ""}
                            onChange={(value) => set({ ...p, recentWindows: normalizeRecentWindows([
                                ...p.recentWindows.filter((_, i) => i !== index), value,
                            ]) })}
                            options={[{ value: "", label: "선택 안 함", disabled: p.recentWindows.length === 1 && index === 0 },
                                ...RECENT_WINDOW_OPTIONS.map((option) => ({ value: option, label: recentWindowLabel(option),
                                    disabled: p.recentWindows.includes(option) && p.recentWindows[index] !== option }))]} />)}
                    </fieldset>
                    <DeviceSettingsReset fields={["recentWindows", "recentWindow"]} label="최근 범위 기본값 복원" />
                </Section>
            )}
            {show("notify") && (
                <Section item="notify">
                    <NotifyPrefs prefs={p} set={set} />
                </Section>
            )}
            {show("time") && (
                <Section item="time">
                    <Select label="시계 형식" value={p.clock}
                        onChange={(value) => set({ ...p, clock: value as Prefs["clock"] })}
                        options={[{ value: "system", label: "시스템" }, { value: "24h", label: "24시간" },
                            { value: "12h", label: "12시간(오전/오후)" }]} />
                    <Select label="지난 시각 표시" value={p.timeStyle}
                        onChange={(value) => set({ ...p, timeStyle: value as Prefs["timeStyle"] })}
                        options={[{ value: "absolute", label: "날짜·시각" }, { value: "relative", label: "상대 시간(7일 이내)" }]} />
                    <DeviceSettingsReset fields={["clock", "timeStyle"]} label="시간 표시 기본값 복원" />
                    <TurnTimingSetting />
                </Section>
            )}
            {show("transcript") && (
                <Section item="transcript">
                    <Select label="생각 과정 표시" value={p.reasoning}
                        onChange={(value) => set({ ...p, reasoning: value as Prefs["reasoning"] })}
                        options={[{ value: "collapsed", label: "상세 버튼으로 보기" },
                            { value: "expanded", label: "본문에 표시" }, { value: "hidden", label: "숨김" }]} />
                    <BooleanSelect label="답만 보기"
                        value={p.answerOnly} onChange={(value) => set({ ...p, answerOnly: value })}
                        help="도구·실행 기록은 숨기지만 승인 요청은 항상 표시합니다." />
                    <BooleanSelect label="도구 실행 세부를 펼쳐서 표시"
                        value={p.expandTools} onChange={(value) => set({ ...p, expandTools: value })} />
                    <DeviceSettingsReset fields={["reasoning", "answerOnly", "expandTools"]} label="대화 표시 기본값 복원" />
                </Section>
            )}
            <Stack align="start" className="settings-footer">
                <DeviceSettingsReset compact={false} fields={Object.keys(defaultPrefs) as (keyof Prefs)[]} label="이 기기 화면·입력 전체 복원" />
            </Stack>
        </>
    );
}

const PERMISSION_LABEL: Record<NotificationPermission | "unsupported", string> = {
    granted: "허용됨",
    default: "아직 묻지 않음",
    denied: "브라우저에서 차단됨(브라우저 사이트 설정에서 바꿀 수 있습니다)",
    unsupported: "이 브라우저는 알림을 지원하지 않습니다",
};

function NotifyPrefs({ prefs: p, set }: { prefs: Prefs; set: (n: Prefs) => void }) {
    const [permission, setPermission] = useState(notificationPermission);
    const [capabilities, refresh] = useBrowserCapabilities();
    const [requestError, setRequestError] = useState<string | null>(null);
    const notificationIssue = currentNotificationIssue(capabilities);
    useEffect(() => { setPermission(notificationPermission()); }, [capabilities]);
    useEffect(() => { setRequestError(null); }, [permission]);
    const request = async () => {
        const result = await requestNotificationAccess();
        if (result.permission) setPermission(result.permission);
        setRequestError(result.message ?? null);
        refresh();
    };
    const [testSent, setTestSent] = useState(false);
    // 알림 종류를 켜면 그때 브라우저 권한을 묻는다. 거부돼도 소리 설정은 따로 쓸 수 있다.
    const toggle = async (key: "notifyDone" | "notifyApproval" | "notifyServer", on: boolean) => {
        set({ ...p, [key]: on });
        if (on) await request();
    };
    const kinds = [
        ["notifyDone", "작업 완료·실패"],
        ["notifyApproval", "승인 요청"],
        ["notifyServer", "예약·업데이트 알림"],
    ] as const;
    return (
        <>
            {kinds.map(([key, label]) => (
                <BooleanSelect key={key} label={label} value={p[key]} onChange={(value) => void toggle(key, value)} />
            ))}
            <Text as="span" type="inherit" color="inherit" className="scope">앱 실행 중에만</Text>
            <BooleanSelect label="알림 소리" value={p.notifySound} onChange={(value) => set({ ...p, notifySound: value })} />
            <Text as="p" display="block" type="supporting" color="inherit" data-testid="notify-permission">브라우저 알림 권한: {capabilities && !capabilities.secureContext ? "보안 컨텍스트 필요(HTTPS·localhost)" : PERMISSION_LABEL[permission]}</Text>
            {(p.notifyDone || p.notifyApproval || p.notifyServer) && permission !== "granted" && (
                <Text as="p" display="block" type="supporting" color="warning" role="status">브라우저 권한이 없어 화면 알림은 표시되지 않습니다{p.notifySound ? ". 소리만 재생합니다." : "."}</Text>
            )}
            {(requestError || notificationIssue) && <Text as="p" display="block" type="supporting" color="warning" role="status">{requestError || notificationIssue}</Text>}
            {permission === "default" && <Button className="ghost small" onClick={() => void request()}>브라우저 알림 허용</Button>}
            <Button
                className="ghost small"
                onClick={() => {
                    showAttention({ kind: "server", tag: `test:${Date.now()}`, title: "Grove 알림 시험", body: "이 기기의 알림이 동작합니다.", projectId: null, sessionId: null }, p.notifySound);
                    setTestSent(true);
                }}
            >
                시험 알림 보내기
            </Button>
            {testSent && <Text as="span" type="supporting" color="secondary" role="status"> 보냈습니다{permission === "granted" ? "" : "(권한이 없어 화면 알림은 생략)"}.</Text>}
            <DeviceSettingsReset fields={["notifyDone", "notifyApproval", "notifyServer", "notifySound"]} label="알림 기본값 복원" />
        </>
    );
}

function Secrets() {
    const list = useQuery<SecretInfo[]>("secrets", () => api.get("/secrets"));
    const [label, setLabel] = useState("");
    const [value, setValue] = useState("");
    const save = useSave();
    return (
        <>
            <List density="compact" edge="flush">
                {(list.data ?? []).map((s) => (
                    <ListItem key={s.id} label={<>
                        {s.label} <code>{s.masked}</code> {s.used_by.length > 0 && <Text as="span" type="supporting" color="secondary">사용: {s.used_by.join(", ")}</Text>}
                        <ServerActionButton className="ghost small" onClick={() => {
                            const v = prompt(`${s.label}의 새 키(이전 키는 저장 성공 후에만 교체)`);
                            if (v) void save.run(() => api.put(`/secrets/${s.id}`, { label: s.label, value: v }));
                        }}>교체</ServerActionButton>
                        <ServerActionButton className="ghost small" onClick={() => void save.run(() => api.del(`/secrets/${s.id}`))}>삭제</ServerActionButton>
                    </>} />
                ))}
            </List>
            <form className="inline" onSubmit={(e) => { e.preventDefault(); void save.run(async () => { await api.post("/secrets", { label, value }); setLabel(""); setValue(""); }); }}>
                <TextInput size="sm" placeholder="이름" value={label} onChange={setLabel} label="키 이름" isLabelHidden isRequired />
                <TextInput size="sm" placeholder="키 값" type="password" autoComplete="off" value={value} onChange={setValue} label="키 값" isLabelHidden isRequired />
                <ServerActionButton type="submit">추가</ServerActionButton>
            </form>
            {save.view}
        </>
    );
}

function Profiles() {
    const list = useQuery<ModelProfile[]>("profiles", () => api.get("/model-profiles"));
    const secrets = useQuery<SecretInfo[]>("secrets", () => api.get("/secrets"));
    const [f, setF] = useState({ name: "", protocol: "openai", base_url: "https://api.openai.com/v1", model: "", secret_id: "" });
    const save = useSave();
    const management = useCapability("model_management_v1");
    const [agentSetup, setAgentSetup] = useState(false);
    const presets: Record<string, string> = { openai: "https://api.openai.com/v1", anthropic: "https://api.anthropic.com", gemini: "https://generativelanguage.googleapis.com", claude_code: "", codex_cli: "" };
    // 서버에 설치된 CLI 백엔드는 endpoint·키가 없다(CLI가 자기 로그인을 쓴다). 저가형 기본 모델을 제안한다.
    const cliModels: Record<string, string> = { claude_code: "haiku", codex_cli: "gpt-6-luna" };
    const isCli = f.protocol === "claude_code" || f.protocol === "codex_cli";
    return (
        <>
            <DetailDialog label="CLI 에이전트 연결" title="CLI 에이전트 연결" onOpenChange={setAgentSetup}>
                {agentSetup && <AgentConnect disabled={false} onConnected={() => list.reload()} />}
            </DetailDialog>
            {management !== false && <LocalModelConnection secrets={secrets.data ?? []} onCreate={(body, key) =>
                api.post("/model-profiles", body, { key, requires: ["model_management_v1"] })
            } />}
            <List density="compact" edge="flush" className="profile-list">
                {(list.data ?? []).map((p) => (
                    <ListItem key={p.id} data-testid="model-profile" label={<>
                        <Stack direction="horizontal" align="center" className="profile-heading">
                            <Stack className="profile-identity"><strong>{p.name}</strong><code>{p.model}</code></Stack>
                            {p.enabled === false && <Text as="span" type="supporting" color="warning"> · 비활성</Text>}
                            <HelpTip label={`${p.name} 연결 정보`}>
                                <Text as="span" type="inherit" color="inherit">{p.protocol}{p.base_url ? ` · ${p.base_url}` : " · 서버 CLI 계정 · 읽기 전용"}</Text>
                            </HelpTip>
                            <ActionMenu label={`${p.name} 관리`}>
                                <ServerActionButton className="ghost small" onClick={() => {
                                    const m = prompt("모델 이름", p.model);
                                    if (m && m !== p.model) void save.run(() => api.put(`/model-profiles/${p.id}`, { expected_revision: p.revision, model: m }));
                                }}>모델 변경</ServerActionButton>
                                <ServerActionButton className="ghost small" onClick={() => void save.run(() => api.del(`/model-profiles/${p.id}`))}>삭제</ServerActionButton>
                                <ServerActionButton className="ghost small" onClick={() => void save.run(() => api.post(`/model-profiles/${p.id}/check`))}>연결 확인</ServerActionButton>
                                {management !== false && <ServerActionButton className="ghost small" onClick={() => void save.run(() =>
                                    api.put(`/model-profiles/${p.id}`, { expected_revision: p.revision, enabled: p.enabled === false }, { requires: ["model_management_v1"] })
                                )}>{p.enabled === false ? "활성화" : "비활성화"}</ServerActionButton>}
                            </ActionMenu>
                        </Stack>
                        {p.last_check?.ok === false && <CheckStatus c={p.last_check} />}
                        <details className="profile-details">
                            <summary>상세 설정</summary>
                            <Stack gap={2}>
                                <Text as="span" type="supporting" color="secondary">{p.protocol}{p.base_url && ` · ${p.base_url}`}</Text>
                                {p.last_check?.ok !== false && <CheckStatus c={p.last_check} />}
                                <ProfileCapabilities profile={p} />
                                <ProfileContextPolicy profile={p} />
                                <ProfileFallback profile={p} profiles={list.data ?? []} />
                                <ProfileCatalog profile={p} onChoose={(model, revision) => void save.run(() =>
                                    api.put(`/model-profiles/${p.id}`, { expected_revision: revision, model }, { requires: ["model_management_v1"] })
                                )} />
                            </Stack>
                        </details>
                    </>} />
                ))}
            </List>
            <details className="profile-details profile-create">
            <summary>모델 프로필 추가</summary>
            <form className="stack" aria-label="모델 프로필 추가" onSubmit={(e) => {
                e.preventDefault();
                void save.run(async () => {
                    await api.post("/model-profiles", { ...f, secret_id: f.secret_id || null });
                    setF({ ...f, name: "", model: "" });
                });
            }}>
                <TextInput size="sm" placeholder="이름" value={f.name} onChange={(value) => setF({ ...f, name: value })} label="프로필 이름" isLabelHidden isRequired />
                <Select
                    value={f.protocol}
                    label="protocol" hideLabel
                    onChange={(v) => {
                        setF({ ...f, protocol: v, base_url: presets[v] ?? f.base_url, model: cliModels[v] ?? f.model, secret_id: cliModels[v] ? "" : f.secret_id });
                    }}
                    options={[{ value: "openai", label: "OpenAI 호환" }, { value: "anthropic", label: "Anthropic" },
                        { value: "gemini", label: "Gemini" }, { value: "claude_code", label: "Claude Code(서버 설치 CLI)" },
                        { value: "codex_cli", label: "Codex(서버 설치 CLI)" }]} />
                {!isCli && <TextInput size="sm" placeholder="Base URL" value={f.base_url} onChange={(value) => setF({ ...f, base_url: value })} label="Base URL" isLabelHidden isRequired />}
                <TextInput size="sm" placeholder="모델" value={f.model} onChange={(value) => setF({ ...f, model: value })} label="모델" isLabelHidden isRequired />
                {!isCli && (
                    <Select value={f.secret_id} onChange={(value) => setF({ ...f, secret_id: value })} label="API 키" hideLabel
                        options={[{ value: "", label: "키 없음" }, ...(secrets.data ?? []).map((s) => ({ value: s.id, label: s.label }))]} />
                )}
                {isCli && (
                    <Text as="span" type="supporting" color="secondary" data-testid="cli-note">
                        서버 CLI 계정 · 읽기 전용
                    </Text>
                )}
                <ServerActionButton type="submit">추가</ServerActionButton>
            </form>
            </details>
            {save.view}
        </>
    );
}

function Definitions({ target, onOverviewLayoutChange }: {
    target: SettingsTarget; onOverviewLayoutChange: (ready: boolean) => void;
}) {
    const [kind, setKind] = useState<"agent" | "workflow">("agent");
    const [sel, setSel] = useState<string | null>(null);
    const list = useQuery<Definition[]>(`definitions:${kind}`, () => api.get(`/definitions?kind=${kind}`));
    return (
        <Stack className="defs">
            <AgentOverview target={target} onEdit={(id) => { setKind("agent"); setSel(id); }} onLayoutChange={onOverviewLayoutChange} />
            <Stack direction="horizontal" wrap="wrap" className="chips">
                <Button className={kind === "agent" ? "chip on" : "chip"} onClick={() => { setKind("agent"); setSel(null); }}>에이전트</Button>
                <Button className={kind === "workflow" ? "chip on" : "chip"} onClick={() => { setKind("workflow"); setSel(null); }}>워크플로우</Button>
            </Stack>
            <List density="compact" edge="flush" className="def-list">
                {(list.data ?? []).map((d) => (
                    <ListItem key={d.id} label={<>
                        <Button className={`link ${sel === d.id ? "on" : ""}`} onClick={() => setSel(d.id)}>
                            {d.name} {d.builtin ? <Text as="span" type="supporting" color="secondary">기본</Text> : <Text as="span" type="supporting" color="secondary">사용자</Text>}
                            {d.modified_fields.length > 0 && <Text as="span" type="inherit" color="inherit" className="status awaiting_approval">수정됨</Text>}
                            {!d.enabled && <Text as="span" type="supporting" color="secondary">(비활성)</Text>}
                        </Button>
                    </>} />
                ))}
            </List>
            {sel && <DefinitionEditor key={kind + sel} kind={kind} id={sel} />}
            <NewDefinition kind={kind} />
        </Stack>
    );
}

function DefinitionEditor({ kind, id }: { kind: string; id: string }) {
    const d = useQuery<DefinitionDetail>(`definitions:${kind}:${id}`, () => api.get(`/definitions/${kind}/${id}`));
    const local = useDefinitionDraft(kind, id);
    const [restoring, setRestoring] = useState(false);
    const [saving, setSaving] = useState(false);
    const save = useSave();
    if (!d.data) return null;
    const cur = d.data;
    const draft = local.draft?.text ?? cur.body;
    const changed = draft !== cur.body;
    const busy = restoring || saving;
    return (
        <Stack gap={2} className="def-editor" data-settings-unsaved={changed ? "true" : undefined}>
            <Heading level={3} color="inherit">{cur.name} <Text as="span" type="supporting" color="secondary">revision {cur.revision}</Text></Heading>
            <Text as="p" display="block" type="supporting" color="secondary">{cur.description}</Text>
            <TextArea value={draft} isDisabled={saving} onChange={(value) => local.write({
                text: value, baseRevision: local.draft?.baseRevision ?? cur.revision, updatedAt: Date.now(),
            })} rows={14} label="정의 본문" isLabelHidden />
            {local.error && <Text as="p" display="block" type="inherit" color="inherit" role="alert">{local.error}</Text>}
            {local.draft && local.draft.baseRevision !== cur.revision && <Text as="p" display="block" type="inherit" color="inherit" role="alert">서버 revision이 바뀌어 저장 시 충돌하니, 보존된 초안과 현재 적용값을 비교해.</Text>}
            <Stack direction="horizontal" wrap="wrap" className="actions">
                <ServerActionButton disabled={!changed || busy} onClick={() => void save.run(async () => {
                    setSaving(true);
                    try {
                        await api.put(`/definitions/${kind}/${id}`, { expected_revision: local.draft?.baseRevision ?? cur.revision, body: draft });
                        local.write(null);
                        d.reload();
                    } finally { setSaving(false); }
                })}>저장</ServerActionButton>
                <Button className="ghost" disabled={!local.draft || busy} onClick={() => local.write(null)}>편집 취소</Button>
                {!cur.builtin && (
                    <ServerActionButton className="ghost" disabled={busy} onClick={() => {
                        if (confirm("이 정의를 삭제할까요?")) void save.run(() => api.del(`/definitions/${kind}/${id}?expected_revision=${cur.revision}`));
                    }}>삭제</ServerActionButton>
                )}
                {kind === "workflow" && id !== "default" && (
                    <ServerActionButton className="ghost" disabled={busy} onClick={() => void save.run(async () => { await api.put(`/definitions/${kind}/${id}`, { expected_revision: cur.revision, enabled: !cur.enabled }); d.reload(); })}>
                        {cur.enabled ? "선택 불가로" : "선택 가능으로"}
                    </ServerActionButton>
                )}
            </Stack>
            {save.view}
            {cur.builtin && <DefinitionUpdates definition={cur} draft={local.draft?.text} disabled={saving} onLocked={setRestoring} onApplied={d.reload}
                onDraftReviewed={(reviewed) => {
                    if (local.draft) local.write({ ...local.draft, baseRevision: reviewed.revision, updatedAt: Date.now() });
                }} />}
        </Stack>
    );
}

function NewDefinition({ kind }: { kind: string }) {
    const [f, setF] = useState({ id: "", name: "", body: "" });
    const save = useSave();
    return (
        <DetailDialog label={`새 ${kind === "agent" ? "에이전트" : "워크플로우"}`} title={`새 ${kind === "agent" ? "에이전트" : "워크플로우"}`}>
            <form className="inline wrap" onSubmit={(e) => { e.preventDefault(); void save.run(async () => { await api.post(`/definitions/${kind}`, f); setF({ id: "", name: "", body: "" }); }); }}>
                <TextInput size="sm" placeholder="ID (소문자-하이픈)" value={f.id} onChange={(value) => setF({ ...f, id: value })} label="ID" isLabelHidden isRequired />
                <TextInput size="sm" placeholder="이름" value={f.name} onChange={(value) => setF({ ...f, name: value })} label="이름" isLabelHidden isRequired />
                <TextArea placeholder="본문" value={f.body} onChange={(value) => setF({ ...f, body: value })} label="본문" isLabelHidden isRequired />
                <ServerActionButton type="submit">만들기</ServerActionButton>
            </form>
            {save.view}
        </DetailDialog>
    );
}

function CurrentDeviceName({ onSaved }: { onSaved?: () => void }) {
    const query = useQuery<{ id: string; name: string }>("current-device", () => api.get("/auth/device"));
    const [draft, setDraft] = useState<string | null>(null);
    const save = useSave();
    return <form className="inline" onSubmit={(event) => {
        event.preventDefault();
        if (draft === null) return;
        void save.run(async () => {
            await api.put("/auth/device", { name: draft.trim() });
            setDraft(null); query.reload(); onSaved?.();
        });
    }}>
        <TextInput size="sm" label="이 기기 이름" value={draft ?? query.data?.name ?? ""}
            isDisabled={!query.data} isRequired onChange={setDraft} maxLength={80} />
        <ServerActionButton type="submit" disabled={draft === null || !draft.trim()}>이름 저장</ServerActionButton>
        {draft !== null && <Text as="span" type="supporting" color="secondary" data-settings-unsaved="true">저장 안 됨</Text>}
        {Boolean(query.error) && <Text as="p" display="block" type="inherit" color="error" role="alert">기기 이름을 읽지 못했습니다.</Text>}
        {save.view}
    </form>;
}

function Devices() {
    const list = useQuery<DeviceInfo[]>("devices", () => api.get("/devices"));
    const [issued, setIssued] = useState<string | null>(null);
    const save = useSave();
    const pairing = useCapability("pairing_approval_v1");
    if (list.error instanceof ApiError && list.error.code === "forbidden") return <Section item="devices"><CurrentDeviceName /></Section>;
    return (
        <>
            <Section item="devices">
            <Hosts />
            <CurrentDeviceName onSaved={list.reload} />
            {Boolean(list.error) && <Text as="p" display="block" type="inherit" color="error" role="alert">기기 목록을 읽지 못했습니다.</Text>}
            <Text as="p" display="block" type="supporting" color="secondary">등록 기기는 모든 프로젝트·파일 접근 및 명령 실행 가능 · 기기 관리는 소유자 전용</Text>
            <List density="compact" edge="flush" className="settings-list">
                {(list.data ?? []).filter((d) => d.kind !== "browser" || !d.revoked_at).map((d) => (
                    <ListItem key={d.id} label={<>
                        <Text as="span" type="inherit" color="inherit" className="settings-device">
                            <Icon name={d.kind === "owner" ? "server" : "monitor"} size={16} />
                            <Text as="span" type="inherit" color="inherit"><Text as="span" type="inherit" color="inherit">{d.name}{d.current && <Text as="span" type="inherit" color="inherit" className="settings-device-current">현재</Text>}</Text>
                                <Text as="span" type="inherit" color="inherit" className="settings-device-meta">{d.kind === "owner" ? "소유자" : d.kind === "device" ? "기기" : "브라우저 로그인"}
                                    {d.last_used_at && <> · <When at={d.last_used_at} /></>}
                                </Text>
                            </Text>
                        </Text>
                        {d.revoked_at ? <Text as="span" type="supporting" color="secondary">폐기됨</Text> : d.kind === "owner" ? <Text as="span" type="inherit" color="inherit" className="scope">소유자</Text> : (
                            <ServerActionButton className="ghost small" onClick={() => { if (confirm(`${d.name}의 접근을 폐기할까요? 연결·티켓은 차단하지만 이미 시작한 작업·터미널은 종료하지 않습니다.`)) void save.run(() => api.del(`/devices/${d.id}`)); }}>폐기</ServerActionButton>
                        )}
                    </>} />
                ))}
            </List>
            <ServerActionButton onClick={() => {
                const name = prompt("새 기기 이름");
                if (name) void save.run(async () => setIssued((await api.post<{ token: string }>("/devices", { name })).token));
            }}>기기 토큰 발급</ServerActionButton>
            {issued && (
                <Stack direction="horizontal" wrap="wrap" align="center" className="draft-note" role="alert">
                    이 토큰은 지금 한 번만 표시됩니다: <code className="selectable">{issued}</code>
                    <Button className="ghost small" onClick={() => setIssued(null)}>닫기</Button>
                </Stack>
            )}
            {save.view}
            </Section>
            {pairing !== false && <SettingsGroup title="QR·링크로 기기 등록" scope="서버 전체" icon="link" testId="setting-pairing">
                <Pairings showHeading={false} />
            </SettingsGroup>}
        </>
    );
}

/// 이 화면의 빌드 버전(service worker 자산 hash). 개발 서버·SW 없음이면 "dev".
async function webBuild(): Promise<string> {
    try {
        const t = await (await fetch("/sw.js", { cache: "no-store" })).text();
        return t.match(/const VERSION = "([^"]+)"/)?.[1] ?? "unknown";
    } catch {
        return "unknown";
    }
}

function Health() {
    const h = useQuery<Record<string, unknown>>("health", () => api.get("/health"));
    const build = useQuery<string>("web-build", webBuild);
    const status = useLive((live) => live.status);
    const [copied, setCopied] = useState<string | null>(null);
    // 진단 정보(UI-031): 버전·연결·브라우저만. 토큰·쿠키·대화 내용·경로 같은 민감 정보는 넣지 않는다.
    const diag = () => ({
        collected_at: new Date().toISOString(),
        server: { status: h.data?.status, version: h.data?.version, protocol: h.data?.protocol, schema: h.data?.schema, target: h.data?.target, db: h.data?.db },
        web: { build: build.data, protocol: PROTOCOL, protocol_matches: h.data?.protocol === PROTOCOL },
        connection: status,
        browser: navigator.userAgent,
        online: navigator.onLine,
        theme: document.documentElement.dataset.theme ?? "system",
        viewport: `${window.innerWidth}x${window.innerHeight}`,
    });
    return (
        <>
            <dl className="kv" data-testid="version-details">
                <dt>상태</dt><dd>{String(h.data?.status ?? "…")}</dd>
                <dt>서버 버전</dt><dd>{String(h.data?.version ?? "")}</dd>
                <dt>실행 대상</dt><dd>{String(h.data?.target ?? "")}</dd>
                <dt>프로토콜</dt><dd>서버 {String(h.data?.protocol ?? "")} · 화면 {PROTOCOL}{h.data && h.data.protocol !== PROTOCOL ? " (다름: 새로고침 필요)" : ""}</dd>
                <dt>DB schema</dt><dd>{String(h.data?.schema ?? "")}</dd>
                <dt>화면 빌드</dt><dd><code>{build.data ?? "…"}</code></dd>
                <dt>이벤트 연결</dt><dd>{status}</dd>
            </dl>
            <Button
                className="ghost small"
                onClick={() =>
                    void navigator.clipboard?.writeText(JSON.stringify(diag(), null, 2)).then(
                        () => setCopied("진단 정보를 복사했습니다(토큰·대화 내용은 포함하지 않음)"),
                        () => setCopied("복사하지 못했습니다"),
                    )
                }
            >
                진단 정보 복사
            </Button>
            {copied && <Text as="span" type="supporting" color="secondary" role="status"> {copied}</Text>}
            <DiagnosticsBundle />
        </>
    );
}

function Help() {
    return (
        <Stack className="help" data-testid="help">
            <Heading level={4} color="inherit">입력</Heading>
            <List density="compact" edge="flush" listStyle="disc">
                <ListItem label={<><kbd>Ctrl</kbd>/<kbd>⌘</kbd>+<kbd>Enter</kbd>: 보내기 · 'Enter로 보내기'를 켜면 <kbd>Enter</kbd> 보내기, <kbd>Shift</kbd>+<kbd>Enter</kbd> 줄바꿈(터치 기기는 항상 줄바꿈)</>} />
                <ListItem label={<>한글 조합 중 <kbd>Enter</kbd>는 보내지 않습니다.</>} />
                <ListItem label={<>실행 중에는 '대기열에 추가'(끝난 뒤 새 요청), '지금 반영'(다음 모델 호출에 추가), '중단하고 보내기'를 고릅니다.</>} />
            </List>
            <Heading level={4} color="inherit">상태</Heading>
            <List density="compact" edge="flush" listStyle="disc">
                <ListItem label={<>승인 대기: 파일 쓰기·명령 실행 등 승인이 필요한 도구가 기다립니다. 승인 전에는 실행되지 않습니다.</>} />
                <ListItem label={<>답변 대기: 모델이 사용자만 정할 수 있는 결정을 물었습니다.</>} />
                <ListItem label={<>결과 확인 필요: 서버 재시작 등으로 실행 결과를 알 수 없는 작업입니다. 자동으로 다시 실행하지 않습니다.</>} />
            </List>
            <Heading level={4} color="inherit">링크</Heading>
            <Text as="p" display="block" type="inherit" color="inherit">모델 답의 외부 링크는 새 탭에서 열리고, 실제 목적지 주소가 링크 옆에 함께 표시됩니다.</Text>
        </Stack>
    );
}

/// 마지막 연결 확인 결과(AUTH-001). 생성 요청 없이 모델 목록·CLI 버전만 확인한다.
function CheckStatus({ c }: { c: ModelProfile["last_check"] }) {
    if (!c) return <Text as="span" type="supporting" color="secondary" data-testid="profile-check"> · 연결 확인 안 함</Text>;
    const d = (c.detail ?? {}) as { models?: number; model_listed?: boolean; cli_version?: string };
    const when = <When at={c.checked_at} />;
    return c.ok ? (
        <Text as="span" type="supporting" color="inherit" data-testid="profile-check">
            {" "}· <Text as="span" type="inherit" color="inherit" className="status succeeded">연결됨</Text> {c.latency_ms}ms · {when}
            {d.cli_version && ` · ${d.cli_version}`}
            {d.models !== undefined && (d.model_listed ? " · 모델 확인됨" : ` · 목록(${d.models}개)에 이 모델 없음`)}
        </Text>
    ) : (
        <Text as="span" type="supporting" color="inherit" data-testid="profile-check">
            {" "}· <Text as="span" type="inherit" color="inherit" className="status failed">실패</Text> <code>{c.code}</code> {c.message} · {when}
        </Text>
    );
}
