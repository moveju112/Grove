import { expect, test } from "@playwright/test";
import { apiCall, composerOption, ensureProjects, login, script, sessionView, state } from "./helpers";

type Setting = { key: string; layers: { server?: { value: unknown; revision: number } } };
const keys = ["runs.max_active", "runs.provider_max_active", "runs.account_max_active"];

test("같은 계정의 모델 요청은 한도를 표시하며 기다리고 취소해도 다른 실행은 유지된다", async ({ page }) => {
    const { a } = await ensureProjects();
    const marker = `limits-${Date.now()}`;
    const initial = (await apiCall<{ items: Setting[] }>("GET", "/settings/effective")).items;
    const profile = await apiCall<{ id: string }>("POST", "/model-profiles", {
        name: marker, protocol: "openai", base_url: `http://127.0.0.1:${state().fixturePort}/v1`, model: "fixture-model",
    });
    let held: string | undefined;
    try {
        for (const [index, key] of keys.entries()) {
            await apiCall("PUT", `/settings/server/-/${key}`, {
                expected_revision: initial.find((setting) => setting.key === key)?.layers.server?.revision ?? 0,
                value: index === 2 ? 1 : 2,
            });
        }
        const first = await apiCall<{ id: string }>("POST", `/projects/${a.id}/sessions`, { title: `${marker}-held` });
        const second = await apiCall<{ id: string }>("POST", `/projects/${a.id}/sessions`, { title: marker });
        await script({ frames: [], hang: true, marker: `${marker}-hold` });
        const started = await apiCall<{ turn: { id: string } }>("POST", `/sessions/${first.id}/turns`, {
            profile_id: profile.id, text: `${marker}-hold`,
        });
        held = started.turn.id;
        const requests = async () => JSON.stringify(await (await fetch(`http://127.0.0.1:${state().fixturePort}/requests`)).json());
        await expect.poll(requests).toContain(`${marker}-hold`);
        await apiCall("POST", "/recent/touch", { kind: "session", project_id: a.id, resource_id: second.id });
        await login(page);
        await page.locator(".recent").getByRole("button", { name: new RegExp(marker) }).first().click();
        const view = sessionView(page, second.id);
        await composerOption(view, "보내기 방식", "model");
        await view.getByLabel("모델 프로필").selectOption(profile.id);
        await view.getByLabel("메시지 입력").fill(`${marker}-queued`);
        await view.getByRole("button", { name: "보내기", exact: true }).click();
        await expect(view.getByTestId("turn-status")).toContainText("계정 한도 1/1");
        expect(await requests()).not.toContain(`${marker}-queued`);
        await view.getByTestId("turn-status").getByRole("button", { name: "취소", exact: true }).click();
        await expect(view.getByTestId("turn-status")).toHaveCount(0);
        expect((await apiCall<{ status: string }>("GET", `/turns/${held}`)).status).toBe("running");
        expect(await requests()).not.toContain(`${marker}-queued`);
    } finally {
        if (held) await apiCall("POST", `/turns/${held}/cancel`);
        const current = (await apiCall<{ items: Setting[] }>("GET", "/settings/effective")).items;
        for (const key of keys) {
            await apiCall("PUT", `/settings/server/-/${key}`, {
                expected_revision: current.find((setting) => setting.key === key)?.layers.server?.revision ?? 0,
                value: initial.find((setting) => setting.key === key)?.layers.server?.value ?? null,
            });
        }
        await apiCall("DELETE", `/model-profiles/${profile.id}`);
    }
});
