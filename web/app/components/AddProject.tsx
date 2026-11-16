import { List as GroveList, ListItem as GroveListItem } from "@astryxdesign/core/List";
import { Stack as GroveStack } from "@astryxdesign/core/Stack";
import { Heading as GroveHeading } from "@astryxdesign/core/Heading";
import { Text as GroveText } from "@astryxdesign/core/Text";
import { Button as GroveButton } from "../design/Button";
import { useEffect, useRef, useState } from "react";
import { DetailDialog } from "./ui/Controls";
import { ApiError, api } from "../api/client";
import type { Project } from "../api/generated";
import { CreationDialog } from "./create/CreationDialog";
import { ProjectCreation } from "./create/creation";
import { TextInput } from "../design/Fields";
import { DisabledGroup } from "../design/DisabledGroup";
import { Select } from "../design/Select";

type Dirs = { path: string; parent: string | null; entries: { name: string; path: string }[]; truncated: boolean };

/// 프로젝트 추가(PROJECT-001): 서버 PC의 기존 폴더를 둘러보거나 경로를 입력해 등록한다.
export function AddProjectDialog({ onDone, onClose, blockedReason, beforeMutation }: {
    onDone: (p: Project) => void; onClose: () => void; blockedReason?: string | null; beforeMutation?: () => void;
}) {
    const [path, setPath] = useState("");
    const [dirs, setDirs] = useState<Dirs | null>(null);
    const [err, setErr] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const [creation] = useState(() => new ProjectCreation());
    const done = useRef(onDone);
    done.current = onDone;
    const unresolved = creation.pending !== null;
    const close = () => { if (!creation.busy && !creation.pending) onClose(); };
    // 늦게 도착한 이전 요청의 응답이 최근 이동을 덮어쓰지 않게 마지막 요청만 반영한다.
    const seq = useRef(0);

    /// `fill`이 거짓이면 목록만 바꾸고 경로 칸은 건드리지 않는다(처음 열 때).
    /// 사용자가 입력하는 도중에 응답이 와서 칸 내용이 바뀌는 일을 막는다.
    const browse = async (p?: string, fill = true) => {
        const my = ++seq.current;
        setErr(null);
        try {
            const q = new URLSearchParams();
            if (p) q.set("path", p);
            const d = await api.get<Dirs>(`/fs/dirs?${q}`);
            if (my !== seq.current) return;
            setDirs(d);
            if (fill) setPath(d.path);
        } catch (e) {
            if (my !== seq.current) return;
            setErr(e instanceof ApiError ? e.message : "폴더를 읽지 못했습니다");
        }
    };
    // 경로 입력 제안(PROJECT-012): 입력이 멈추면 서버 PC의 맞는 폴더를 보인다. 늦은 응답은 버린다.
    const [suggestions, setSuggestions] = useState<string[]>([]);
    const suggestSeq = useRef(0);
    useEffect(() => {
        const q = path.trim();
        const my = ++suggestSeq.current;
        if (!q || q === dirs?.path) { setSuggestions([]); return; }
        const t = setTimeout(() => {
            api.get<{ directories: string[] }>(`/fs/suggest?${new URLSearchParams({ q, limit: "8" })}`)
                .then((r) => { if (my === suggestSeq.current) setSuggestions(r.directories); })
                .catch(() => { if (my === suggestSeq.current) setSuggestions([]); });
        }, 250);
        return () => clearTimeout(t);
    }, [path, dirs?.path]);
    // 처음 열면 서버 사용자의 홈 폴더를 보여 준다.
    useEffect(() => {
        void browse(dirs?.path, false);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const submit = async (endpoint: "/projects" | "/projects/clone", body: Record<string, unknown>) => {
        if (creation.busy) return;
        setBusy(true);
        setErr(null);
        try {
            beforeMutation?.();
            const project = await creation.run(endpoint, body);
            if (project) done.current(project);
        } catch (e) {
            setErr(e instanceof Error ? e.message : "프로젝트를 추가하지 못했습니다");
        } finally {
            setBusy(false);
        }
    };

    return (
        <CreationDialog label="프로젝트 추가" onClose={close} busy={busy} footer={
            <DisabledGroup disabled={busy || unresolved}>
                <GroveStack direction="horizontal" align="center" wrap="wrap" gap={2}>
                    <GroveButton disabled={!path.trim() || !!blockedReason} title={blockedReason ?? undefined} onClick={() => void submit("/projects", { root_path: path.trim() })}>
                        이 폴더를 프로젝트로 추가
                    </GroveButton>
                    <GroveButton variant="secondary" onClick={close}>취소</GroveButton>
                </GroveStack>
                <DetailDialog label="저장소에서 clone" title="저장소에서 clone">
                    <CloneRepo target={dirs?.path ?? ""} blockedReason={blockedReason} onCreate={(body) => submit("/projects/clone", body)} />
                </DetailDialog>
            </DisabledGroup>
        }>
                <GroveHeading level={2} color="inherit">프로젝트 추가</GroveHeading>
                {blockedReason && <GroveText as="p" display="block" type="inherit" color="warning" role="status" data-testid="project-add-blocked">{blockedReason} 경로 입력·복사·취소는 계속 사용할 수 있습니다.</GroveText>}
                {err && <GroveText as="p" display="block" type="inherit" color="error" role="alert">{err}</GroveText>}
                {busy && <GroveText as="p" display="block" type="inherit" color="inherit" role="status">프로젝트 추가 중…</GroveText>}
                {unresolved && !busy && <GroveText as="div" display="block" type="inherit" color="warning" role="status">
                    생성 결과를 확인하지 못했습니다. 결과 확인 전에는 다른 생성 요청이나 닫기를 사용할 수 없습니다.
                    <GroveButton disabled={!!blockedReason} title={blockedReason ?? undefined} onClick={() => { const request = creation.pending!; void submit(request.path, request.body); }}>같은 생성 요청 결과 확인</GroveButton>
                </GroveText>}
                <DisabledGroup disabled={busy || unresolved}>
                    <TextInput label="서버 PC의 폴더 경로"
                        value={path}
                        onChange={(value) => {
                            // 직접 입력하면 진행 중인 둘러보기 응답이 입력을 덮어쓰지 않는다.
                            seq.current++;
                            setPath(value);
                        }}
                        onKeyDown={(e) => e.key === "Enter" && void browse(path)}
                        placeholder={dirs?.path ?? "/절대/경로"}
                        aria-label="폴더 경로"
                        hasAutoFocus
                    />
                {suggestions.length > 0 && (
                    <GroveList density="compact" edge="flush" hasDividers aria-label="경로 제안">
                        {suggestions.map((s) => (
                            <GroveListItem key={s} label={<GroveButton density="compact" appearance="link" onClick={() => { setSuggestions([]); void browse(s); }}>{s}</GroveButton>} />
                        ))}
                    </GroveList>
                )}
                <GroveStack direction="horizontal" align="center" wrap="wrap" gap={2}>
                    <GroveButton variant="secondary" density="compact" onClick={() => void browse(path)}>이 경로 열기</GroveButton>
                    <GroveButton variant="secondary" density="compact" disabled={!dirs?.parent} onClick={() => dirs?.parent && void browse(dirs.parent)}>
                        상위 폴더
                    </GroveButton>
                </GroveStack>
                {dirs && (
                    <GroveText as="p" display="block" type="supporting" color="secondary" data-testid="dir-current">
                        현재 위치: <code>{dirs.path}</code>
                    </GroveText>
                )}
                {dirs && (
                    <GroveList density="compact" edge="flush" hasDividers aria-label="하위 폴더">
                        {dirs.entries.length === 0 && <GroveListItem label={<GroveText type="supporting" color="secondary">하위 폴더 없음</GroveText>} />}
                        {dirs.entries.map((d) => (
                            <GroveListItem key={d.path} label={
                                <GroveButton appearance="link" onClick={() => void browse(d.path)}>
                                    📁 {d.name}
                                </GroveButton>
                            } />
                        ))}
                        {dirs.truncated && <GroveListItem label={<GroveText type="supporting" color="secondary">폴더가 많아 일부만 표시합니다. 경로를 직접 입력하세요</GroveText>} />}
                    </GroveList>
                )}
                </DisabledGroup>
        </CreationDialog>
    );
}

type Repo = { full_name: string; name: string; description: string | null; private: boolean; url: string };
type Search = { status: "success" | "unavailable" | "unauthenticated" | "error"; repositories: Repo[]; error: string | null };

/// 저장소 clone(PROJECT-012): GitHub 저장소를 서버 PC의 gh로 찾거나 owner/name·원격 주소를 직접 입력해
/// 대상 폴더 아래 `<저장소 이름>`으로 받고 프로젝트로 등록한다. 응답을 받지 못하면 같은 키로만 다시 확인한다.
function CloneRepo({ target: initialTarget, blockedReason, onCreate }: {
    target: string; blockedReason?: string | null; onCreate: (body: Record<string, unknown>) => Promise<void>;
}) {
    const [repo, setRepo] = useState("");
    const [protocol, setProtocol] = useState<"https" | "ssh">("https");
    const [target, setTarget] = useState(initialTarget);
    const [query, setQuery] = useState("");
    const [search, setSearch] = useState<Search | null>(null);
    const [err, setErr] = useState<string | null>(null);
    useEffect(() => { if (!target && initialTarget) setTarget(initialTarget); }, [initialTarget]); // eslint-disable-line react-hooks/exhaustive-deps
    const slug = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo.trim());

    const find = async () => {
        setErr(null);
        try {
            setSearch(await api.get<Search>(`/github/repos?${new URLSearchParams({ q: query.trim(), limit: "20" })}`));
        } catch (e) {
            setErr(e instanceof ApiError ? e.message : "저장소를 검색하지 못했습니다");
        }
    };
    const clone = async () => {
        const body = { repo: repo.trim(), target_directory: target.trim(), ...(slug ? { protocol } : {}) };
        await onCreate(body);
    };
    return <GroveStack gap={2} role="group" aria-label="저장소 clone">
        <GroveStack direction="horizontal" align="center" wrap="wrap" gap={2}>
            <TextInput label="GitHub 저장소 검색" isLabelHidden placeholder="검색어(비우면 내 저장소)" value={query} onChange={setQuery}
                onKeyDown={(e) => e.key === "Enter" && void find()} />
            <GroveButton variant="secondary" density="compact" onClick={() => void find()}>검색</GroveButton>
        </GroveStack>
        {search && search.status !== "success" && <GroveText as="p" display="block" type="supporting" color="warning" role="status">{search.error}</GroveText>}
        {search?.status === "success" && (
            <GroveList density="compact" edge="flush" hasDividers>
                {search.repositories.length === 0 && <GroveListItem label={<GroveText type="supporting" color="secondary">결과 없음</GroveText>} />}
                {search.repositories.map((r) => (
                    <GroveListItem key={r.full_name} label={<>
                        <GroveButton appearance="link" onClick={() => setRepo(r.full_name)}>{r.full_name}{r.private ? " 🔒" : ""}</GroveButton>
                        {r.description && <GroveText type="supporting" color="secondary"> {r.description}</GroveText>}
                    </>} />
                ))}
            </GroveList>
        )}
        <TextInput label="저장소(owner/name 또는 원격 주소)" aria-label="clone할 저장소" value={repo} onChange={setRepo} placeholder="owner/name" />
        {slug && <Select label="clone 방식" value={protocol} onChange={(value) => setProtocol(value === "ssh" ? "ssh" : "https")}
            options={[{ value: "https", label: "https" }, { value: "ssh", label: "ssh" }]} />}
        <TextInput label="받을 상위 폴더" aria-label="clone 대상 폴더" value={target} onChange={setTarget} placeholder="/절대/경로 또는 ~/code" />
        {err && <GroveText as="p" display="block" type="inherit" color="error" role="alert">{err}</GroveText>}
        <GroveButton disabled={!repo.trim() || !target.trim() || !!blockedReason} title={blockedReason ?? undefined} onClick={() => void clone()}>clone 후 프로젝트로 추가</GroveButton>
    </GroveStack>;
}
