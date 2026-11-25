import { Stack } from "@astryxdesign/core/Stack";
import { Text as GroveText } from "@astryxdesign/core/Text";
import type { ReactNode } from "react";
import { api } from "../api/client";
import { useQuery } from "../state/store";
import type * as L from "../state/layout";
import { Button } from "../design/Button";
import { ServerActionButton } from "./pwa/ServerActionButton";
import { Icon } from "./icons";
import type { Opener } from "./Workspace";
import { workspaceStyles } from "./workspace.stylex";

type TerminalRow = { id: string; name: string; status: "running" | "exited" | "lost" };

/// 모바일 오른쪽 서랍의 터미널 구역. 열린 터미널 탭과 탭 없이 실행 중인 터미널을 함께 보이고, 터미널이 없어도 새 터미널 진입점은 남긴다.
export function MobileTerminals({ projectId, tabs, renderTab, open, onNewTerminal, newDisabled, safeEnd }: {
    projectId: string;
    tabs: L.Tab[];
    renderTab: (tab: L.Tab) => ReactNode;
    open: Opener;
    onNewTerminal: () => void;
    newDisabled: boolean;
    safeEnd: boolean;
}) {
    const list = useQuery<{ terminals: TerminalRow[] }>(`terminals:${projectId}`, () => api.get(`/projects/${projectId}/terminals`));
    const detached = (list.data?.terminals ?? []).filter((t) => t.status === "running" && !tabs.some((tab) => tab.resource_id === t.id));
    return <Stack as="section" gap={1} padding={2} isScrollable aria-label="터미널" data-testid="mobile-terminals"
        xstyle={[workspaceStyles.mobileTerminals, safeEnd && workspaceStyles.mobileSafeEnd]}>
        <Stack direction="horizontal" align="center" justify="between" gap={2}>
            <GroveText type="supporting" color="secondary" weight="medium">터미널</GroveText>
            <ServerActionButton type="button" variant="secondary" appearance="icon" aria-label="새 터미널" title="새 터미널"
                disabled={newDisabled} onClick={onNewTerminal}>
                <Icon name="plus" size={16} />
            </ServerActionButton>
        </Stack>
        {tabs.map(renderTab)}
        {detached.map((t) => <Button key={t.id} type="button" appearance="navigation" data-testid="mobile-terminal"
            onClick={() => open({ kind: "terminal", project_id: projectId, resource_id: t.id, title: t.name })}>
            {t.name}
        </Button>)}
    </Stack>;
}
