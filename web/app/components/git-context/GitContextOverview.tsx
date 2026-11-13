import { useEffect, useMemo, useState } from "react";
import { readGitContext, type GitContext } from "../../api/gitContext";
import { ApiError } from "../../api/client";
import { useLive } from "../../state/store";
import { useServerBlockReason } from "../pwa/lifecycle";
import { contextLabel, contextMatches } from "./model";

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
        <h3 className="small">Git 위치 · PR/CI · 실행 권한</h3>
        <button className="ghost small" onClick={() => setRefresh((n) => n + 1)} disabled={!!unavailable}>개요 다시 확인</button>
        {unavailable ? <p role="status">{unavailable}</p> :
            !data ? <p role="status">{result?.owner === owner && result.error ? result.error === "denied" ? "프로젝트 개요 접근 거부 또는 대상 접근 불가" : result.error === "missing" ? "서버 Git 실행 파일 없음" : contextLabel[result.error] : "Git 개요 확인 중…"}</p> :
            data.status === "not_repo" ? <p>Git 저장소가 아닙니다.</p> : <>
                {data.status === "stale" && <p role="status">{contextLabel.stale}</p>}
                {location && <dl>
                    <dt>현재 위치</dt><dd>{location.kind === "unborn" ? "첫 커밋 전" : location.kind === "detached" ? "detached HEAD" : location.branch}</dd>
                    <dt>HEAD</dt><dd><code>{location.head ?? "없음"}</code></dd>
                    <dt>프로젝트 / worktree</dt><dd>프로젝트 {projectId} · {location.worktree === "linked" ? "linked worktree" : "주 worktree"} · 프로젝트 상대 위치 <code>{location.project_relative_to_worktree ?? "확인 불가"}</code> · Git 등록 {location.git_registered ? "확인" : "확인 불가"} · 총 {location.worktree_count}개</dd>
                </dl>}
                {github && <div>
                    <p className="small">GitHub {github.repository ?? "대상 없음"} · {github.remote} · 정확한 HEAD만 조회</p>
                    <p>PR: {contextLabel[githubCurrent ? github.pr.status : "stale"] ?? contextLabel.unknown}
                        {githubCurrent && github.pr.status === "ok" && github.pr.items?.map((pr) => <span key={pr.number}> · #{pr.number} {pr.state}{pr.draft ? " draft" : ""}</span>)}</p>
                    <p>CI: {contextLabel[githubCurrent ? github.ci.status : "stale"] ?? contextLabel.unknown}{githubCurrent && github.ci.count !== undefined && ` (${github.ci.count}개 check/status)`}</p>
                </div>}
                {authority && <div>
                    <p className="small">기기 권한: {authority.is_owner ? "소유자" : "인증된 기기"} · 직접 Git API는 인증된 기기에 열려 있습니다.</p>
                    <p className="small">모델 도구 정책: {authority.tool_mode} (프로젝트 기준, 대화별 정책은 별도). read_only는 모델 도구 제한이며 직접 Git 버튼을 승인하거나 금지하는 정책이 아닙니다.</p>
                    <p className="muted small">조회 시점의 사전조건이며 실행 허가가 아닙니다. 기존 서버 변경 API가 최종 판정합니다. 원격 쓰기 권한은 미확인이고 오프라인 제한은 별도입니다.</p>
                    {data.status !== "stale" && <table><thead><tr><th>작업</th><th>현재 제한</th></tr></thead><tbody>
                        {authority.actions.map((action) => <tr key={action.id}><td>{action.id}</td><td>{action.status === "blocked" ? "제한" : "실행 시 재검사"} · {action.reason}</td></tr>)}
                    </tbody></table>}
                </div>}
                <p className="muted small">조회 시점 {data.observed_at}. 자동 fetch·로그인·PR 변경·CI 재실행은 하지 않습니다.</p>
            </>}
    </section>;
}
