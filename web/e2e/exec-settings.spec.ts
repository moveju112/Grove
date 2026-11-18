import { expect, test, type Page } from "@playwright/test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { apiCall, ensureProfile, login, openProjectSettings, requireToolApproval, script, selectChoice, state } from "./helpers";
import { frames } from "./fixture";

type Effective = { items: { key: string; effective: unknown; source: string; layers: Record<string, { value: unknown; revision: number }> }[] };

async function setup(page: Page) {
    const root = mkdtempSync(join(state().projA, "exec-settings-"));
    mkdirSync(join(root, "work"));
    const project = await apiCall<{ id: string; name: string }>("POST", "/projects", { root_path: root });
    await requireToolApproval(project.id);
    const session = await apiCall<{ id: string }>("POST", `/projects/${project.id}/sessions`, {});
    await login(page);
    await page.getByTestId("project-row").getByRole("button", { name: project.name, exact: true }).click();
    await openProjectSettings(page);
    await page.getByTestId("settings-menu").getByRole("button", { name: "실행·한도", exact: true }).click();
    await page.getByTestId("settings").getByRole("button", { name: /고급 항목 \d+개 펼치기/ }).click();
    return { project, session, panel: page.getByTestId("exec-settings") };
}

test("범위별 셸·한도·작업 위치는 blur 때 저장하고 기본값 복원은 제공하지 않는다", async ({ page }) => {
    const { project, session, panel } = await setup(page);
    const row = panel.getByTestId("setting-exec.max_memory_mb");
    await row.getByLabel("명령 메모리 한도(MB)", { exact: true }).fill("128");
    await row.getByLabel("명령 메모리 한도(MB)", { exact: true }).blur();
    await expect(row.getByRole("status").filter({ hasText: /\S/ })).toContainText("저장됨");
    const cwd = panel.getByTestId("setting-exec.default_cwd");
    await cwd.getByLabel("기본 작업 위치", { exact: true }).fill("../outside");
    await cwd.getByLabel("기본 작업 위치", { exact: true }).blur();
    await expect(cwd.getByRole("status").filter({ hasText: /\S/ })).toContainText("저장 실패(기존 값 유지)");
    await cwd.getByLabel("기본 작업 위치", { exact: true }).fill("work");
    await cwd.getByLabel("기본 작업 위치", { exact: true }).blur();
    await expect(cwd.getByRole("status").filter({ hasText: /\S/ })).toContainText("저장됨");
    await expect(panel).toContainText("다음 실행부터 적용");
    const sessionQuery = `/settings/effective?session_id=${session.id}`;
    const inherited = (await apiCall<Effective>("GET", sessionQuery)).items.find((item) => item.key === "exec.max_memory_mb")!;
    expect(inherited.effective).toBe(128);
    expect(inherited.source).toBe("project");
    await apiCall("PUT", `/settings/session/${session.id}/exec.max_memory_mb`, { expected_revision: 0, value: 256 });
    expect((await apiCall<Effective>("GET", sessionQuery)).items.find((item) => item.key === "exec.max_memory_mb")!.effective).toBe(256);
    await apiCall("PUT", `/settings/session/${session.id}/exec.max_memory_mb`, { expected_revision: 1, value: null });
    expect((await apiCall<Effective>("GET", sessionQuery)).items.find((item) => item.key === "exec.max_memory_mb")!.effective).toBe(128);
    await expect(row.getByRole("button", { name: "이 범위 값 지우기", exact: true })).toHaveCount(0);
    const after = (await apiCall<Effective>("GET", sessionQuery)).items.find((item) => item.key === "exec.max_memory_mb")!;
    expect(after.layers.project!.value).toBe(128);
    expect(after.source).toBe("project");
});

test("격리 선택과 미지원 셸 설명은 없고 지원하는 셸만 표시한다", async ({ page }, info) => {
    const { panel } = await setup(page);
    await expect(panel.getByTestId("setting-exec.isolation")).toHaveCount(0);
    await expect(panel.getByText(/미지원 선택지/)).toHaveCount(0);
    const registry = await apiCall<{ key: string; options: string[]; unavailable_options?: unknown }[]>("GET", "/settings/registry");
    expect(registry.some((def) => def.key === "exec.isolation")).toBe(false);
    expect(registry.find((def) => def.key === "exec.shell")!.unavailable_options).toBeUndefined();
    await expect(panel.getByRole("combobox", { name: "명령 실행 셸", exact: true })).toContainText("기본 셸");
    await expect(panel).toContainText("다음 실행부터 적용");
    await expect(panel).toContainText("파일·네트워크 접근은 제한하지 않아요");
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: info.outputPath("exec-settings-390.png") });
});

test("화면에서 셸·한도를 바꿔도 승인 대상은 고정되고 다음 계획만 새 값을 사용한다", async ({ page }) => {
    const { session, panel } = await setup(page);
    const profile = await ensureProfile();
    const save = async (key: string, label: string, value: string, select = false) => {
        const row = panel.getByTestId(`setting-${key}`);
        const input = row.getByLabel(label, { exact: true });
        const saved = page.waitForResponse((response) => response.request().method() === "PUT" && response.url().endsWith(`/${key}`));
        if (select) await selectChoice(input, value);
        else { await input.fill(value); await input.blur(); }
        expect((await saved).ok()).toBe(true);
        await expect(row.getByRole("status").filter({ hasText: /\S/ })).toContainText("저장됨");
    };
    type Call = { id: string; revision: number; target: { shell: string; limits: { memory_mb: number; cpu_seconds: number } }; result: { stdout: string } };
    type Turn = { status: string; tool_calls: Call[] };
    const plan = async () => {
        await script({ frames: frames.tool("exec-settings", "shell", {
            command: "printf 'shell=%s\\n' \"$0\"; printf 'memory='; ulimit -v; printf 'cpu='; ulimit -t",
        }) });
        await script({ frames: frames.text(["끝"]) });
        const accepted = await apiCall<{ turn: { id: string } }>("POST", `/sessions/${session.id}/turns`, { text: "run", profile_id: profile, tools: true });
        await expect.poll(async () => (await apiCall<Turn>("GET", `/turns/${accepted.turn.id}`)).status).toBe("awaiting_approval");
        return { id: accepted.turn.id, call: (await apiCall<Turn>("GET", `/turns/${accepted.turn.id}`)).tool_calls[0]! };
    };
    const approve = async (pending: Awaited<ReturnType<typeof plan>>) => {
        await apiCall("POST", `/tool-calls/${pending.call.id}/decision`, { decision: "approve", expected_revision: pending.call.revision });
        await expect.poll(async () => (await apiCall<Turn>("GET", `/turns/${pending.id}`)).status).toBe("completed");
        return (await apiCall<Turn>("GET", `/turns/${pending.id}`)).tool_calls[0]!;
    };
    await save("exec.shell", "명령 실행 셸", "sh", true);
    await save("exec.max_memory_mb", "명령 메모리 한도(MB)", "128");
    await save("exec.max_cpu_seconds", "명령 CPU 시간 한도(초)", "3");
    const old = await plan();
    expect(old.call.target.shell).toBe("sh");
    expect(old.call.target.limits).toEqual({ memory_mb: 128, cpu_seconds: 3 });
    await page.mouse.move(0, 0);
    await expect(page.getByRole("tooltip")).toHaveCount(0);
    await save("exec.shell", "명령 실행 셸", "bash", true);
    await save("exec.max_memory_mb", "명령 메모리 한도(MB)", "256");
    await save("exec.max_cpu_seconds", "명령 CPU 시간 한도(초)", "5");
    const completed = await approve(old);
    expect(completed.target).toEqual(old.call.target);
    expect(completed.result.stdout).toContain("shell=sh\nmemory=131072\ncpu=3\n");
    const next = await plan();
    expect(next.call.target.shell).toBe("bash");
    expect(next.call.target.limits).toEqual({ memory_mb: 256, cpu_seconds: 5 });
    expect((await approve(next)).result.stdout).toContain("shell=bash\nmemory=262144\ncpu=5\n");
});
