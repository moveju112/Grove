import { Text as GroveText } from "@astryxdesign/core/Text";
import { Button as GroveButton } from "../../design/Button";
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
    return <div data-testid="source-settings">
        <GroveText as="p" display="block" type="supporting" color="secondary">{projectId ? "프로젝트 원본" : "서버 사용자 원본"} · 소유자 전용</GroveText>
        <SourceSettingsPanel view={view} />
        <GroveButton className="ghost" disabled={query.loading} onClick={query.reload}>원본 출처 다시 조회</GroveButton>
    </div>;
}
