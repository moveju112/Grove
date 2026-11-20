import { StatusBadge } from "../design/StatusBadge";
import { Card } from "@astryxdesign/core/Card";
import { Notice } from "../design/Notice";
import { Code } from "@astryxdesign/core/Code";
import { contentStyles } from "../design/content.stylex";
import { KeyValues } from "../design/KeyValues";
import { useCallback, useContext, useEffect, useId, useMemo, useRef, useState } from "react";
import { ActionMenu, DetailDialog } from "./ui/Controls";
import { HelpTip } from "./HelpTip";
import { ApiError, PROTOCOL, api, logout } from "../api/client";
import { ServerActionButton } from "./pwa/ServerActionButton";
import type { Definition, DefinitionDetail, ModelProfile, SecretInfo } from "../api/generated";
import { activityDisplayOptions, type Prefs, loadPrefs, savePrefs, usePrefs, VINE_GROUPS } from "../state/device";
import { When } from "./When";
import { PushNotifications, PushStatusContext } from "./PushNotifications";
import { AppNotificationPermission } from "./AppNotificationPermission";
import { NotificationTests } from "./NotificationTests";
import { notificationPermission } from "../state/attention";
import { MAX_RECENT_WINDOWS, normalizeRecentWindows, RECENT_WINDOW_OPTIONS, recentWindowLabel } from "../state/recentWindow";
import { invalidate, useLive, useQuery } from "../state/store";
import { type SettingDef, type SettingsTarget, ScopedSettings, isRoleProfile, useEffectiveSettings, useModelProfiles } from "./ScopedSettings";
import { RoleModelChoice } from "./settings/RoleModelChoice";
import { isWorkflowSetting, WorkflowSettings } from "./settings/WorkflowSettings";
import { DeviceConnections } from "./Pairing";
import { Hosts } from "./Hosts";
import { ProfileCatalog } from "./ProfileCatalog";
import { LocalModelConnection } from "./local-models/LocalModelConnection";
import { ProfileCapabilities } from "./ProfileCapabilities";
import { ProfileContextPolicy } from "./ProfileContextPolicy";
import { ProfileFallback } from "./ProfileFallback";
import { useCapability } from "../state/capabilities";
import { useAutosave } from "./settings/useAutosave";
import { AutosaveStatus } from "./settings/AutosaveStatus";
import { DiagnosticsBundle } from "./DiagnosticsBundle";
import { SourceSettings } from "./source-settings/SourceSettings";
import { TurnTimingSetting } from "./turn-timing/TurnTimingSetting";
import { ExecSettings } from "./exec-settings/ExecSettings";
import { isExecSetting } from "../api/execSettings";
import { BrowserCapabilitiesSettings, currentNotificationIssue, useBrowserCapabilities } from "./capabilities/BrowserCapabilities";
import { requestNotificationAccess } from "./capabilities/browser";
import { UpdateSettings } from "./update/UpdateSettings";
import { useSettingsLink } from "./settings-links/useSettingsLink";
import type { SettingLinkReady } from "./settings-links/reveal";
import { useDefinitionDraft } from "./definition-updates/useDefinitionDraft";
import { AgentOverview } from "./agent-overview/AgentOverview";
import { BotsPanel } from "./BotsPanel";
import { AgentConnect } from "./AgentConnect";
import type { Opener } from "./Workspace";
import { SettingsGroup } from "./SettingsGroup";
import { Icon, type IconName } from "./icons";
import { Button } from "../design/Button";
import { Stack, StackItem } from "@astryxdesign/core/Stack";
import { Grid } from "@astryxdesign/core/Grid";
import { settingsStyles } from "../design/settings.stylex";
import { Heading, Text } from "@astryxdesign/core/Text";
import { List, ListItem } from "@astryxdesign/core/List";
import { Collapsible } from "@astryxdesign/core/Collapsible";
import { Tab, TabList } from "@astryxdesign/core/TabList";
import { TextInput, TextArea, DraftInput } from "../design/Fields";
import { Slider } from "@astryxdesign/core/Slider";
import { Select } from "../design/Select";
import { BooleanSelect } from "./BooleanSelect";
import { ShortcutSettings } from "./shortcuts/ShortcutSettings";

// 설정 registry(CONFIG-001): 메뉴·이름·검색어·적용 범위. 검색은 이 표를 기준으로 한다.
type Item = { id: string; menu: Menu; label: string; keywords: string; scope: "이 기기" | "서버 전체" | "전역·프로젝트" };
type Menu = "model" | "conversation" | "workflow" | "agents" | "permissions" | "execution" | "display" | "notifications" | "shortcuts" | "devices" | "server";
type SettingsArea = "local" | "daemon";
const MENUS: [Menu, string][] = [
    ["model", "모델·키"],
    ["conversation", "대화·컨텍스트"],
    ["workflow", "워크플로우·메모리"],
    ["agents", "위임 에이전트"],
    ["permissions", "도구·권한"],
    ["execution", "실행·한도"],
    ["display", "화면·입력"],
    ["notifications", "알림"],
    ["shortcuts", "단축키"],
    ["devices", "기기·연결"],
    ["server", "서버·데이터"],
];
const AREA_MENUS: Record<SettingsArea, Menu[]> = {
    local: ["display", "notifications", "shortcuts", "devices"],
    daemon: ["model", "conversation", "workflow", "agents", "permissions", "execution", "devices", "server"],
};
const SETTING_MENUS: Record<string, Menu> = {
    output: "conversation", session: "conversation", sessions: "conversation", context: "conversation",
    tools: "permissions", approval: "permissions",
    exec: "execution", runs: "execution",
    "agents.allowed_roles": "agents", "agents.delegation": "agents",
};
const settingMenu = (def: SettingDef) => isWorkflowSetting(def.key) ? "workflow"
    : SETTING_MENUS[def.key] ?? SETTING_MENUS[def.key.split(".")[0]!] ?? def.menu;
export const ITEMS: Item[] = [
    { id: "basic-definitions", menu: "workflow", label: "기본 역할·워크플로우", keywords: "기본 보조 메모리 maintainer title generator compressor solo 컨텍스트 압축 컨텍스트 탐색 실패 분석 인계 요약", scope: "서버 전체" },
    { id: "bots", menu: "workflow", label: "봇", keywords: "bot persona 봇", scope: "서버 전체" },
    { id: "secrets", menu: "model", label: "API 키", keywords: "key secret 비밀 openai anthropic gemini", scope: "서버 전체" },
    { id: "profiles", menu: "model", label: "모델 프로필", keywords: "model provider endpoint url 모델 timeout temperature max_tokens", scope: "서버 전체" },
    { id: "definitions", menu: "agents", label: "위임 에이전트", keywords: "agent workflow prompt 지침", scope: "서버 전체" },
    { id: "source-settings", menu: "execution", label: "원본 Claude/Codex 설정", keywords: "원본 출처 읽기 전용 claude codex source settings 스킬 skill hook", scope: "전역·프로젝트" },
    { id: "exec-settings", menu: "execution", label: "명령 실행", keywords: "exec shell bash sh 셸 대화", scope: "전역·프로젝트" },
    { id: "theme", menu: "display", label: "테마", keywords: "dark light 다크 라이트 색", scope: "이 기기" },
    { id: "font", menu: "display", label: "글자 크기", keywords: "font size 글꼴", scope: "이 기기" },
    { id: "enter", menu: "display", label: "Enter로 보내기", keywords: "enter send 입력 단축키", scope: "이 기기" },
    { id: "terminal-paste", menu: "display", label: "터미널 여러 줄 붙여넣기 확인", keywords: "terminal clipboard paste 터미널 붙여넣기 복사 여러줄 다시 묻지 않기", scope: "이 기기" },
    { id: "shortcuts", menu: "shortcuts", label: "키보드 단축키", keywords: "keyboard shortcut preset ctrl cmd control 단축키 프리셋 키보드 새 세션 탭 닫기", scope: "이 기기" },
    { id: "running-send", menu: "display", label: "실행 중 보내기 방식", keywords: "followup queue steer interrupt 채팅 추가 메시지 대기열 합치기 반영 중단", scope: "이 기기" },
    { id: "recent", menu: "display", label: "최근 항목 시간 범위", keywords: "recent window 최근 범위 분 시간 오늘", scope: "이 기기" },
    { id: "notify", menu: "notifications", label: "알림·소리", keywords: "notification alert sound 알림 소리 완료 승인 예약 업데이트", scope: "이 기기" },
    { id: "time", menu: "display", label: "시간 표시", keywords: "time clock 24 12 시계 시각 상대 날짜 턴 경과 소요 대기", scope: "이 기기" },
    { id: "transcript", menu: "display", label: "대화 표시", keywords: "진행사항 보기 진행 설명 완료 시 접기 progress", scope: "이 기기" },
    { id: "leaves", menu: "display", label: "진행 중 효과", keywords: "대기 중 새싹 표시 잎 애니메이션 정지 표시 숨김 상단 탭 링 잎 무리 수 잎 무리 길이 잎 회전 속도", scope: "이 기기" },
    { id: "devices", menu: "devices", label: "기기·등록 링크", keywords: "device token pair 등록 기기 토큰 QR 링크 페어링 폐기 분실", scope: "서버 전체" },
    { id: "hosts", menu: "devices", label: "데몬 연결", keywords: "host 서버 연결 주소 별명 데몬", scope: "이 기기" },
    { id: "device-name", menu: "devices", label: "클라이언트 이름", keywords: "이 기기 이름 device name 클라이언트", scope: "이 기기" },
    { id: "browser-capabilities", menu: "devices", label: "브라우저 기능·권한", keywords: "이 기기 browser notification clipboard 알림 복사 붙여넣기 파일 첨부 드래그 HTTPS 보안 권한", scope: "이 기기" },
    { id: "logout", menu: "devices", label: "로그아웃", keywords: "logout sign out", scope: "이 기기" },
    { id: "health", menu: "server", label: "서버 상태·버전·진단", keywords: "version health schema diagnostics 버전 상태 진단 정보 복사", scope: "서버 전체" },
    { id: "server-update", menu: "server", label: "서버 업데이트", keywords: "update automatic on off 자동 업데이트", scope: "서버 전체" },
];

export function Settings({ projectId, projectName, sessionId, initialMenu, open }: {
    projectId?: string; projectName?: string; sessionId?: string; initialMenu?: "shortcuts"; open: Opener;
}) {
    const [area, setArea] = useState<SettingsArea>(projectId && !initialMenu ? "daemon" : "local");
    const [menu, setMenu] = useState<Menu>(initialMenu ?? (projectId ? "workflow" : "display"));
    const panelId = useId();
    const scroll = useRef<HTMLDivElement>(null);
    const [q, setQ] = useState("");
    const [showAdvanced, setShowAdvanced] = useState(false);
    const [leavesOpen, setLeavesOpen] = useState(false);
    const registry = useQuery<SettingDef[]>("settings-registry", () => api.get("/settings/registry"));
    const session = useQuery<{ title: string } | null>(`session:${sessionId ?? "-"}`, () => (sessionId ? api.get(`/sessions/${sessionId}`) : Promise.resolve(null)));
    const target: SettingsTarget = { projectId, projectName, sessionId, sessionTitle: session.data?.title };
    // 서버 설정 값과 모델 목록은 항목 정의에 의존하지 않는다. 정의를 받은 뒤 각 행이 요청하지 않도록 화면 진입 시 함께 시작하고,
    // 같은 cache key를 각 행이 공유한다.
    useEffectiveSettings(target, area === "daemon");
    useModelProfiles(area === "daemon");

    // 직접 링크(#setting-<key>): 해당 메뉴를 열고 고급 항목이면 펼친 뒤 그 항목으로 이동한다(SETTINGS-021).
    const prepareLink = useCallback((d: SettingDef) => {
        const nextMenu = AREA_MENUS.daemon.find((id) => id === settingMenu(d));
        if (!nextMenu) return false;
        setQ("");
        setArea("daemon");
        setMenu(nextMenu);
        if (d.advanced) setShowAdvanced(true);
        return true;
    }, []);
    const link = useSettingsLink(registry, JSON.stringify([projectId, sessionId]), prepareLink);
    const onLinkReady = link.ready;
    const needle = q.trim().toLowerCase();
    const matchesArea = (item: Item) => (item.scope === "이 기기" ? "local" : "daemon") === area;
    const results = useMemo(() => (needle ? ITEMS.filter((i) => (i.scope === "이 기기" ? "local" : "daemon") === area
        && (i.label + " " + i.keywords).toLowerCase().includes(needle)) : null), [area, needle]);
    useEffect(() => {
        if (results?.some((item) => item.id === "leaves")) setLeavesOpen(true);
    }, [results]);
    const serverDefs = area === "daemon" ? (registry.data ?? []).filter((d) =>
        needle ? (d.label + " " + d.keywords + " " + d.description).toLowerCase().includes(needle) : settingMenu(d) === menu && (showAdvanced || !d.advanced),
    ) : [];
    const hiddenAdvanced = area === "daemon" && !needle ? (registry.data ?? []).filter((d) => settingMenu(d) === menu && d.advanced).length : 0;
    const roleModels = serverDefs.filter((d) => isRoleProfile(d.key));
    const agentModelMatches = roleModels.some((d) => settingMenu(d) === "agents");
    const workflowKeys = serverDefs.filter((d) => isWorkflowSetting(d.key)).map((d) => d.key);
    const standaloneDefs = serverDefs.filter((d) => !isWorkflowSetting(d.key) && !isRoleProfile(d.key) && !isExecSetting(d));
    const visible = (id: string) => results ? results.some((r) => r.id === id)
        : ITEMS.some((i) => i.id === id && matchesArea(i) && i.menu === menu);
    const total = (results?.length ?? 0) + (needle ? serverDefs.length : 0);
    return (
        <Stack width="100%" height="100%" gap={4} data-testid="settings" ref={link.root}
            onWheelCapture={link.cancel} onTouchMoveCapture={link.cancel}
            onKeyDownCapture={link.cancel} onPointerDownCapture={link.cancel}>
            <TabList value={area} onChange={(value) => {
                link.cancel();
                const next = value as SettingsArea;
                setArea(next); setQ("");
                setMenu(next === "local" ? "display" : projectId ? "workflow" : "model");
                scroll.current?.scrollTo({ top: 0 });
            }} role="tablist" aria-label="설정 구분" size="lg" layout="fill" xstyle={settingsStyles.areaSelector}>
                <Tab value="local" label="로컬 설정" panelId={panelId}
                    icon={<Icon name="monitor" size={18} />} xstyle={settingsStyles.areaTab} />
                <Tab value="daemon" label="데몬 설정" panelId={panelId}
                    icon={<Icon name="server" size={18} />} xstyle={settingsStyles.areaTab} />
            </TabList>
        <StackItem ref={scroll} size="fill" isScrollable data-testid="settings-scroll">
        <Grid id={panelId} role="tabpanel" aria-label={area === "local" ? "로컬 설정" : "데몬 설정"}
            width="100%" maxWidth={1200} gap={8} align="start" xstyle={settingsStyles.layout}>
            <Stack as="nav" gap={4} paddingBlockEnd={2} xstyle={settingsStyles.navigation} aria-label="설정 메뉴">
                <TextInput type="search" label="설정 검색" isLabelHidden placeholder="설정 검색" value={q}
                    onChange={(value) => { link.cancel(); setQ(value); }} width="100%" />
                <Stack gap={1} xstyle={settingsStyles.menu} data-testid="settings-menu">
                {MENUS.filter(([m]) => AREA_MENUS[area].includes(m)).map(([m, label]) => (
                    <Button key={m} appearance="settings" width="auto" xstyle={settingsStyles.menuItem} aria-current={!results && menu === m ? "page" : undefined} onClick={() => { link.cancel(); setQ(""); setMenu(m); }}>
                        {label}
                    </Button>
                ))}
                </Stack>
                {area === "daemon" && (sessionId ? (
                    <Text as="p" display="block" type="supporting" color="secondary" data-testid="settings-origin">
                        대화 · {session.data?.title ?? sessionId} ({projectName ?? projectId})
                    </Text>
                ) : (
                    projectId && <Text as="p" display="block" type="supporting" color="secondary" data-testid="settings-origin">프로젝트 · {projectName ?? projectId}</Text>
                ))}
            </Stack>
            <Stack gap={4} xstyle={settingsStyles.body} data-testid="settings-body">
                {link.pending && <Text as="p" display="block" type="inherit" color="secondary" role="status">링크한 설정을 불러오는 중…</Text>}
                {link.error && <Text as="p" display="block" type="inherit" color="error" role="alert">{link.error}</Text>}
                {needle && total === 0 && <Text as="p" display="block" type="inherit" color="secondary">검색 결과 0개 — 다른 낱말로 찾아보세요</Text>}
                {(visible("basic-definitions") || workflowKeys.length > 0) && <Section item="basic-definitions"><WorkflowSettings
                    defs={registry.data ?? []} target={target} search={needle} matchedKeys={workflowKeys} linkedKey={link.key} onLinkReady={onLinkReady}
                    renderRoleName={(role) => <DetailDialog label={role.name} title={role.name}>
                        <DefinitionEditor kind="agent" id={role.id} />
                    </DetailDialog>}
                    definitions={<Collapsible trigger="워크플로우 정의" defaultIsOpen={false}>
                        <Definitions target={target} kind="workflow" defs={[]} onLinkReady={onLinkReady} />
                    </Collapsible>} /></Section>}
                {standaloneDefs.length > 0 && <ScopedSettings grouped defs={standaloneDefs} target={target}
                    linkedKey={link.key} onLinkReady={onLinkReady} />}
                {hiddenAdvanced > 0 && !showAdvanced && (
                    <Button variant="secondary" onClick={() => setShowAdvanced(true)}>고급 항목 {hiddenAdvanced}개 펼치기</Button>
                )}
                {visible("secrets") && <Section item="secrets"><Secrets /></Section>}
                {visible("profiles") && <Section item="profiles"><Profiles /></Section>}
                {(visible("definitions") || agentModelMatches) && <Section item="definitions"><Definitions target={target} kind="agent"
                    defs={registry.data ?? []} modelSearch={needle && agentModelMatches ? needle : undefined} linkedKey={link.key} hasLinkError={Boolean(link.error)} onLinkReady={onLinkReady} /></Section>}
                {(visible("exec-settings") || serverDefs.some(isExecSetting)) && <Section item="exec-settings"><ExecSettings
                    linkedKey={link.key} onLinkReady={onLinkReady}
                    defs={(needle && visible("exec-settings") ? registry.data ?? [] : serverDefs).filter(isExecSetting)} target={target} /></Section>}
                {visible("source-settings") && <Section item="source-settings"><SourceSettings projectId={projectId} /></Section>}
                {(["theme", "font", "enter", "terminal-paste", "shortcuts", "running-send", "recent", "notify", "time", "transcript", "leaves"] as const).some(visible)
                    && <DisplayPrefs show={visible} leavesOpen={leavesOpen} onLeavesOpenChange={setLeavesOpen} />}
                {visible("bots") && <Section item="bots"><BotsPanel open={open} /></Section>}
                {visible("devices") && <Section item="devices"><DeviceConnections /></Section>}
                {visible("hosts") && <Section item="hosts"><Hosts /></Section>}
                {visible("device-name") && <Section item="device-name"><CurrentDeviceName onSaved={() => invalidate("devices")} /></Section>}
                {visible("browser-capabilities") && <Section item="browser-capabilities"><BrowserCapabilitiesSettings /></Section>}
                {visible("logout") && <Section item="logout"><ServerActionButton onClick={() => void logout()}>이 브라우저에서 로그아웃</ServerActionButton></Section>}
                {visible("health") && <Section item="health"><Health /></Section>}
                {visible("server-update") && <Section item="server-update"><UpdateSettings /></Section>}
            </Stack>
        </Grid>
        </StackItem>
        </Stack>
    );
}

const GROUP_ICONS: Record<string, IconName> = {
    devices: "monitor", "browser-capabilities": "shield", logout: "user",
    hosts: "server", "device-name": "monitor",
    profiles: "server", definitions: "edit", "source-settings": "edit",
    notify: "bell", health: "server",
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
            <Text as="span" type="supporting" color={state.kind === "error" ? "error" : "secondary"}
                data-settings-issue={state.kind === "error" ? "error" : undefined} role="status">
                {state.kind === "saving" ? "저장 중…" : state.kind === "saved" ? "저장됨" : `저장 실패(기존 값 유지): ${state.msg}`}
            </Text>
        );
    return { run, view };
}

function FontSize({ value }: { value: number }) {
    const [draft, setDraft] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const commit = (raw: string) => {
        const next = Number(raw);
        if (!/^\d+$/.test(raw) || !Number.isInteger(next) || next < 12 || next > 20) {
            setError("글자 크기는 12~20px의 정수로 입력하세요.");
            return;
        }
        try {
            const latest = loadPrefs();
            if (latest.fontSize !== next) savePrefs({ ...latest, fontSize: next });
            setDraft(null); setError(null);
        } catch { setError("글자 크기를 저장하지 못했어요. 입력은 보존했어요."); }
    };
    return <Stack gap={2}>
        <Slider label="글자 크기" isLabelHidden min={12} max={20} value={value}
            onChange={(value: number) => { setDraft(String(value)); commit(String(value)); }}
            formatValue={(value) => `${value}px`} valueDisplay="text" />
        <DraftInput type="number" label="글자 크기 입력(px)" min={12} max={20} step={1} value={draft ?? String(value)}
            onChange={(value) => { setDraft(value); setError(null); }} onBlur={() => { if (draft !== null) commit(draft); }} />
        {error && <Text as="p" display="block" type="supporting" color="error" role="alert">{error}</Text>}
    </Stack>;
}

function DisplayPrefs({ show, leavesOpen, onLeavesOpenChange }: {
    show: (id: string) => boolean; leavesOpen: boolean; onLeavesOpenChange: (open: boolean) => void;
}) {
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
                </Section>
            )}
            {show("font") && (
                <Section item="font">
                    <FontSize value={p.fontSize} />
                </Section>
            )}
            {show("enter") && (
                <Section item="enter">
                    <BooleanSelect label="Enter로 보내기"
                        value={p.enterToSend} onChange={(value) => set({ ...p, enterToSend: value })}
                        help="Shift+Enter로 줄바꿈해요. 터치 키보드는 Enter도 줄바꿈이에요." />
                </Section>
            )}
            {show("terminal-paste") && (
                <Section item="terminal-paste">
                    <BooleanSelect label="터미널 여러 줄 붙여넣기 확인"
                        value={p.confirmTerminalPaste} onChange={(value) => set({ ...p, confirmTerminalPaste: value })} />
                </Section>
            )}
            {show("running-send") && (
                <Section item="running-send">
                    <Select label="실행 중 보내기 방식" hideLabel value={p.runningSendMode}
                        onChange={(value) => set({ ...p, runningSendMode: value as Prefs["runningSendMode"] })}
                        options={[{ value: "queue", label: "대기열" }, { value: "steer", label: "합치기" },
                            { value: "interrupt", label: "중단 후 전송" }]} />
                    <HelpTip label="실행 중 보내기 방식 도움말">
                        대기열은 현재 응답이 정상 종료되면 실행해요.
                        합치기는 현재 요청을 유지한 채 다음 응답에 반영해요.
                        중단 후 전송은 실행을 취소하지만 이미 바뀐 파일은 되돌리지 않아요.
                    </HelpTip>
                </Section>
            )}
            {show("shortcuts") && (
                <Section item="shortcuts">
                    <ShortcutSettings value={p.keyboardShortcuts} onChange={(keyboardShortcuts) => set({ ...p, keyboardShortcuts })} />
                </Section>
            )}
            {show("recent") && (
                <Section item="recent">
                    <fieldset>
                        <legend>표시할 시간 범위(최대 {MAX_RECENT_WINDOWS}개)</legend>
                        {Array.from({ length: MAX_RECENT_WINDOWS }, (_, index) => <Select key={index}
                            label={`최근 시간 범위 ${index + 1}`} value={p.recentWindows[index] ?? ""}
                            onChange={(value) => set({ ...p, recentWindows: normalizeRecentWindows([
                                ...p.recentWindows.filter((_, i) => i !== index), value,
                            ]) })}
                            options={[{ value: "", label: "선택 안 함", disabled: p.recentWindows.length === 1 && index === 0 },
                                ...RECENT_WINDOW_OPTIONS.map((option) => ({ value: option, label: recentWindowLabel(option),
                                    disabled: p.recentWindows.includes(option) && p.recentWindows[index] !== option }))]} />)}
                    </fieldset>
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
                    <TurnTimingSetting />
                </Section>
            )}
            {show("transcript") && (
                <Section item="transcript">
                    <Select label="진행사항 보기" value={p.progressVisibility}
                        onChange={(value) => set({ ...p, progressVisibility: value as Prefs["progressVisibility"] })}
                        options={[{ value: "expanded", label: "항상 펼치기" }, { value: "collapse", label: "완료 후 접기" }, { value: "hidden", label: "안 보기" }]} />
                </Section>
            )}
            {show("leaves") && (
                <Card id="setting-leaves" data-testid="setting-leaves" data-ui="settings-group" role="region"
                    aria-label="진행 중 효과" padding={3} xstyle={settingsStyles.group}>
                    <Collapsible isOpen={leavesOpen} onOpenChange={onLeavesOpenChange} trigger={
                        <Stack as="span" direction="horizontal" justify="between" gap={2}>
                            <Text as="span">진행 중 효과</Text>
                            <Text as="span" type="supporting" color="secondary">이 기기</Text>
                        </Stack>
                    }>
                        <Stack gap={2} paddingBlockStart={2}>
                            <Select label="진행 중 표시" value={p.activityDisplay} options={[...activityDisplayOptions]}
                                onChange={(value) => set({ ...p, activityDisplay: value as Prefs["activityDisplay"] })} />
                            <Select label="잎 무리 수" value={String(p.sessionVineGroups)} disabled={p.activityDisplay !== "animated"}
                                onChange={(value) => set({ ...p, sessionVineGroups: Number(value) as Prefs["sessionVineGroups"] })}
                                options={VINE_GROUPS.map((count) => ({ value: String(count), label: `${count}개` }))} />
                            <Select label="잎 무리 길이" value={p.sessionVineLength} disabled={p.activityDisplay !== "animated"}
                                onChange={(value) => set({ ...p, sessionVineLength: value as Prefs["sessionVineLength"] })}
                                options={[{ value: "short", label: "짧게" }, { value: "medium", label: "기본" }, { value: "long", label: "길게" }]} />
                            <Select label="잎 회전 속도" value={p.sessionVineSpeed} disabled={p.activityDisplay !== "animated"}
                                onChange={(value) => set({ ...p, sessionVineSpeed: value as Prefs["sessionVineSpeed"] })}
                                options={[{ value: "slow", label: "느리게" }, { value: "normal", label: "기본" }, { value: "fast", label: "빠르게" }]} />
                        </Stack>
                    </Collapsible>
                </Card>
            )}
        </>
    );
}

const PERMISSION_LABEL: Record<NotificationPermission | "unsupported", string> = {
    granted: "허용됨",
    default: "아직 묻지 않음",
    denied: "차단됨 · 사이트 설정에서 변경",
    unsupported: "알림 미지원",
};

function NotifyPrefs({ prefs: p, set }: { prefs: Prefs; set: (n: Prefs) => void }) {
    const pushStatus = useContext(PushStatusContext);
    const [permission, setPermission] = useState(notificationPermission);
    const [capabilities, refresh] = useBrowserCapabilities();
    const [requestError, setRequestError] = useState<string | null>(null);
    const [appPermissionRequest, setAppPermissionRequest] = useState(0);
    const showAppPermission = () => setAppPermissionRequest((current) => current + 1);
    const notificationIssue = currentNotificationIssue(capabilities);
    useEffect(() => { setPermission(notificationPermission()); }, [capabilities]);
    useEffect(() => { setRequestError(null); }, [permission]);
    const request = async () => {
        const result = await requestNotificationAccess();
        if (result.permission) setPermission(result.permission);
        setRequestError(result.message ?? null);
        if (result.permission === "granted") showAppPermission();
        pushStatus?.refreshPermission();
        refresh();
    };
    // 알림 종류를 켜면 그때 브라우저 권한을 묻는다. 거부돼도 소리 설정은 따로 쓸 수 있다.
    const toggle = async (key: "notifyDone" | "notifyApproval" | "notifyServer" | "notifyPush", on: boolean) => {
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
            <Text as="span" type="supporting" color="secondary">아래 종류는 앱 실행 중에 알림</Text>
            <BooleanSelect label="알림 소리" value={p.notifySound} onChange={(value) => set({ ...p, notifySound: value })} />
            <BooleanSelect label="알림 진동" value={p.notifyVibrate} onChange={(value) => set({ ...p, notifyVibrate: value })} />
            <PushNotifications enabled={p.notifyPush} onChange={(on) => void toggle("notifyPush", on)} />
            <Text as="p" display="block" type="supporting" color="inherit" data-testid="notify-permission">브라우저 알림 권한: {capabilities && !capabilities.secureContext ? "보안 컨텍스트 필요(HTTPS·localhost)" : PERMISSION_LABEL[permission]}</Text>
            <AppNotificationPermission request={appPermissionRequest} />
            {(p.notifyDone || p.notifyApproval || p.notifyServer || p.notifyPush) && permission !== "granted" && (
                <Text as="p" display="block" type="supporting" color="warning" role="status">브라우저 권한이 없어 화면 알림은 표시되지 않습니다{p.notifySound ? ". 소리만 재생합니다." : "."}</Text>
            )}
            {(requestError || notificationIssue) && <Text as="p" display="block" type="supporting" color="warning" role="status">{requestError || notificationIssue}</Text>}
            {permission === "default" && <Button variant="secondary" density="compact" onClick={() => void request()}>브라우저 알림 허용</Button>}
            <NotificationTests sound={p.notifySound} vibrate={p.notifyVibrate} />
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
                        <ServerActionButton variant="secondary" density="compact" onClick={() => {
                            const v = prompt(`${s.label}의 새 키(이전 키는 저장 성공 후에만 교체)`);
                            if (v) void save.run(() => api.put(`/secrets/${s.id}`, { label: s.label, value: v }));
                        }}>교체</ServerActionButton>
                        <ServerActionButton variant="secondary" density="compact" onClick={() => void save.run(() => api.del(`/secrets/${s.id}`))}>삭제</ServerActionButton>
                    </>} />
                ))}
            </List>
            <Stack as="form" gap={1.5} direction="horizontal" align="center" onSubmit={(e) => { e.preventDefault(); void save.run(async () => { await api.post("/secrets", { label, value }); setLabel(""); setValue(""); }); }}>
                <TextInput size="sm" placeholder="이름" value={label} onChange={setLabel} label="키 이름" isLabelHidden isRequired />
                <TextInput size="sm" placeholder="키 값" type="password" autoComplete="off" value={value} onChange={setValue} label="키 값" isLabelHidden isRequired />
                <ServerActionButton type="submit">추가</ServerActionButton>
            </Stack>
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
    const presets: Record<string, string> = { openai: "https://api.openai.com/v1", anthropic: "https://api.anthropic.com", gemini: "https://generativelanguage.googleapis.com", claude_code: "", codex_oauth: "" };
    // 서버에 설치된 CLI 백엔드는 endpoint·키가 없다(CLI가 자기 로그인을 쓴다). 저가형 기본 모델을 제안한다.
    const accountModels: Record<string, string> = { claude_code: "haiku", codex_oauth: "default" };
    const isAccountModel = f.protocol in accountModels;
    return (
        <>
            <DetailDialog label="CLI 에이전트 연결" title="CLI 에이전트 연결" onOpenChange={setAgentSetup}>
                {agentSetup && <AgentConnect disabled={false} onConnected={() => list.reload()} />}
            </DetailDialog>
            {management !== false && <LocalModelConnection secrets={secrets.data ?? []} onCreate={(body, key) =>
                api.post("/model-profiles", body, { key, requires: ["model_management_v1"] })
            } />}
            <List density="balanced" edge="flush">
                {(list.data ?? []).map((p) => (
                    <ListItem key={p.id} label={<Card width="100%" padding={5} data-testid="model-profile"><Stack gap={3}>
                        <Stack direction="horizontal" align="center" gap={2} data-testid="profile-heading">
                            <Stack gap={1} width="100%"><strong>{p.name}</strong><Text type="code" color="secondary" wordBreak="break-word" data-testid="profile-model">{p.model}</Text></Stack>
                            {p.enabled === false && <Text as="span" type="supporting" color="warning"> · 비활성</Text>}
                            <HelpTip label={`${p.name} 연결 정보`}>
                                <Text as="span" type="inherit" color="inherit">{p.protocol === "codex_oauth" ? "Codex · 계정 로그인" : p.protocol}{p.base_url ? ` · ${p.base_url}` : p.protocol === "codex_oauth" ? "" : " · 서버 CLI 계정 · 프로젝트 수정·검사 가능"}</Text>
                            </HelpTip>
                            <ActionMenu label={`${p.name} 관리`}>
                                <ServerActionButton variant="secondary" density="compact" onClick={() => {
                                    const m = prompt("모델 이름", p.model);
                                    if (m && m !== p.model) void save.run(() => api.put(`/model-profiles/${p.id}`, { expected_revision: p.revision, model: m }));
                                }}>모델 변경</ServerActionButton>
                                <ServerActionButton variant="secondary" density="compact" onClick={() => void save.run(() => api.del(`/model-profiles/${p.id}`))}>삭제</ServerActionButton>
                                <ServerActionButton variant="secondary" density="compact" onClick={() => void save.run(() => api.post(`/model-profiles/${p.id}/check`))}>연결 확인</ServerActionButton>
                                {management !== false && <ServerActionButton variant="secondary" density="compact" onClick={() => void save.run(() =>
                                    api.put(`/model-profiles/${p.id}`, { expected_revision: p.revision, enabled: p.enabled === false }, { requires: ["model_management_v1"] })
                                )}>{p.enabled === false ? "활성화" : "비활성화"}</ServerActionButton>}
                            </ActionMenu>
                        </Stack>
                        {p.last_check?.ok === false && <CheckStatus c={p.last_check} />}
                        <Collapsible trigger="상세 설정" defaultIsOpen={false}>
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
                        </Collapsible>
                    </Stack></Card>} />
                ))}
            </List>
            <Collapsible trigger="모델 프로필 추가" defaultIsOpen={false}>
            <Stack as="form" gap={2} maxWidth={480} aria-label="모델 프로필 추가" onSubmit={(e) => {
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
                        setF({ ...f, protocol: v, base_url: presets[v] ?? f.base_url, model: accountModels[v] ?? f.model, secret_id: accountModels[v] ? "" : f.secret_id });
                    }}
                    options={[{ value: "openai", label: "OpenAI 호환" }, { value: "anthropic", label: "Anthropic" },
                        { value: "gemini", label: "Gemini" }, { value: "claude_code", label: "Claude Code(서버 설치 CLI)" },
                        { value: "codex_oauth", label: "Codex(계정 로그인)" }]} />
                {!isAccountModel && <TextInput size="sm" placeholder="Base URL" value={f.base_url} onChange={(value) => setF({ ...f, base_url: value })} label="Base URL" isLabelHidden isRequired />}
                <TextInput size="sm" placeholder="모델" value={f.model} onChange={(value) => setF({ ...f, model: value })} label="모델" isLabelHidden isRequired />
                {!isAccountModel && (
                    <Select value={f.secret_id} onChange={(value) => setF({ ...f, secret_id: value })} label="API 키" hideLabel
                        options={[{ value: "", label: "키 없음" }, ...(secrets.data ?? []).map((s) => ({ value: s.id, label: s.label }))]} />
                )}
                {isAccountModel && (
                    <Text as="span" type="supporting" color="secondary" data-testid="cli-note">
                        {f.protocol === "codex_oauth" ? "Codex Desktop에 새 대화가 생기지 않아요." : "서버 CLI 계정 · 프로젝트 수정·검사 가능"}
                    </Text>
                )}
                <ServerActionButton type="submit">추가</ServerActionButton>
            </Stack>
            </Collapsible>
            {save.view}
        </>
    );
}

function Definitions({ target, kind, defs, modelSearch, linkedKey, hasLinkError, onLinkReady }: {
    target: SettingsTarget; kind: "agent" | "workflow";
    defs: SettingDef[]; modelSearch?: string; linkedKey?: string; hasLinkError?: boolean; onLinkReady: SettingLinkReady;
}) {
    const save = useSave();
    const [sel, setSel] = useState<string | null>(null);
    useEffect(() => {
        if (modelSearch || (linkedKey && isRoleProfile(linkedKey))) setSel(null);
    }, [modelSearch, linkedKey]);
    const list = useQuery<Definition[]>(`definitions:${kind}`, () => api.get(`/definitions?kind=${kind}`));
    const modelSettings = useEffectiveSettings({});
    return (
        <Stack gap={3}>
            {kind === "agent" && <AgentOverview target={target} onEdit={setSel} />}
            {kind === "agent" && !linkedKey && !hasLinkError && Boolean(modelSettings.error) && <Text type="supporting" color="error" role="alert">모델 설정을 읽지 못했어요.</Text>}
            <Grid gap={2} xstyle={settingsStyles.definitionList} data-testid="definition-list">
                {(list.data ?? []).filter((d) => d.kind === "workflow" || d.execution === "orchestrated").map((d) => {
                    const profile = defs.find((setting) => setting.key === d.profile_key);
                    return <Card key={d.id} padding={2} data-testid={`definition-${d.id}`}>
                        <Button appearance="settings" width="100%" aria-pressed={sel === d.id}
                            aria-current={sel === d.id ? "page" : undefined} onClick={() => setSel(d.id)}>
                            <Stack as="span" width="100%" direction="horizontal" align="center" justify="between" gap={2}>
                                {d.name}
                                <Text as="span" type="supporting" color="secondary">
                                    {!d.enabled ? "비활성" : d.modified_fields.length > 0 ? "수정됨" : d.builtin ? "기본" : "사용자"}
                                </Text>
                            </Stack>
                        </Button>
                        {d.kind === "agent" && (profile
                            ? <RoleModelChoice role={d} d={profile}
                                settings={modelSettings} linkedKey={linkedKey} onLinkReady={onLinkReady} />
                            : <BooleanSelect label={`${d.name} 사용`} value={d.enabled} onChange={(enabled) => void save.run(() => api.put(`/definitions/agent/${d.id}`, { expected_revision: d.revision, enabled }))} />)}
                    </Card>;
                })}
            </Grid>
            {save.view}
            {sel && <DefinitionEditor key={kind + sel} kind={kind} id={sel} />}
            <NewDefinition kind={kind} />
        </Stack>
    );
}

function DefinitionEditor({ kind, id }: { kind: string; id: string }) {
    const d = useQuery<DefinitionDetail>(`definitions:${kind}:${id}`, () => api.get(`/definitions/${kind}/${id}`));
    return d.data ? <DefinitionBody kind={kind} id={id} cur={d.data} reload={d.reload} /> : null;
}

function DefinitionBody({ kind, id, cur, reload }: { kind: string; id: string; cur: DefinitionDetail; reload: () => void }) {
    const local = useDefinitionDraft(kind, id);
    const save = useSave();
    const state = useAutosave({
        id: `definition:${kind}:${id}`, value: cur.body, revision: cur.revision,
        draft: local.draft ? { value: local.draft.text, revision: local.draft.baseRevision } : undefined,
        save: async (body, revision, key) => {
            try {
                const result = await api.put<DefinitionDetail>(`/definitions/${kind}/${id}`, { expected_revision: revision, body }, { key });
                return { value: result.body, revision: result.revision };
            } finally { reload(); }
        },
        onSaved: (value, saved) => {
            if (local.draft?.text === value) local.write(null);
            else if (local.draft) local.write({ ...local.draft, baseRevision: saved.revision });
        },
    });
    const busy = state.phase === "saving" || state.phase === "uncertain";
    return (
        <Stack gap={2} data-testid="definition-editor">
            <Heading level={3} color="inherit"><Stack as="span" direction="horizontal" align="center" gap={2}>{cur.name}
                <HelpTip label="정의 정보"><Text type="supporting" color="inherit">revision {cur.revision}</Text>
                    <Text as="p" display="block" type="inherit" color="inherit">{cur.description}</Text>
                </HelpTip>
            </Stack></Heading>
            <TextArea value={state.value} onChange={(value) => {
                state.change(value);
                local.write({ text: value, baseRevision: state.revision, updatedAt: Date.now() });
            }} onBlur={state.blur} rows={14} label="정의 본문" isLabelHidden />
            {local.error && <Text as="p" display="block" type="inherit" color="inherit" role="alert">{local.error}</Text>}
            <Stack direction="horizontal" wrap="wrap" gap={2}>
                {!cur.builtin && (
                    <ServerActionButton variant="secondary" disabled={busy} onClick={() => {
                        if (confirm("이 정의를 삭제할까요?")) void save.run(() => api.del(`/definitions/${kind}/${id}?expected_revision=${cur.revision}`));
                    }}>삭제</ServerActionButton>
                )}
                {kind === "workflow" && id !== "default" && (
                    <ServerActionButton variant="secondary" disabled={busy || state.dirty} onClick={() => void save.run(async () => { await api.put(`/definitions/${kind}/${id}`, { expected_revision: state.revision, enabled: !cur.enabled }); reload(); })}>
                        {cur.enabled ? "선택 불가로" : "선택 가능으로"}
                    </ServerActionButton>
                )}
            </Stack>
            <AutosaveStatus state={{ ...state, useRemote: () => { state.useRemote(); local.write(null); } }} />
            {save.view}
        </Stack>
    );
}

function NewDefinition({ kind }: { kind: string }) {
    const [f, setF] = useState({ id: "", name: "", body: "" });
    const save = useSave();
    return (
        <DetailDialog label={`새 ${kind === "agent" ? "에이전트" : "워크플로우"}`} title={`새 ${kind === "agent" ? "에이전트" : "워크플로우"}`}>
            <Stack as="form" gap={1.5} direction="horizontal" align="center" wrap="wrap" onSubmit={(e) => { e.preventDefault(); void save.run(async () => { await api.post(`/definitions/${kind}`, f); setF({ id: "", name: "", body: "" }); }); }}>
                <TextInput size="sm" placeholder="ID (소문자-하이픈)" value={f.id} onChange={(value) => setF({ ...f, id: value })} label="ID" isLabelHidden isRequired />
                <TextInput size="sm" placeholder="이름" value={f.name} onChange={(value) => setF({ ...f, name: value })} label="이름" isLabelHidden isRequired />
                <TextArea placeholder="본문" value={f.body} onChange={(value) => setF({ ...f, body: value })} label="본문" isLabelHidden isRequired />
                <ServerActionButton type="submit">만들기</ServerActionButton>
            </Stack>
            {save.view}
        </DetailDialog>
    );
}

function CurrentDeviceName({ onSaved }: { onSaved?: () => void }) {
    const query = useQuery<{ id: string; name: string }>("current-device", () => api.get("/auth/device"));
    return <Stack gap={1.5}>
        {query.data && <DeviceNameInput key={query.data.id} name={query.data.name} reload={() => { query.reload(); onSaved?.(); }} />}
        {Boolean(query.error) && <Text as="p" display="block" type="inherit" color="error" role="alert">기기 이름을 읽지 못했습니다.</Text>}
    </Stack>;
}

function DeviceNameInput({ name, reload }: { name: string; reload: () => void }) {
    const state = useAutosave({
        id: "current-device-name", value: name, revision: 0, unversioned: true,
        save: async (name, revision, key) => {
            if (!name.trim()) throw new ApiError(422, "invalid_input", "기기 이름을 입력하세요.");
            const result = await api.put<{ name: string }>("/auth/device", { name: name.trim() }, { key });
            reload();
            return { value: result.name, revision: revision + 1 };
        },
    });
    return <>
        <TextInput size="sm" label="이 기기 이름" value={state.value} isRequired onChange={state.change} onBlur={state.blur} maxLength={80} />
        <AutosaveStatus state={state} />
    </>;
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
            <KeyValues data-testid="version-details" items={[
                ["상태", String(h.data?.status ?? "…")],
                ["서버 버전", String(h.data?.version ?? "")],
                ["실행 대상", String(h.data?.target ?? "")],
                ["프로토콜", <>서버 {String(h.data?.protocol ?? "")} · 화면 {PROTOCOL}{h.data && h.data.protocol !== PROTOCOL ? " (다름: 새로고침 필요)" : ""}</>],
                ["DB schema", String(h.data?.schema ?? "")],
            ]} />
            <Button
                variant="secondary" density="compact"
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

/// 마지막 연결 확인 결과(AUTH-001). 생성 요청 없이 모델 목록·CLI 버전만 확인한다.
function CheckStatus({ c }: { c: ModelProfile["last_check"] }) {
    if (!c) return <Text as="span" type="supporting" color="secondary" data-testid="profile-check"> · 연결 확인 안 함</Text>;
    const d = (c.detail ?? {}) as { models?: number; model_listed?: boolean; cli_version?: string };
    const when = <When at={c.checked_at} />;
    return c.ok ? (
        <Text as="span" type="supporting" color="inherit" data-testid="profile-check">
            {" "}· <StatusBadge status="succeeded">{d.cli_version !== undefined ? "설치됨" : "연결됨"}</StatusBadge> {c.latency_ms}ms · {when}
            {d.cli_version && ` · ${d.cli_version}`}
            {d.models !== undefined && (d.model_listed ? " · 모델 확인됨" : ` · 목록(${d.models}개)에 이 모델 없음`)}
        </Text>
    ) : (
        <Text as="span" type="supporting" color="inherit" data-testid="profile-check">
            {" "}· <StatusBadge status="failed">실패</StatusBadge> <code>{c.code}</code> {c.message} · {when}
        </Text>
    );
}
