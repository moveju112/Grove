import { Heading } from "@astryxdesign/core/Heading";
import { List } from "@astryxdesign/core/List";
import { ScrollableArea } from "@astryxdesign/core/ScrollableArea";
import { Stack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Button } from "../../design/Button";
import { TextInput } from "../../design/Fields";
import { gitPanelStyles } from "./git-panel.stylex";
import { api } from "../../api/client";
import { useQuery } from "../../state/store";
import type { GitEntry, GitStatusPage } from "../../api/generated";
export type { GitEntry } from "../../api/generated";
import { useDebouncedValue } from "../../state/useDebouncedValue";

const PAGE_SIZE = 50;

/** 검색은 전체 상태에 적용하고, 페이지를 옮겨도 Git 작업의 대상과 fingerprint는 바꾸지 않는다. */
export function GitChangeList({ title, projectId, snapshot, staged, initial, renderRow }: {
    title: string; projectId: string; snapshot?: string; staged: boolean;
    /** 요약 응답에 함께 온 같은 스냅샷의 첫 페이지. 있으면 첫 페이지를 다시 요청하지 않는다. */
    initial?: GitStatusPage;
    renderRow: (entry: GitEntry, fingerprint: string | null) => ReactNode;
}) {
    const [view, setView] = useState({ query: "", page: 0 });
    const scroll = useRef<HTMLDivElement>(null);
    const settledQuery = useDebouncedValue(view.query);
    const query = settledQuery.trim().toLocaleLowerCase();
    const scope = `git:${projectId}:entries:${snapshot ?? "none"}:${staged}:${query}`;
    const seeded = view.page === 0 && !query && !view.query && !!initial && !!snapshot && initial.fingerprint === snapshot ? initial : undefined;
    const fetched = useQuery<GitStatusPage>(seeded ? null : `${scope}:${view.page}`,
        () => api.getContract("GitStatusPage", `/projects/${projectId}/git/status?staged=${staged}&offset=${view.page * PAGE_SIZE}&limit=${PAGE_SIZE}&filter=${encodeURIComponent(query)}${snapshot ? `&snapshot=${encodeURIComponent(snapshot)}` : ""}`, { requires: ["paged_reads_v1"] }),
        { keepPreviousData: true, scope });
    const result = seeded ? { data: seeded, loading: false, error: null as unknown } : fetched;
    const data = result.data;
    const total = data?.unfiltered_total ?? 0;
    const filtered = data?.total ?? 0;
    const lastPage = Math.max(0, Math.ceil(filtered / PAGE_SIZE) - 1);
    const page = view.page;
    const start = page * PAGE_SIZE;
    useEffect(() => { scroll.current?.scrollTo({ top: 0 }); }, [page, query]);
    useEffect(() => {
        if (data && !result.loading && page > lastPage) setView((view) => ({ ...view, page: lastPage }));
    }, [data, result.loading, page, lastPage]);
    return <Stack as="section" gap={2} aria-label={title} xstyle={gitPanelStyles.shrink}>
        <Heading level={3} color="inherit">{title} ({total})</Heading>
        {(total > PAGE_SIZE || view.query || page > 0) && <>
            <TextInput type="search" size="sm" label={`${title} 검색`} isLabelHidden placeholder="변경 파일 검색"
                value={view.query} onChange={(value) => setView({ query: value, page: 0 })} />
            <Stack direction="horizontal" align="center" justify="between" gap={2}>
                <Text type="supporting" color="secondary" role="status" data-testid="git-change-range">
                    {query ? `검색 결과 ${filtered}개 · 전체 ${total}개` : `${start + 1}–${Math.min(start + PAGE_SIZE, filtered)} / ${total}개`}
                </Text>
                {(filtered > PAGE_SIZE || page > 0) && <Stack direction="horizontal" align="center" gap={2} xstyle={gitPanelStyles.actions}>
                    <Button type="button" variant="secondary" density="compact" aria-label={`${title} 이전 페이지`} disabled={page === 0 || result.loading}
                        onClick={() => setView({ ...view, page: page - 1 })}>이전</Button>
                    <Button type="button" variant="secondary" density="compact" aria-label={`${title} 다음 페이지`} disabled={!data?.has_more || result.loading}
                        onClick={() => setView({ ...view, page: page + 1 })}>다음</Button>
                </Stack>}
            </Stack>
        </>}
        {result.error instanceof Error && <Text type="supporting" color="error" role="alert">{result.error.message}</Text>}
        {!!data?.entries.length ? <ScrollableArea ref={scroll} label={`${title} 파일 목록`} xstyle={gitPanelStyles.viewport}>
            <List density="compact" edge="flush" hasDividers>{data.entries.map((entry) => renderRow(entry, data.fingerprint))}</List>
        </ScrollableArea> : !result.loading && <Text type="supporting" color="secondary">{query ? "일치하는 파일이 없어요." : "변경 없음"}</Text>}
    </Stack>;
}
