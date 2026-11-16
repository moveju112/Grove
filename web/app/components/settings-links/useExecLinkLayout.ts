import { api } from "../../api/client";
import { getSourceSettings } from "../../api/sourceSettings";
import { useQuery } from "../../state/store";

type Query = { data: unknown; error: unknown; loading: boolean };
const settled = (query: Query) => !query.loading && (query.data !== undefined || Boolean(query.error));

// exec 앞의 메뉴 내용도 비동기로 높이가 바뀐다. 기존 viewer와 같은 cache를 구독해
// 그 내용이 commit될 때까지 최초 이동을 보류하고, 링크 완료/취소 시 구독을 해제한다.
export function useExecLinkLayout(active: boolean, projectId: string | undefined) {
    const definitions = useQuery(active ? "definitions:agent" : null, () => api.get("/definitions?kind=agent"));
    const sources = useQuery(active ? `source-settings:${JSON.stringify(projectId ?? null)}` : null, () => getSourceSettings(projectId));
    const profiles = useQuery(active ? "profiles" : null, () => api.get("/model-profiles"));
    return !active || [definitions, sources, profiles].every(settled);
}
