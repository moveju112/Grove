import { Heading as GroveHeading } from "@astryxdesign/core/Heading";
import { Text as GroveText } from "@astryxdesign/core/Text";
import { Table, TableHeader, TableBody, TableRow, TableHeaderCell, TableCell } from "@astryxdesign/core/Table";
import { Button as GroveButton } from "../../design/Button";
import { useEffect, useMemo, useState } from "react";
import { readGitContext, type GitContext } from "../../api/gitContext";
import { ApiError } from "../../api/client";
import { useLive } from "../../state/store";
import { useServerBlockReason } from "../pwa/lifecycle";
import { contextLabel, contextMatches } from "./model";
import { HelpTip, SentenceText } from "../HelpTip";

/** 요청 수명은 project/HEAD/갱신 신호/연결 상태에 묶고 이전 결과는 재검증 중 숨긴다. */
export function GitContextOverview({ projectId, head, refreshSignal }: {
    projectId: string; head?: string; refreshSignal?: unknown;
}) {
    const blockReason = useServerBlockReason();
    const connection = useLive((live) => live.status);
    const unavailable = blockReason ?? (connection !== "live" ? "실시간 연결을 다시 확인하고 있습니다. 이전 개요는 현재 상태로 표시하지 않습니다." : null);
    const [refresh, setRefresh] = useState(0);
    const [result, setResult] = useState<{ owner: object; data?: GitContext; error?: "unknown" | "stale" | "denied" | "missing" | "timeout" } | null>(null);
    const owner = useMemo(() => ({}), [projectId, head, refreshSignal, refresh, unavailable]);
    useEffect(() => {
        setResult(null);
        if (unavailable) return;
        let active = true;
        // status cache의 HEAD는 무효화 신호다. 재접속 때 cache가 늦어도 서버의 최신 HEAD를 조회한다.
        void readGitContext(projectId).then((data) => {
            if (active) setResult({ owner, ...(contextMatches(data, projectId) ? { data } : { error: "stale" }) });
        }, (error: unknown) => {
            if (active) setResult({ owner, error: error instanceof ApiError
                ? error.status === 401 || error.status === 403 || error.status === 404 ? "denied"
                    : error.code === "dependency_missing" ? "missing"
                        : error.code === "timeout" || error.code === "request_timeout" ? "timeout" : "unknown"
                : "unknown" });
        });
        return () => { active = false; };
    }, [projectId, owner, unavailable]);
    // 렌더와 effect 사이에도 다른 프로젝트의 결과를 표시하지 않는다.
    const data = result?.owner === owner && result?.data && contextMatches(result.data, projectId) ? result.data : null;
    const location = data?.location;
    const github = data?.github;
    const authority = data?.authority;
    const githubCurrent = data?.status === "ok" && github?.head === location?.head;
    return <section data-testid="git-context" aria-label="Git 위치와 실행 권한">
        <GroveHeading level={3} color="inherit" className="small">Git 위치 · PR/CI · 실행 권한</GroveHeading>
        <GroveButton className="ghost small" onClick={() => setRefresh((n) => n + 1)} disabled={!!unavailable}>개요 다시 확인</GroveButton>
        {unavailable ? <GroveText as="p" display="block" type="inherit" color="inherit" role="status">{unavailable}</GroveText> :
            !data ? <GroveText as="p" display="block" type="inherit" color="inherit" role="status">{result?.owner === owner && result.error ? result.error === "denied" ? "프로젝트 개요 접근 거부 또는 대상 접근 불가" : result.error === "missing" ? "서버 Git 실행 파일 없음" : contextLabel[result.error] : "Git 개요 확인 중…"}</GroveText> :
            data.status === "not_repo" ? <GroveText as="p" display="block" type="inherit" color="inherit">Git 저장소가 아닙니다.</GroveText> : <>
                {data.status === "stale" && <GroveText as="p" display="block" type="inherit" color="inherit" role="status">{contextLabel.stale}</GroveText>}
                {location && <dl>
                    <dt>현재 위치</dt><dd>{location.kind === "unborn" ? "첫 커밋 전" : location.kind === "detached" ? "detached HEAD" : location.branch}</dd>
                    <dt>HEAD</dt><dd><code>{location.head ?? "없음"}</code></dd>
                    <dt>프로젝트 / worktree</dt><dd>프로젝트 {projectId} · {location.worktree === "linked" ? "linked worktree" : "주 worktree"} · 프로젝트 상대 위치 <code>{location.project_relative_to_worktree ?? "확인 불가"}</code> · Git 등록 {location.git_registered ? "확인" : "확인 불가"} · 총 {location.worktree_count}개</dd>
                </dl>}
                {github && <div>
                    <GroveText as="p" display="block" type="supporting" color="inherit">GitHub {github.repository ?? "대상 없음"} · {github.remote} · 정확한 HEAD만 조회</GroveText>
                    <GroveText as="p" display="block" type="inherit" color="inherit">PR: {contextLabel[githubCurrent ? github.pr.status : "stale"] ?? contextLabel.unknown}
                        {githubCurrent && github.pr.status === "ok" && github.pr.items?.map((pr) => <GroveText type="inherit" color="inherit" key={pr.number}> · #{pr.number} {pr.state}{pr.draft ? " draft" : ""}</GroveText>)}</GroveText>
                    <GroveText as="p" display="block" type="inherit" color="inherit">CI: {contextLabel[githubCurrent ? github.ci.status : "stale"] ?? contextLabel.unknown}{githubCurrent && github.ci.count !== undefined && ` (${github.ci.count}개 check/status)`}</GroveText>
                </div>}
                {authority && <div>
                    <GroveText as="p" display="block" type="supporting" color="inherit">기기 권한: {authority.is_owner ? "소유자" : "인증된 기기"}</GroveText>
                    <GroveText as="p" display="block" type="supporting" color="inherit">모델 도구 정책: {authority.tool_mode} <HelpTip label="Git 실행 권한 도움말">
                        <SentenceText text="프로젝트 기준이며 대화별 정책은 별도입니다. read_only는 모델 도구만 제한하며 직접 Git 버튼의 권한은 아닙니다. 직접 Git API는 인증된 기기에 열려 있고, 실행 시 서버가 최종 판정합니다. 원격 쓰기 권한은 미확인이며 오프라인 제한은 별도입니다. 자동 fetch·로그인·PR 변경·CI 재실행은 하지 않습니다." />
                    </HelpTip></GroveText>
                    <GroveText as="p" display="block" type="supporting" color="secondary">조회 결과는 실행 허가가 아닙니다.</GroveText>
                    {data.status !== "stale" && <Table density="compact"><TableHeader><TableRow isHeaderRow><TableHeaderCell scope="col">작업</TableHeaderCell><TableHeaderCell scope="col">현재 제한</TableHeaderCell></TableRow></TableHeader><TableBody>
                        {authority.actions.map((action) => <TableRow key={action.id}><TableHeaderCell scope="row">{action.id}</TableHeaderCell><TableCell>{action.status === "blocked" ? "제한" : "실행 시 재검사"} · {action.reason}</TableCell></TableRow>)}
                    </TableBody></Table>}
                </div>}
                <GroveText as="p" display="block" type="supporting" color="secondary">조회 시점 {data.observed_at}</GroveText>
            </>}
    </section>;
}
