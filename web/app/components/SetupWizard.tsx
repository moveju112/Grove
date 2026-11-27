import { Card } from "@astryxdesign/core/Card";
import { Center } from "@astryxdesign/core/Center";
import { Heading } from "@astryxdesign/core/Heading";
import { ProgressBar } from "@astryxdesign/core/ProgressBar";
import { Stack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { ApiError, api, isTransportError, logout, newKey } from "../api/client";
import type { AgentBackendCatalog, SetupPreferences, SetupStatus } from "../api/generated";
import { Button } from "../design/Button";
import { GroveTheme } from "../design/DesignProvider";
import { Select } from "../design/Select";
import { useCapability } from "../state/capabilities";
import { applyPrefs, hasLocalSetup, loadPrefs, savePrefs, themeOptions, type Prefs } from "../state/device";
import { setData, useQuery } from "../state/store";
import { AgentLogin } from "./AgentLogin";
import { BooleanSelect } from "./BooleanSelect";
import { SentenceText } from "./HelpTip";
import { Icon } from "./icons";
import { LoadingBar, LoadingScreen } from "./LoadingScreen";
import { ServerActionButton } from "./pwa/ServerActionButton";

const CAPABILITY = "daemon_setup_v1";
const PATH = "/daemon-setup";
const requires = [CAPABILITY];
const readyStatus: SetupStatus = { required: false, preferences: null };
const styleLabels: Record<string, string> = {
    default: "디폴트", detailed: "디테일", simple: "심플", minimal: "미니멀", "extreme-minimal": "익스트림 미니멀",
};
const label = { theme: "테마", enter: "Enter로 보내기", accounts: "계정 로그인", output: "출력 스타일" };
type Step = keyof typeof label;

async function getStatus() {
    try { return await api.getContract("SetupStatus", PATH, { requires }); }
    catch (cause) {
        if (cause instanceof ApiError && cause.code === "capability_missing") return readyStatus;
        throw cause;
    }
}

export function SetupGate({ children }: { children: ReactNode }) {
    const supported = useCapability(CAPABILITY);
    const [needsLocal, setNeedsLocal] = useState(() => !hasLocalSetup());
    const [localComplete, setLocalComplete] = useState(!needsLocal);
    const [done, setDone] = useState(false);
    const [conflict, setConflict] = useState(false);
    const query = useQuery<SetupStatus>(supported === false || done ? null : "daemon-setup", getStatus);
    const status = supported === false ? readyStatus : query.data;
    const waiting = status?.required && !status.preferences;
    const reload = useRef(query.reload);
    reload.current = query.reload;
    useEffect(() => {
        if (!waiting || done) return;
        const timer = setInterval(() => { if (!document.hidden) reload.current(); }, 5000);
        return () => clearInterval(timer);
    }, [waiting, done]);

    if (done || (status && !status.required && localComplete)) return children;
    if (!status || (conflict && (query.loading || query.error))) {
        if (query.error && !isTransportError(query.error)) return <SetupCard>
            <Heading level={1}>초기 설정을 확인하지 못했어요</Heading>
            <Text role="alert"><SentenceText text={message(query.error)} /></Text>
            <ServerActionButton onClick={query.reload}>다시 확인</ServerActionButton>
            <Button variant="secondary" onClick={() => void logout()}>로그아웃</Button>
        </SetupCard>;
        return <LoadingScreen label="초기 설정 확인 중…" />;
    }
    return <SetupWizard status={status} needsLocal={needsLocal}
        key={`${status.preferences?.output_style_revision}`}
        onLocalSaved={() => setLocalComplete(true)} onDone={(saved) => { setData("daemon-setup", saved); setDone(true); }}
        onCheck={query.reload} conflict={conflict}
        onConflict={() => { setConflict(true); setNeedsLocal(!hasLocalSetup()); query.reload(); }} />;
}

function message(cause: unknown) {
    return cause instanceof Error ? cause.message : "설정을 저장하지 못했어요.";
}

function SetupCard({ children, theme }: { children: ReactNode; theme?: Prefs["theme"] }) {
    const card = <Center role="main" minHeight="100dvh" padding={4}>
        <Card width={520} maxWidth="100%" padding={6} data-testid="setup-wizard">
            <Stack gap={5}>{children}</Stack>
        </Card>
    </Center>;
    return theme ? <GroveTheme theme={theme}>{card}</GroveTheme> : card;
}

function SetupWizard({ status, needsLocal, onLocalSaved, onDone, onCheck, conflict, onConflict }: {
    status: SetupStatus; needsLocal: boolean; onLocalSaved: () => void; onDone: (status: SetupStatus) => void;
    onCheck: () => void; conflict: boolean; onConflict: () => void;
}) {
    const server: SetupPreferences | null = status.preferences;
    const steps: Step[] = [...(needsLocal ? ["theme", "enter"] as const : []),
        ...(server ? ["accounts", "output"] as const : [])];
    const [position, setPosition] = useState(0);
    const step = steps[position];
    const local = step === "theme" || step === "enter";
    const [prefs, setPrefs] = useState(loadPrefs);
    const [outputStyle, setOutputStyle] = useState(server?.output_style ?? "default");
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [uncertain, setUncertain] = useState(false);
    const attempt = useRef<string | null>(null);
    const heading = useRef<HTMLHeadingElement>(null);
    useEffect(() => { heading.current?.focus(); }, [step]);
    useEffect(() => () => { applyPrefs(loadPrefs()); }, []);

    const next = async () => {
        if (saving) return;
        setError(null);
        if (step === "enter") {
            try {
                savePrefs({ ...loadPrefs(), theme: prefs.theme, enterToSend: prefs.enterToSend, initialSetupComplete: true });
            } catch {
                setError("이 브라우저에 설정을 저장하지 못했어요. 사이트 데이터 저장을 허용한 뒤 다시 시도해 주세요.");
                return;
            }
            onLocalSaved();
        }
        if (step === "output" && server) {
            setSaving(true);
            attempt.current ??= newKey();
            try {
                const saved = await api.put<SetupStatus>(PATH, {
                    output_style: outputStyle, output_style_revision: server.output_style_revision,
                }, { requires, key: attempt.current, contract: "SetupStatus", timeoutMs: 15_000 });
                onDone(saved);
            } catch (cause) {
                if (cause instanceof ApiError && cause.code === "revision_conflict") {
                    onConflict();
                } else {
                    const unknown = cause instanceof ApiError && (cause.details as { result_unknown?: boolean } | undefined)?.result_unknown === true;
                    if (unknown) setUncertain(true);
                    else if (!uncertain) attempt.current = null;
                    if (unknown || !isTransportError(cause)) setError(message(cause));
                }
            } finally { setSaving(false); }
            return;
        }
        setPosition(position + 1);
    };

    return <SetupCard theme={prefs.theme}>
        {saving && <LoadingBar label="초기 설정 저장 중…" />}
        <Stack gap={2}>
            <Stack direction="horizontal" align="center" justify="between" gap={2}>
                <Text color="brand" aria-hidden="true"><Icon name="sprout" size={24} /></Text>
                <Text type="supporting" color="secondary">{local ? "로컬 설정" : "데몬 설정"}{step ? ` · ${position + 1}/${steps.length}` : ""}</Text>
            </Stack>
            {step && <ProgressBar value={position + 1} max={steps.length} label="초기 설정 진행" isLabelHidden variant="neutral" />}
        </Stack>
        <Heading ref={heading} tabIndex={-1} level={1}>{step ? label[step] : "서버 설정을 기다리는 중"}</Heading>
        {conflict && <Text role="status" color="warning">다른 곳에서 데몬 설정이 바뀌었어요. 현재 값을 다시 확인해 주세요.</Text>}
        {step === "theme" && <Select label="테마" hideLabel width="100%" value={prefs.theme} options={[...themeOptions]}
            onChange={(value) => {
                const next = { ...prefs, theme: value as Prefs["theme"] };
                setPrefs(next);
                applyPrefs(next);
            }} />}
        {step === "enter" && <BooleanSelect label="Enter로 보내기" hideLabel value={prefs.enterToSend}
            help="Shift+Enter로 줄바꿈해요. 터치 키보드는 Enter도 줄바꿈이에요." onChange={(value) => setPrefs({ ...prefs, enterToSend: value })} />}
        {step === "accounts" && <SetupAccounts />}
        {step === "output" && server && <Select label="출력 스타일" hideLabel width="100%" value={outputStyle} onChange={setOutputStyle}
            disabled={saving || uncertain}
            options={server.output_style_options.map((value) => ({ value, label: styleLabels[value] ?? value }))} />}
        {error && <Text role="alert" color="error"><SentenceText text={error} /></Text>}
        <Stack direction="horizontal" align="center" justify="between" gap={2}>
            {position > 0 && step
                ? <Button variant="secondary" disabled={saving || uncertain} onClick={() => { setError(null); setPosition(position - 1); }}>뒤로</Button>
                : <Button variant="ghost" onClick={() => void logout()}>로그아웃</Button>}
            {step === "output" ? <ServerActionButton disabled={saving} onClick={() => void next()}>
                {saving ? "저장 중…" : uncertain ? "저장 결과 확인" : "설정 완료"}
            </ServerActionButton> : step ? <Button onClick={() => void next()}>
                {position === steps.length - 1 && !status.required ? "설정 완료" : "다음"}
            </Button> : <ServerActionButton onClick={onCheck}>다시 확인</ServerActionButton>}
        </Stack>
    </SetupCard>;
}

function SetupAccounts() {
    const catalog = useQuery<AgentBackendCatalog>("agent-backends", () =>
        api.getContract("AgentBackendCatalog", "/agent-backends", { requires: ["agent_backends_v1"] }));
    return <Stack gap={2}>
        <Text type="supporting" color="secondary">지금 인증하지 않아도 돼요.</Text>
        {([["claude_code", "Claude Code"], ["codex_cli", "Codex"]] as const).map(([protocol, name]) => {
            const backend = catalog.data?.backends.find((item) => item.protocol === protocol || (protocol === "codex_cli" && item.protocol === "codex_oauth"));
            return backend?.installed ? <AgentLogin key={protocol} protocol={backend.protocol} name={name} disabled={false} signInOnly />
                : <Stack key={protocol} direction="horizontal" align="center" gap={2} paddingBlock={2}>
                    <Text>{name}</Text>
                    <Text type="supporting" color="secondary">{catalog.data ? "서버에 CLI 설치 필요" : catalog.loading ? "확인 중…" : null}</Text>
                </Stack>;
        })}
        {!!catalog.error && !isTransportError(catalog.error) && <Text role="alert" color="error">계정 정보를 확인하지 못했어요.</Text>}
    </Stack>;
}
