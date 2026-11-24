import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, it, vi } from "vitest";
import { api } from "../../api/client";
import { Composer } from "../Composer";
import { ProjectComposer } from "./ProjectComposer";

vi.mock("../../api/client", () => ({ api: { post: vi.fn() }, authGeneration: () => 0 }));
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
    const options = { mode, profileId: "profile", model: "request-model", agentId: "agent", tools: true, effort: "high" as const, serviceTier: "priority" };
    await props.onSend("첫 줄\n본문", options, "intent", undefined, ["attachment"]);
    expect(api.post).toHaveBeenNthCalledWith(1, "/projects/project/sessions", { title: "첫 줄" }, { key: "intent:session" });
    expect(api.post).toHaveBeenNthCalledWith(2, `/sessions/session/${mode === "save" ? "messages" : "turns"}`,
        mode === "save" ? { text: "첫 줄\n본문", attachments: ["attachment"] }
            : { text: "첫 줄\n본문", attachments: ["attachment"], profile_id: "profile", model: "request-model", agent_id: "agent", tools: true, effort: "high", service_tier: "priority" },
        mode === "save" ? { key: "intent:send" } : { key: "intent:send", requires: ["turn_model_selection_v1", "turn_model_options_v1"] });
    expect(open).toHaveBeenCalledExactlyOnceWith({ kind: "session", project_id: "project", resource_id: "session", title: "첫 줄" });
});

it("생성 접수 직후 실제 대화로 이동하고 응답 유실 시 그 대화의 전송 키로 확인한다", async () => {
    const { props, open } = renderComposer();
    const move = vi.fn();
    vi.mocked(api.post).mockResolvedValueOnce({ id: "session", title: "첫 줄" }).mockImplementationOnce(async () => {
        expect(move).toHaveBeenCalledExactlyOnceWith("session", "intent:send");
        expect(open).toHaveBeenCalledTimes(1);
        throw new Error("response lost");
    });
    await expect(props.onSend("첫 줄", { mode: "save", profileId: null, agentId: null }, "intent", undefined, [], move))
        .rejects.toThrow("response lost");
    expect(api.post).toHaveBeenCalledTimes(2);
});
