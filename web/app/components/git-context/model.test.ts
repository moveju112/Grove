import { describe, expect, it } from "vitest";
import { contextLabel, contextMatches } from "./model";
import type { GitContext } from "../../api/gitContext";

describe("Git 개요 대상 경계", () => {
    const data: GitContext = {
        project_id: "project-a", status: "ok",
        location: { head: "head-a", branch: "main", kind: "branch", project_relative_to_worktree: ".", worktree: "main", git_registered: true, worktree_count: 1 },
    };
    it("branch 이름이 같아도 프로젝트·HEAD가 다르면 이전 응답을 쓰지 않는다", () => {
        expect(contextMatches(data, "project-a", "head-a")).toBe(true);
        expect(contextMatches(data, "project-b", "head-a")).toBe(false);
        expect(contextMatches(data, "project-a", "head-b")).toBe(false);
        expect(contextMatches(data, "project-a", "(initial)")).toBe(false);
        expect(contextMatches({ ...data, location: { ...data.location!, head: null, kind: "unborn" } }, "project-a", "(initial)")).toBe(true);
    });
    it("오류·결과 없음·오래됨·미지원·중립을 성공으로 바꾸지 않는다", () => {
        const states = ["unknown", "none", "stale", "unsupported", "missing", "unauthenticated", "denied", "timeout", "neutral"] as const;
        expect(new Set(states.map((state) => contextLabel[state])).size).toBe(states.length);
        for (const state of states) expect(contextLabel[state]).not.toBe(contextLabel.success);
    });
});
