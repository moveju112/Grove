import { useState } from "react";
import { Stack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { List, ListItem } from "@astryxdesign/core/List";
import { Button } from "../design/Button";
import { TextInput } from "../design/Fields";
import { Select } from "../design/Select";
import { api } from "../api/client";
import type { BotRoom } from "../api/generated";
import { useQuery } from "../state/store";
import type { Opener } from "./Workspace";
import { ServerActionButton } from "./pwa/ServerActionButton";
import { useReceiptMutation } from "../state/useReceiptMutation";

type Member = { id: string; name: string; project_id: string; status: string };

export function BotRooms({ bots, creating, onDone, open }: { bots: Member[]; creating: boolean; onDone: () => void; open: Opener }) {
    const rooms = useQuery<BotRoom[]>("bot-rooms", () => api.get("/bot-rooms", { requires: ["bot_rooms_v1"] }));
    const projects = useQuery<{ id: string; name: string }[]>("projects", () => api.get("/projects"));
    const [project, setProject] = useState("");
    const [name, setName] = useState("");
    const [members, setMembers] = useState(["", ""]);
    const mutation = useReceiptMutation((body: { name: string; project_id: string; member_ids: string[] }, key) =>
        api.post<BotRoom>("/bot-rooms", body, { key, requires: ["bot_rooms_v1"], contract: "BotRoom" }));
    const pid = project || projects.data?.[0]?.id || "";
    const available = bots.filter((b) => b.project_id === pid && b.status === "active");
    const create = async () => {
        const room = await mutation.submit({ name, project_id: pid, member_ids: members });
        if (!room) return;
        rooms.reload();
        setName("");
        setMembers(["", ""]);
        onDone();
        open({ kind: "session", project_id: room.project_id, resource_id: room.session_id, title: room.name });
    };
    return <Stack gap={2} data-testid="bot-rooms">
        {creating && <Stack as="form" gap={2} data-testid="bot-room-editor" onSubmit={(e) => { e.preventDefault(); void create(); }}>
            <TextInput label="그룹 이름" value={name} onChange={setName} isDisabled={mutation.blocked} />
            <Select label="그룹 프로젝트" value={pid} disabled={mutation.blocked} options={(projects.data ?? []).map((p) => ({ value: p.id, label: p.name }))}
                onChange={(id) => { setProject(id); setMembers(["", ""]); }} />
            {members.map((id, i) => <Select key={i} label={`참여 봇 ${i + 1}`} value={id} disabled={mutation.blocked}
                options={[{ value: "", label: "봇 선택" }, ...available.map((b) => ({ value: b.id, label: b.name, disabled: members.includes(b.id) && b.id !== id }))]}
                onChange={(value) => setMembers((prev) => prev.map((old, n) => n === i ? value : old))} />)}
            <Stack direction="horizontal" gap={1.5}>
                {members.length < 8 && <Button type="button" variant="secondary" density="compact" disabled={mutation.blocked} onClick={() => setMembers([...members, ""])}>참여 봇 추가</Button>}
                {members.length > 2 && <Button type="button" variant="secondary" density="compact" disabled={mutation.blocked} onClick={() => setMembers(members.slice(0, -1))}>마지막 봇 제외</Button>}
            </Stack>
            <Stack direction="horizontal" gap={1.5}>
                <ServerActionButton type="submit" disabled={mutation.busy || !name.trim() || members.some((id) => !id)}>{mutation.pending ? "같은 그룹 요청 확인" : "그룹 만들기"}</ServerActionButton>
                <Button type="button" variant="secondary" density="compact" disabled={mutation.blocked} onClick={onDone}>취소</Button>
            </Stack>
            {mutation.error && <Text color="error" role="alert">{mutation.error}</Text>}
        </Stack>}
        {!!rooms.error && <Text color="error" role="alert">그룹을 불러오지 못했어요</Text>}
        {!!rooms.data?.length && <List aria-label="봇 그룹" density="compact" edge="flush" hasDividers>
            {rooms.data.map((room) => <ListItem key={room.session_id} label={<ServerActionButton appearance="navigation"
                onClick={() => open({ kind: "session", project_id: room.project_id, resource_id: room.session_id, title: room.name })}>{room.name}</ServerActionButton>} />)}
        </List>}
    </Stack>;
}
