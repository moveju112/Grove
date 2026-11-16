import { lazy, Suspense } from "react";
import { Stack } from "@astryxdesign/core/Stack";
import { Heading } from "@astryxdesign/core/Heading";
import { Button } from "../design/Button";
import { CreationDialog } from "./create/CreationDialog";
import { Icon } from "./icons";
import { LoadingBar } from "./LoadingScreen";
import type { OpenTarget, Opener } from "./Workspace";

const Settings = lazy(async () => ({ default: (await import("./Settings")).Settings }));

export function SettingsDialog({ target, projectName, open, onClose }: {
    target: OpenTarget; projectName?: string; open: Opener; onClose: () => void;
}) {
    return <CreationDialog label={target.title || "설정"} onClose={onClose} width="76em">
        <Stack as="header" direction="horizontal" align="center" justify="between" gap={2}>
            <Heading level={2}>{target.title || "설정"}</Heading>
            <Button type="button" appearance="icon" aria-label="설정 닫기" onClick={onClose}>
                <Icon name="close" size={16} />
            </Button>
        </Stack>
        <Stack height="min(48em, calc(100dvh - 9em))" isScrollable data-testid="settings-scroll">
            <Suspense fallback={<LoadingBar label="설정 여는 중…" />}>
                <Settings projectId={target.project_id} projectName={projectName}
                    sessionId={target.resource_id?.startsWith("session:") ? target.resource_id.slice(8) : undefined}
                    open={(next, how) => { if (next.kind !== "settings") onClose(); open(next, how); }} />
            </Suspense>
        </Stack>
    </CreationDialog>;
}
