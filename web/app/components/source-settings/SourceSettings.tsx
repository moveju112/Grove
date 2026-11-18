import { Stack as GroveStack } from "@astryxdesign/core/Stack";
import { Text as GroveText } from "@astryxdesign/core/Text";
import { Button as GroveButton } from "../../design/Button";
import { Collapsible } from "@astryxdesign/core/Collapsible";
import { getSourceSettings } from "../../api/sourceSettings";
import { useQuery } from "../../state/store";
import { SourceSettingsPanel } from "./SourceSettingsPanel";
import type { SourceSettingsView } from "./types";

/** 프로젝트를 바꾸면 cache 키도 바꿔 이전 프로젝트의 원본을 표시하지 않는다. */
export function SourceSettings({ projectId }: { projectId?: string }) {
    const query = useQuery(`source-settings:${JSON.stringify(projectId ?? null)}`, () => getSourceSettings(projectId));
    const view: SourceSettingsView = query.error
        ? { status: "error" }
        : query.loading || !query.data
            ? { status: "loading" }
            : { status: "ready", items: query.data.items, resources: query.data.resources };
    return <GroveStack gap={2} data-testid="source-settings">
        <GroveText as="p" display="block" type="supporting" color="secondary">Claude와 Codex에서 관리하는 설정이에요.</GroveText>
        <Collapsible trigger="원본 설정 보기" defaultIsOpen={false}>
            <GroveStack gap={2}>
                <SourceSettingsPanel view={view} />
                <GroveButton variant="secondary" disabled={query.loading} onClick={query.reload}>원본 출처 다시 조회</GroveButton>
            </GroveStack>
        </Collapsible>
    </GroveStack>;
}
