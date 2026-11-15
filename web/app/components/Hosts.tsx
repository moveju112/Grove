import { List as GroveList, ListItem as GroveListItem } from "@astryxdesign/core/List";
import { Code } from "@astryxdesign/core/Code";
import { Stack as GroveStack } from "@astryxdesign/core/Stack";
import { Text as GroveText } from "@astryxdesign/core/Text";
import { Heading as GroveHeading } from "@astryxdesign/core/Heading";
import { Link } from "@astryxdesign/core/Link";
import { Button as GroveButton } from "../design/Button";
import { useEffect, useState } from "react";
import { CreationDialog } from "./create/CreationDialog";
import { When } from "./When";
import { createPortal } from "react-dom";
import { HOSTS_KEY, insecureRemote, loadHosts, markHostOpened, recentHosts, removeHost, saveHost, type Host } from "../state/hosts";

import { Icon } from "./icons";
import { SentenceText } from "./HelpTip";
import { TextInput } from "../design/Fields";

/// 호스트별 페이지를 별도 탭으로 열어 요청·stream·메모리 상태를 섞지 않는다.
export function Hosts() {
    const [open, setOpen] = useState(false);
    return (
        <>
            <GroveButton type="button" appearance="disclosure" width="min(14em, 100%)" onClick={() => setOpen(true)} title={`현재 호스트: ${location.origin}`} aria-label={`호스트 선택: ${location.origin}`}>
                <Icon name="server" /><GroveText type="supporting" color="secondary" maxLines={1}>호스트 · {location.host}</GroveText>
            </GroveButton>
            {open && createPortal(<HostsDialog onClose={() => setOpen(false)} />, document.body)}
        </>
    );
}

function HostsDialog({ onClose }: { onClose: () => void }) {
    const [hosts, setHosts] = useState(() => loadHosts(localStorage));
    const [editing, setEditing] = useState<string | undefined>();
    const [alias, setAlias] = useState("");
    const [address, setAddress] = useState("");
    const [error, setError] = useState<string | null>(null);
    useEffect(() => {
        const changed = (e: StorageEvent) => {
            if (e.key === HOSTS_KEY || e.key === null) setHosts(loadHosts(localStorage));
        };
        window.addEventListener("storage", changed);
        return () => window.removeEventListener("storage", changed);
    }, []);

    const reset = () => {
        setEditing(undefined);
        setAlias("");
        setAddress("");
        setError(null);
    };
    const edit = (host: Host) => {
        setEditing(host.origin);
        setAlias(host.alias);
        setAddress(host.origin);
        setError(null);
    };
    const change = (operation: () => Host[]) => {
        try {
            setHosts(operation());
            setError(null);
            return true;
        } catch (e) {
            setError(e instanceof Error ? e.message : "호스트 목록을 저장하지 못했습니다.");
            return false;
        }
    };
    const close = onClose;
    return (
        <CreationDialog label="호스트 관리" onClose={close}>
            <GroveHeading level={2} color="inherit">호스트</GroveHeading>
            <GroveText as="p" display="block" type="supporting" color="inherit">현재 호스트: <Code>{location.origin}</Code></GroveText>
            <GroveList density="compact" edge="flush" hasDividers aria-label="등록한 호스트">
                {recentHosts(hosts).map((host) => (
                    <GroveListItem key={host.origin} data-testid="host-row" label={<>
                        <strong>{host.alias}</strong>
                        <Code>{host.origin}</Code>
                        {host.origin === location.origin && <GroveText type="supporting" color="inherit">현재 호스트</GroveText>}
                        <GroveText type="supporting" color="secondary">
                            {host.lastOpenedAt === null ? "아직 열지 않음" : <>최근 열기: <When at={new Date(host.lastOpenedAt).toISOString()} /></>}
                        </GroveText>
                        {insecureRemote(host.origin) && <GroveText as="p" display="block" type="supporting" color="warning"><SentenceText text="암호화되지 않은 HTTP입니다. 토큰과 대화가 노출될 수 있으니 HTTPS 또는 신뢰하는 VPN을 사용하세요." /></GroveText>}
                        <GroveStack direction="horizontal" align="center" wrap="wrap" gap={2}>
                            <Link type="inherit" href={host.origin + "/"} target="_blank" rel="noopener noreferrer" onClick={(e) => {
                                if (!change(() => markHostOpened(localStorage, host.origin))) e.preventDefault();
                            }}>새 탭에서 열기</Link>
                            <GroveButton type="button" variant="secondary" density="compact" onClick={() => edit(host)}>수정</GroveButton>
                            <GroveButton type="button" variant="secondary" density="compact" onClick={() => {
                                if (change(() => removeHost(localStorage, host.origin)) && editing === host.origin) reset();
                            }}>삭제</GroveButton>
                        </GroveStack>
                    </>} />
                ))}
            </GroveList>
            {hosts.length === 0 && <GroveText as="p" display="block" type="inherit" color="secondary">등록한 호스트가 없습니다.</GroveText>}
            <form aria-label={editing ? "호스트 수정" : "호스트 추가"} onSubmit={(e) => {
                e.preventDefault();
                if (change(() => saveHost(localStorage, address, alias, editing))) reset();
            }}>
                <TextInput label="별명" value={alias} maxLength={80} isRequired onChange={setAlias} autoComplete="off" />
                <TextInput label="서버 주소" type="url" value={address} isRequired onChange={setAddress} placeholder="https://grove.example.com" autoComplete="off" hasSpellCheck={false} />
                <GroveText as="p" display="block" type="supporting" color="secondary"><SentenceText text="서버 주소만 입력하고 비밀번호·토큰·페어링 링크는 넣지 마세요." /></GroveText>
                <GroveStack direction="horizontal" align="center" wrap="wrap" gap={2}>
                    <GroveButton type="submit">{editing ? "변경 저장" : "호스트 추가"}</GroveButton>
                    {editing && <GroveButton type="button" variant="secondary" onClick={reset}>수정 취소</GroveButton>}
                </GroveStack>
            </form>
            {error && <GroveText as="p" display="block" type="inherit" color="error" role="alert">{error}</GroveText>}
            <GroveButton type="button" variant="secondary" onClick={close}>닫기</GroveButton>
        </CreationDialog>
    );
}
