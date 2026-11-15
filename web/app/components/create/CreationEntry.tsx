import { List as GroveList, ListItem as GroveListItem } from "@astryxdesign/core/List";
import { Stack as GroveStack } from "@astryxdesign/core/Stack";
import { Heading as GroveHeading } from "@astryxdesign/core/Heading";
import { Text as GroveText } from "@astryxdesign/core/Text";
import { Button as GroveButton } from "../../design/Button";
import { createContext } from "react";
import type { Project } from "../../api/generated";
import { CreationDialog } from "./CreationDialog";

export const CreationFocus = createContext<{ tabId: string; narrow: boolean; version: number } | null>(null);

export function CreationEntry({ projects, currentId, loading, error, blockedReason, onReload, onSelect, onAddProject, onClose }: {
    projects: Project[]; currentId?: string; loading: boolean; error: boolean;
    blockedReason?: string | null;
    onReload: () => void; onSelect: (project: Project) => void; onAddProject: () => void; onClose: () => void;
}) {
    const current = projects.find((project) => project.id === currentId);
    return <CreationDialog label="만들기" onClose={onClose}>
        <GroveHeading level={2} color="inherit">새 대화</GroveHeading>
        {blockedReason && <GroveText as="p" display="block" type="inherit" color="warning" role="status" data-testid="creation-blocked">{blockedReason} 프로젝트 선택·초안 편집·취소는 계속 사용할 수 있습니다.</GroveText>}
        {loading && <GroveText as="p" display="block" type="inherit" color="inherit" role="status">프로젝트 확인 중…</GroveText>}
        {error && <GroveText as="p" display="block" type="inherit" color="error" role="alert">프로젝트를 불러오지 못했습니다. <GroveButton onClick={onReload}>다시 확인</GroveButton></GroveText>}
        {currentId ? <>
            {current ? <>
                <GroveText as="p" display="block" type="inherit" color="inherit">현재 프로젝트: {current.name}</GroveText>
                {!current.available && <GroveText as="p" display="block" type="inherit" color="warning" role="status">프로젝트 경로 없음</GroveText>}
                <GroveButton disabled={!current.available || error || loading} onClick={() => onSelect(current)}>이 프로젝트에서 새 대화</GroveButton>
            </> : !loading && !error && <GroveText as="p" display="block" type="inherit" color="error" role="alert">현재 프로젝트를 확인할 수 없습니다. 다른 프로젝트로 자동 전환하지 않습니다.</GroveText>}
        </> : <>
            <GroveText as="p" display="block" type="inherit" color="inherit">대화를 시작할 프로젝트를 선택하세요.</GroveText>
            <GroveList density="compact" edge="flush" hasDividers aria-label="대화 프로젝트 선택">
                {projects.map((project) => <GroveListItem key={project.id} label={
                    <GroveButton appearance="link" disabled={!project.available || error || loading} onClick={() => onSelect(project)}>
                        {project.name}{!project.available && " (경로 없음)"}
                    </GroveButton>
                } />)}
            </GroveList>
            {!loading && !error && projects.length === 0 && <GroveText as="p" display="block" type="inherit" color="inherit" role="status">먼저 프로젝트를 추가하세요.</GroveText>}
        </>}
        <GroveStack direction="horizontal" align="center" wrap="wrap" gap={2}>
            <GroveButton variant="secondary" onClick={onAddProject}>프로젝트 추가</GroveButton>
            <GroveButton variant="secondary" onClick={onClose}>취소</GroveButton>
        </GroveStack>
    </CreationDialog>;
}
