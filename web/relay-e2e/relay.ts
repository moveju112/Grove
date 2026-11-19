// relay 시험 공용 도구. 대상 정보는 상태 파일(scripts/relay_stack.py 또는 스테이징 배포)이 정한다.
import { expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { finishSetup } from "../e2e/helpers";

export type Target = {
    target: "local" | "staging";
    origin: string;
    api: string;
    endpoint: string;
    key: string;
    token_file: string;
    pairing_issuance_password_file?: string;
    page: string;
    control?: string;
    work: string;
};

export function target(): Target {
    return JSON.parse(readFileSync(process.env.GROVE_RELAY_STATE!, "utf8")) as Target;
}

const token = () => readFileSync(target().token_file, "utf8").trim();

/// 시험 준비는 데몬 loopback API로 직접 한다. 화면 동작은 브라우저의 relay 경로로만 확인한다.
export async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
    const r = await fetch(`${target().api}/api/v1${path}`, {
        method,
        headers: { authorization: `Bearer ${token()}`, "content-type": "application/json", "idempotency-key": `relay-e2e-${crypto.randomUUID()}` },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!r.ok) throw new Error(`${method} ${path} → ${r.status} ${await r.text()}`);
    return (await r.json()) as T;
}

/// 네트워크 조건 주입(로컬 스택만). 스테이징에서는 호출 전에 test.skip으로 거른다.
export async function net(action: "cut" | "delay" | "blackhole", value?: number | boolean) {
    const control = target().control!;
    const query = action === "delay" ? `?ms=${value}` : action === "blackhole" ? `?on=${value ? 1 : 0}` : "";
    await fetch(`${control}/${action}${query}`, { method: "POST" });
}

/// 페어링과 로그인은 브라우저의 암호화 relay 경로로 진행한다.
export async function enter(page: Page) {
    const t = target();
    const password = "relay e2e pairing password";
    if (!t.pairing_issuance_password_file) throw new Error("relay 시험 상태에 pairing_issuance_password_file을 지정하세요");
    const issuance_password = readFileSync(t.pairing_issuance_password_file, "utf8").trimEnd();
    const link = await api<{ id: string; code: string }>("POST", "/pairings", { name: "Relay E2E", password, issuance_password });
    const url = new URL(t.page);
    const parameters = new URLSearchParams(url.hash.slice(1));
    parameters.set("pairing", link.code);
    url.hash = parameters.toString();
    await page.goto(url.href);
    await page.getByRole("button", { name: "서버 확인 후 연결" }).click();
    await page.getByRole("button", { name: "연결", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "연결 비밀번호" });
    await dialog.getByLabel("비밀번호", { exact: true }).fill(password);
    await dialog.getByRole("button", { name: "연결 요청" }).click();
    const code = await page.getByTestId("pairing-code").innerText();
    const rows = await api<{ id: string; requests: { id: string; verification_code: string }[] }[]>("GET", "/pairings");
    const request = rows.find((row) => row.id === link.id)!.requests.find((item) => item.verification_code === code)!;
    await api("POST", `/pairings/${link.id}/requests/${request.id}`, {});
    // 스테이징의 공유 설정은 변경하지 않는다.
    await finishSetup(page, t.target === "local");
    await expect(page.getByTestId("conn")).toHaveText("연결됨", { timeout: 20_000 });
}

/// 백그라운드 전환: 페이지를 얼린다(JS·타이머 정지). 모바일 브라우저가 탭을 뒤로 보낼 때와 같다.
export async function freeze(page: Page, during: () => Promise<void>) {
    const cdp = await page.context().newCDPSession(page);
    await page.evaluate(() => {
        Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
        document.dispatchEvent(new Event("visibilitychange"));
    });
    await cdp.send("Page.setWebLifecycleState", { state: "frozen" });
    try { await during(); }
    finally {
        await cdp.send("Page.setWebLifecycleState", { state: "active" });
        await page.evaluate(() => {
            Reflect.deleteProperty(document, "visibilityState");
            document.dispatchEvent(new Event("visibilitychange"));
        });
        await cdp.detach();
    }
}

/// 연결 문제를 화면 곳곳에 따로 띄우지 않는다(DESIGN.md 「연결 오류 표시」).
export async function expectNoConnectionNoise(page: Page) {
    for (const text of ["불러오지 못했습니다", "서버 응답을 받지 못했습니다", "배치를 서버에 저장하지 못했습니다", "서버에 연결할 수 없어"]) {
        await expect(page.getByText(text, { exact: false }).filter({ visible: true })).toHaveCount(0);
    }
}
