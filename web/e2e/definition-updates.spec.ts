import { expect, test, type Page } from "@playwright/test";
import type { DefinitionDetail } from "../app/api/generated";
import { apiCall, login, openSettings, selectChoice } from "./helpers";

const path = "/definitions/workflow/headless";
const comparison = (page: Page) => page.getByRole("region", { name: "정의 기본값 비교", exact: true });
async function read() { return apiCall<DefinitionDetail>("GET", path); }
async function edit(values: Partial<DefinitionDetail>) {
    const current = await read();
    return apiCall<DefinitionDetail>("PUT", path, { expected_revision: current.revision, ...values });
}
async function open(page: Page, name: string, authenticate = true) {
    if (authenticate) await login(page);
    await openSettings(page);
    await page.getByLabel("설정 검색", { exact: true }).fill("에이전트");
    await page.getByRole("button", { name: "워크플로우", exact: true }).click();
    await page.getByTestId("definition-list").getByRole("button", { name: new RegExp(name) }).click();
    await expect(page.getByLabel("정의 본문", { exact: true })).toBeVisible();
}
async function prepare() {
    return edit({ name: "업데이트 비교 fixture", description: "<script>사용자 설명</script>", body: "이전 앱의 사용자 본문", enabled: false });
}

test("저장된 수정본과 현재 번들을 비교하고 선택 필드만 적용하며 disabled·미선택 값·초안을 reload 뒤에도 보존한다", async ({ page }) => {
    const before = await prepare();
    await open(page, before.name);
    const body = page.getByLabel("정의 본문", { exact: true });
    await body.fill("아직 저장하지 않은 초안");
    await comparison(page).getByRole("button", { name: "현재 번들 기본값과 비교", exact: true }).click();
    await expect(comparison(page).getByLabel("설명 현재 적용값", { exact: true })).toHaveText(before.description);
    await expect(comparison(page).getByLabel("본문 현재 번들 기본값", { exact: true })).toHaveText(before.baseline_body!);
    await expect(comparison(page).locator("script")).toHaveCount(0);
    await expect(comparison(page).getByRole("button", { name: "선택한 필드만 기본값 적용", exact: true })).toBeDisabled();
    const selector = comparison(page).getByRole("combobox", { name: "본문 기본값 적용", exact: true });
    expect((await selector.boundingBox())!.width).toBeGreaterThanOrEqual(32);
    await selectChoice(comparison(page).getByLabel("본문 기본값 적용", { exact: true }), "true");
    await comparison(page).getByRole("button", { name: "비교 취소", exact: true }).click();
    expect(await read()).toEqual(before);
    await expect(body).toHaveValue("아직 저장하지 않은 초안");
    await comparison(page).getByRole("button", { name: "현재 번들 기본값과 비교", exact: true }).click();
    await selectChoice(comparison(page).getByLabel("이름 기본값 적용", { exact: true }), "true");
    await selectChoice(comparison(page).getByLabel("설명 기본값 적용", { exact: true }), "true");
    await comparison(page).getByRole("button", { name: "선택한 필드만 기본값 적용", exact: true }).click();
    await expect(comparison(page).getByRole("status").filter({ hasText: /\S/ })).toContainText("선택한 기본값 적용됨");
    const restored = await read();
    expect(restored.name).toBe(before.baseline_name);
    expect(restored.description).toBe(before.baseline_description);
    expect(restored.body).toBe(before.body);
    expect(restored.enabled).toBe(false);
    expect(restored.revision).toBe(before.revision + 1);
    await expect(body).toHaveValue("아직 저장하지 않은 초안");
    await page.reload();
    await open(page, restored.name, false);
    await expect(body).toHaveValue("아직 저장하지 않은 초안");
    expect(await read()).toEqual(restored);
    await page.getByRole("button", { name: "편집 취소", exact: true }).click();
    await expect(body).toHaveValue(before.body);
    // 본문만 선택해도 미저장 본문은 별도 초안으로 남는다.
    await body.fill("복원과 별개로 보존할 본문");
    await comparison(page).getByRole("button", { name: "현재 번들 기본값과 비교", exact: true }).click();
    await selectChoice(comparison(page).getByLabel("본문 기본값 적용", { exact: true }), "true");
    await comparison(page).getByRole("button", { name: "선택한 필드만 기본값 적용", exact: true }).click();
    await expect(comparison(page).getByRole("status").filter({ hasText: /\S/ })).toContainText("선택한 기본값 적용됨");
    expect((await read()).body).toBe(before.baseline_body);
    await expect(body).toHaveValue("복원과 별개로 보존할 본문");
    await comparison(page).getByRole("button", { name: "현재 번들 기본값과 비교", exact: true }).click();
    await expect(comparison(page).getByRole("combobox", { name: "이름 기본값 적용", exact: true })).toBeEnabled();
    await expect(comparison(page).getByRole("combobox", { name: "본문 기본값 적용", exact: true })).toBeEnabled();
    await comparison(page).getByRole("button", { name: "비교한 revision으로 초안 저장 준비", exact: true }).click();
    await page.getByTestId("definition-editor").getByRole("button", { name: "저장", exact: true }).click();
    await expect(page.getByTestId("definition-editor").getByRole("status").filter({ hasText: "저장됨" })).toBeVisible();
    expect((await read()).body).toBe("복원과 별개로 보존할 본문");
});

test("비교 뒤 revision과 번들 metadata가 바뀌면 적용을 거절하고 다시 선택하게 한다", async ({ page }) => {
    const before = await prepare();
    await open(page, before.name);
    const body = page.getByLabel("정의 본문", { exact: true });
    await body.fill("경합 중 보존할 초안");
    await comparison(page).getByRole("button", { name: "현재 번들 기본값과 비교", exact: true }).click();
    await selectChoice(comparison(page).getByLabel("본문 기본값 적용", { exact: true }), "true");
    const concurrent = await edit({ body: "다른 기기의 새 수정" });
    await comparison(page).getByRole("button", { name: "선택한 필드만 기본값 적용", exact: true }).click();
    await expect(comparison(page).getByRole("alert")).toContainText("다시 비교");
    expect(await read()).toEqual(concurrent);
    await expect(body).toHaveValue("경합 중 보존할 초안");
    // 자산을 바꾸지 않고 이전 번들 metadata를 받은 브라우저를 재현한다.
    let oldBundle = true;
    await page.route(`**/api/v1${path}`, async (route) => {
        if (route.request().method() !== "GET" || !oldBundle) return route.continue();
        const response = await route.fetch();
        const data = await response.json() as DefinitionDetail;
        await route.fulfill({ response, json: { ...data, baseline_name: "이전 번들 이름" } });
    });
    await comparison(page).getByRole("button", { name: "변경된 값 다시 비교", exact: true }).click();
    await expect(comparison(page).getByRole("combobox", { name: "본문 기본값 적용", exact: true })).toHaveAttribute("data-selected-value", "false");
    await expect(comparison(page).getByLabel("이름 현재 번들 기본값", { exact: true })).toHaveText("이전 번들 이름");
    await selectChoice(comparison(page).getByLabel("본문 기본값 적용", { exact: true }), "true");
    await comparison(page).getByRole("button", { name: "선택한 필드만 기본값 적용", exact: true }).click();
    await expect(comparison(page).getByRole("alert")).toContainText("번들 기본값이 변경");
    expect(await read()).toEqual(concurrent);
    oldBundle = false;
    await comparison(page).getByRole("button", { name: "변경된 값 다시 비교", exact: true }).click();
    await expect(comparison(page).getByRole("combobox", { name: "본문 기본값 적용", exact: true })).toHaveAttribute("data-selected-value", "false");
    await selectChoice(comparison(page).getByLabel("본문 기본값 적용", { exact: true }), "true");
    await comparison(page).getByRole("button", { name: "선택한 필드만 기본값 적용", exact: true }).click();
    await expect(comparison(page).getByRole("status").filter({ hasText: /\S/ })).toContainText("선택한 기본값 적용됨");
    await expect(body).toHaveValue("경합 중 보존할 초안");
});

test("응답 유실 후 reload해도 같은 본문·키의 receipt를 확인하고 이후 편집을 덮어쓰지 않는다", async ({ page }) => {
    const before = await prepare();
    await open(page, before.name);
    await page.getByLabel("정의 본문", { exact: true }).fill("응답 유실 중 초안");
    const requests: { key: string; body: unknown }[] = [];
    await page.route(`**/api/v1${path}/restore`, async (route) => {
        requests.push({ key: route.request().headers()["idempotency-key"]!, body: route.request().postDataJSON() });
        if (requests.length === 1) { await route.fetch(); await route.abort("connectionreset"); }
        else await route.continue();
    });
    await comparison(page).getByRole("button", { name: "현재 번들 기본값과 비교", exact: true }).click();
    await selectChoice(comparison(page).getByLabel("본문 기본값 적용", { exact: true }), "true");
    await comparison(page).getByRole("button", { name: "선택한 필드만 기본값 적용", exact: true }).click();
    await expect(comparison(page).getByRole("button", { name: "원래 복원 요청 결과 확인", exact: true })).toBeVisible();
    await expect(page.getByTestId("definition-editor").getByRole("button", { name: "저장", exact: true })).toBeDisabled();
    const latest = await edit({ body: "복원 뒤 다른 기기의 수정" });
    await page.reload();
    await open(page, latest.name, false);
    await expect(page.getByLabel("정의 본문", { exact: true })).toHaveValue("응답 유실 중 초안");
    const recover = comparison(page).getByRole("button", { name: "원래 복원 요청 결과 확인", exact: true });
    try {
        await page.context().setOffline(true);
        await expect(page.getByTestId("offline-banner")).toBeVisible();
        await expect(recover).toBeDisabled();
        expect(requests).toHaveLength(1);
    } finally {
        await page.context().setOffline(false);
    }
    await expect(recover).toBeEnabled();
    expect(requests).toHaveLength(1);
    await comparison(page).getByRole("button", { name: "원래 복원 요청 결과 확인", exact: true }).click();
    await expect(comparison(page).getByRole("status").filter({ hasText: /\S/ })).toContainText("선택한 기본값 적용됨");
    expect(requests).toHaveLength(2);
    expect(requests[0]!.key).toBeTruthy();
    expect(requests[1]).toEqual(requests[0]);
    expect(await read()).toEqual(latest);
    await expect(page.getByLabel("정의 본문", { exact: true })).toHaveValue("응답 유실 중 초안");
});

test("오프라인은 정의 저장과 선택 적용을 막고 복구 뒤에도 초안을 자동 전송하지 않는다", async ({ page }) => {
    const before = await prepare();
    await open(page, before.name);
    const body = page.getByLabel("정의 본문", { exact: true });
    await body.fill("오프라인에서도 보존할 정의 초안");
    await comparison(page).getByRole("button", { name: "현재 번들 기본값과 비교", exact: true }).click();
    await selectChoice(comparison(page).getByLabel("본문 기본값 적용", { exact: true }), "true");
    const apply = comparison(page).getByRole("button", { name: "선택한 필드만 기본값 적용", exact: true });
    const save = page.getByTestId("definition-editor").getByRole("button", { name: "저장", exact: true });
    const mutations: string[] = [];
    page.on("request", (request) => {
        if (new URL(request.url()).pathname.startsWith(`/api/v1${path}`) && request.method() !== "GET") {
            mutations.push(request.method());
        }
    });
    try {
        await page.context().setOffline(true);
        await expect(page.getByTestId("offline-banner")).toBeVisible();
        await expect(apply).toBeDisabled();
        await expect(save).toBeDisabled();
        await expect(page.getByTestId("definition-editor").getByRole("button", { name: "선택 가능으로", exact: true })).toBeDisabled();
        await body.fill("오프라인에서 더 편집한 정의 초안");
        await expect(body).toHaveValue("오프라인에서 더 편집한 정의 초안");
        expect(mutations).toEqual([]);
    } finally {
        await page.context().setOffline(false);
    }
    await expect(apply).toBeEnabled();
    await expect(save).toBeEnabled();
    expect(mutations).toEqual([]);
    expect(await read()).toEqual(before);
    await expect(body).toHaveValue("오프라인에서 더 편집한 정의 초안");
    await expect(comparison(page).getByRole("combobox", { name: "본문 기본값 적용", exact: true })).toHaveAttribute("data-selected-value", "true");
    await apply.click();
    await expect(comparison(page).getByRole("status").filter({ hasText: /\S/ })).toContainText("선택한 기본값 적용됨");
    const restored = await read();
    expect(restored.body).toBe(before.baseline_body);
    expect(restored.revision).toBe(before.revision + 1);
    await expect(body).toHaveValue("오프라인에서 더 편집한 정의 초안");
});
