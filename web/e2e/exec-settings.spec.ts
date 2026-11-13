import { expect, test, type Page } from "@playwright/test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { apiCall, ensureProfile, login, script, state } from "./helpers";
import { frames } from "./fixture";

type Effective = { items: { key: string; effective: unknown; source: string; layers: Record<string, { value: unknown; revision: number }> }[] };

async function setup(page: Page) {
    const root = mkdtempSync(join(state().projA, "exec-settings-"));
    mkdirSync(join(root, "work"));
    const project = await apiCall<{ id: string; name: string }>("POST", "/projects", { root_path: root });
    const session = await apiCall<{ id: string }>("POST", `/projects/${project.id}/sessions`, {});
    await login(page);
    await page.getByTestId("project-row").getByRole("button", { name: project.name, exact: true }).click();
    await page.getByRole("button", { name: "프로젝트 작업", exact: true }).click();
    await page.getByRole("button", { name: "프로젝트 설정", exact: true }).click();
    await page.getByLabel("설정 검색", { exact: true }).fill("셸·자원");
    return { project, session, panel: page.getByTestId("exec-settings") };
}

test("범위별 셸·한도·작업 위치 저장과 상속 복원은 기존 설정 API를 쓴다", async ({ page }) => {
    const { project, session, panel } = await setup(page);
    const row = panel.getByTestId("setting-exec.max_memory_mb");
    await row.getByLabel("명령 메모리 한도(MB)", { exact: true }).fill("128");
    await row.getByRole("button", { name: "저장", exact: true }).click();
    await expect(row.getByRole("status")).toContainText("저장됨");
    const cwd = panel.getByTestId("setting-exec.default_cwd");
    await cwd.getByLabel("기본 작업 위치", { exact: true }).fill("../outside");
    await cwd.getByRole("button", { name: "저장", exact: true }).click();
    await expect(cwd.getByRole("status")).toContainText("저장 실패(기존 값 유지)");
    await cwd.getByLabel("기본 작업 위치", { exact: true }).fill("work");
    await cwd.getByRole("button", { name: "저장", exact: true }).click();
    await expect(cwd.getByRole("status")).toContainText("저장됨");
    await expect(panel).toContainText("cwd를 생략한 새 모델 셸·대화 작업에 적용됩니다");
    await expect(panel).toContainText("이미 계획·승인된 호출의 shell·limits·cwd는 바꾸지 않습니다");
    const sessionQuery = `/settings/effective?session_id=${session.id}`;
    const inherited = (await apiCall<Effective>("GET", sessionQuery)).items.find((item) => item.key === "exec.max_memory_mb")!;
    expect(inherited.effective).toBe(128);
    expect(inherited.source).toBe("project");
    await apiCall("PUT", `/settings/session/${session.id}/exec.max_memory_mb`, { expected_revision: 0, value: 256 });
    expect((await apiCall<Effective>("GET", sessionQuery)).items.find((item) => item.key === "exec.max_memory_mb")!.effective).toBe(256);
    await apiCall("PUT", `/settings/session/${session.id}/exec.max_memory_mb`, { expected_revision: 1, value: null });
    expect((await apiCall<Effective>("GET", sessionQuery)).items.find((item) => item.key === "exec.max_memory_mb")!.effective).toBe(128);
    await row.getByRole("button", { name: "이 범위 값 지우기", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "기본값 복원 확인", exact: true });
    await expect(dialog.getByTestId("reset-target")).toContainText(project.name);
    await dialog.getByRole("button", { name: "확인한 범위 복원", exact: true }).click();
    await expect(dialog.getByRole("status")).toContainText("복원 저장됨");
    const after = (await apiCall<Effective>("GET", sessionQuery)).items.find((item) => item.key === "exec.max_memory_mb")!;
    expect(after.layers.project!.value).toBeNull();
    expect(after.source).not.toBe("project");
});

test("미지원 격리·셸은 이유와 함께 비활성이고 기존 승인 계약을 안내한다", async ({ page }) => {
    const { panel } = await setup(page);
    const unsupported = panel.getByRole("group", { name: "프로세스 격리 수준 미지원 선택지", exact: true });
    await expect(unsupported.getByRole("radio", { name: /sandbox/ })).toBeDisabled();
    await expect(unsupported).toContainText("아직 구현되지 않았습니다");
    await expect(unsupported.getByRole("radio", { name: /none/ })).toBeDisabled();
    await expect(panel.getByLabel("프로세스 격리 수준", { exact: true })).toHaveValue("process_tree");
    const registry = await apiCall<{ key: string; unavailable_options?: { value: string; reason: string }[] }[]>("GET", "/settings/registry");
    for (const choice of registry.find((def) => def.key === "exec.shell")!.unavailable_options ?? []) {
        const option = panel.getByRole("group", { name: "명령 실행 셸 미지원 선택지", exact: true }).getByRole("radio", { name: `${choice.value} · ${choice.reason}`, exact: true });
        await expect(option).toBeDisabled();
        await expect(option).toHaveAccessibleName(`${choice.value} · ${choice.reason}`);
    }
    await expect(panel).toContainText("다음에 계획하는 실행부터 적용됩니다");
    await expect(panel).toContainText("파일·네트워크 sandbox가 아닙니다");
});

test("화면에서 셸·한도를 바꿔도 승인 대상은 고정되고 다음 계획만 새 값을 사용한다", async ({ page }) => {
    const { session, panel } = await setup(page);
    const profile = await ensureProfile();
    const save = async (key: string, label: string, value: string, select = false) => {
        const row = panel.getByTestId(`setting-${key}`);
        const input = row.getByLabel(label, { exact: true });
        if (select) await input.selectOption(value);
        else await input.fill(value);
        const saved = page.waitForResponse((response) => response.request().method() === "PUT" && response.url().endsWith(`/${key}`));
        await row.getByRole("button", { name: "저장", exact: true }).click();
        expect((await saved).ok()).toBe(true);
        await expect(row.getByRole("status")).toContainText("저장됨");
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
