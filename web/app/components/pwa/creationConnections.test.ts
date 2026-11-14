import { createElement, type ComponentProps, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { api, ApiError } from "../../api/client";
import type { Project } from "../../api/generated";
import { AddProjectDialog } from "../AddProject";
import { CreationEntry } from "../create/CreationEntry";
import { ProjectComposer } from "../create/ProjectComposer";
import { Composer } from "../Composer";
import { TerminalKeys } from "../terminal/TerminalKeys";

vi.mock("../Composer", () => ({ Composer: vi.fn(() => null) }));
vi.mock("../ui/Controls", async (original) => ({
    ...await original<typeof import("../ui/Controls")>(),
    DetailDialog: ({ children }: { children: ReactNode }) => createElement("section", null, children),
}));
beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.restoreAllMocks());
const project = { id: "fixture-project", name: "Fixture", available: true } as Project;

it.each(["오프라인", "protocol 불일치"])("%s에도 프로젝트 선택·추가 화면·취소는 로컬 진입으로 남긴다", (blockedReason) => {
    const html = renderToStaticMarkup(createElement(CreationEntry, {
        projects: [project], loading: false, error: false, blockedReason,
        onSelect: vi.fn(), onAddProject: vi.fn(), onClose: vi.fn(), onReload: vi.fn(),
    }));
    expect(html).toContain(blockedReason);
    expect(html).toContain("프로젝트 선택·초안 편집·취소는 계속");
    expect(html).not.toContain('disabled=""');
});

it("프로젝트 등록·clone은 막되 경로 입력·복사·취소를 비활성화하지 않는다", () => {
    const html = renderToStaticMarkup(createElement(AddProjectDialog, {
        onDone: vi.fn(), onClose: vi.fn(), blockedReason: "오프라인",
    }));
    expect(html).toContain('title="오프라인"');
    expect(html).toContain("clone 후 프로젝트로 추가");
    expect(html).not.toMatch(/<fieldset[^>]*disabled/);
    expect(html).not.toMatch(/<input[^>]*disabled/);
    expect(html).toMatch(/<button class="ghost">취소<\/button>/);
});

it("프로젝트 초안은 parent disabled로 막지 않고 생성 직전·후속 전송 직전에 guard를 호출한다", async () => {
    const beforeMutation = vi.fn();
    renderToStaticMarkup(createElement(ProjectComposer, {
        projectId: project.id, tabId: "fixture-tab", open: vi.fn(), disabled: null,
        blockedReason: "오프라인", beforeMutation,
    }));
    const props = vi.mocked(Composer).mock.calls[0]![0] as ComponentProps<typeof Composer>;
    expect(props.disabled).toBeNull();
    const post = vi.spyOn(api, "post").mockResolvedValue({ id: "fixture-session", title: "draft" });
    beforeMutation.mockImplementationOnce(() => { throw new ApiError(0, "offline", "오프라인", false, { result_unknown: false }); });
    const options = { mode: "save" as const, profileId: null, agentId: null, tools: false };
    await expect(props.onSend("draft", options, "same-intent")).rejects.toMatchObject({ code: "offline" });
    expect(post).not.toHaveBeenCalled();
    beforeMutation.mockImplementationOnce(() => {}).mockImplementationOnce(() => { throw new ApiError(0, "offline", "오프라인"); });
    await expect(props.onSend("draft", options, "same-intent")).rejects.toMatchObject({
        code: "offline", retryable: true, details: { result_unknown: true, idempotency_key: "same-intent" },
    });
    expect(post).toHaveBeenCalledExactlyOnceWith(`/projects/${project.id}/sessions`, { title: "draft" }, { key: "same-intent:session" });
});

it("터미널 보조키 차단은 로컬 보조키 해제까지 막지 않는다", () => {
    const html = renderToStaticMarkup(createElement(TerminalKeys, {
        modifiers: { ctrl: true, alt: false }, blockedReason: "오프라인",
        onKey: vi.fn(), onToggle: vi.fn(), onReset: vi.fn(),
    }));
    expect(html).toContain('title="오프라인"');
    expect(html).toMatch(/<button class="chip">보조키 해제<\/button>/);
});
