import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, it, vi } from "vitest";
import { api } from "../../api/client";
import { Composer } from "../Composer";
import { ProjectComposer } from "./ProjectComposer";

vi.mock("../../api/client", () => ({ api: { post: vi.fn() } }));
vi.mock("../Composer", () => ({ Composer: vi.fn(() => null) }));

beforeEach(() => vi.resetAllMocks());

function renderComposer() {
    const open = vi.fn();
    renderToStaticMarkup(createElement(ProjectComposer, { projectId: "project", tabId: "tab", open, disabled: null }));
    const props = vi.mocked(Composer).mock.calls[0]![0] as ComponentProps<typeof Composer>;
    expect(props.resourceKey).toBe("project:project");
    expect(props.copyId).toBe("tab");
    expect(api.post).not.toHaveBeenCalled();
    return { props, open };
}

it.each(["save", "model"] as const)("기존 %s 전송 계약·첨부·파생 키를 유지한다", async (mode) => {
    const { props, open } = renderComposer();
    vi.mocked(api.post).mockResolvedValueOnce({ id: "session", title: "첫 줄" }).mockResolvedValueOnce({});
    const options = { mode, profileId: "profile", agentId: "agent", tools: true, effort: "high" as const };
    await props.onSend("첫 줄\n본문", options, "intent", undefined, ["attachment"]);
    expect(api.post).toHaveBeenNthCalledWith(1, "/projects/project/sessions", { title: "첫 줄" }, { key: "intent:session" });
    expect(api.post).toHaveBeenNthCalledWith(2, `/sessions/session/${mode === "save" ? "messages" : "turns"}`,
        mode === "save" ? { text: "첫 줄\n본문", attachments: ["attachment"] }
            : { text: "첫 줄\n본문", attachments: ["attachment"], profile_id: "profile", agent_id: "agent", tools: true, effort: "high" },
        { key: "intent:send" });
    expect(open).toHaveBeenCalledExactlyOnceWith({ kind: "session", project_id: "project", resource_id: "session", title: "첫 줄" });
});

it("전송 응답 유실 뒤 재확인은 생성·전송 모두 같은 키이며 성공 전에는 이동하지 않는다", async () => {
    const { props, open } = renderComposer();
    const session = { id: "session", title: "첫 줄" };
    vi.mocked(api.post).mockResolvedValueOnce(session).mockRejectedValueOnce(new Error("response lost"))
        .mockResolvedValueOnce(session).mockResolvedValueOnce({});
    const options = { mode: "save" as const, profileId: null, agentId: null, tools: false };
    await expect(props.onSend("첫 줄", options, "intent")).rejects.toThrow("response lost");
    expect(open).not.toHaveBeenCalled();
    await props.onSend("첫 줄", options, "intent");
    expect(vi.mocked(api.post).mock.calls[2]).toEqual(vi.mocked(api.post).mock.calls[0]);
    expect(vi.mocked(api.post).mock.calls[3]).toEqual(vi.mocked(api.post).mock.calls[1]);
    expect(open).toHaveBeenCalledTimes(1);
});
