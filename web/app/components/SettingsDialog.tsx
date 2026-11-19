import { lazy, Suspense } from "react";
import { Stack } from "@astryxdesign/core/Stack";
import { Heading } from "@astryxdesign/core/Heading";
import { Button } from "../design/Button";
import { CreationDialog } from "./create/CreationDialog";
import { Icon } from "./icons";
import { LoadingBar } from "./LoadingScreen";
import type { OpenTarget, Opener } from "./Workspace";

const Settings = lazy(async () => ({ default: (await import("./Settings")).Settings }));
const AgentLogin = lazy(async () => ({ default: (await import("./AgentLogin")).AgentLogin }));

export function SettingsDialog({ target, projectName, open, onClose }: {
    target: OpenTarget; projectName?: string; open: Opener; onClose: () => void;
}) {
    const agent = target.resource_id === "agent-auth:claude_code" ? { protocol: "claude_code", name: "Claude Code" }
        : target.resource_id === "agent-auth:codex_cli" ? { protocol: "codex_cli", name: "Codex" } : null;
    const label = agent ? `${agent.name} 로그인` : target.title || "설정";
    return <CreationDialog label={label} onClose={onClose} width={agent ? "36em" : "76em"}>
        <Stack as="header" direction="horizontal" align="center" justify="between" gap={2}>
            <Heading level={2}>{label}</Heading>
            <Button type="button" appearance="icon" aria-label={agent ? "로그인 창 닫기" : "설정 닫기"} onClick={onClose}>
                <Icon name="close" size={16} />
            </Button>
        </Stack>
        <Stack height={agent ? undefined : "min(48em, calc(100dvh - 9em))"} isScrollable={Boolean(agent)}>
            <Suspense fallback={<LoadingBar label="설정 여는 중…" />}>
                {agent ? <AgentLogin key={agent.protocol} protocol={agent.protocol} name={agent.name} disabled={false} showName={false} />
                    : <Settings projectId={target.project_id} projectName={projectName}
                    sessionId={target.resource_id?.startsWith("session:") ? target.resource_id.slice(8) : undefined}
                    initialMenu={target.resource_id === "shortcuts" ? "shortcuts" : undefined}
                    open={(next, how) => { if (next.kind !== "settings") onClose(); open(next, how); }} />}
            </Suspense>
        </Stack>
    </CreationDialog>;
}
