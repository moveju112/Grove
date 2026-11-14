import { expect, test, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { frames } from "./fixture";
import { apiCall, composerOption, ensureProfile, ensureProjects, login, openDetails, openProjectFiles, script } from "./helpers";

const html = `<!doctype html><html><head>
<meta http-equiv="refresh" content="0;url=/artifact-probe?refresh">
<base href="file:///"><style>@import url('/artifact-probe?style');body{background-image:url('/artifact-probe?css')}</style>
</head><body><h1 style="color:rgb(1, 80, 20)">Artifact fixture</h1>
<script>parent.document.documentElement.dataset.artifactExecuted="yes";fetch('/artifact-probe?script')</script>
<img src="/artifact-probe?image" onerror="parent.document.documentElement.dataset.artifactExecuted='yes'">
<img alt="inline pixel" src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=">
<iframe src="/artifact-probe?frame"></iframe><object data="/artifact-probe?object"></object>
<a href="/artifact-probe?link" target="_top" ping="/artifact-probe?ping">unsafe navigation</a>
<a href="file:///artifact-probe/local">local file</a><img src="file:///artifact-probe/image" alt="local probe">
<button onclick="location.href='/artifact-probe?click'">static button</button>
<form action="/artifact-probe?form"><input name="secret"><button>submit</button></form>
<svg xmlns="http://www.w3.org/2000/svg"><foreignObject><iframe src="/artifact-probe?foreign"></iframe></foreignObject></svg>
<template shadowrootmode="open"><img src="/artifact-probe?template"></template>
</body></html>`;

async function guard(page: Page) {
    const requests: string[] = [], dialogs: string[] = [];
    await page.route("**/artifact-probe**", (route) => { requests.push(route.request().url()); return route.abort(); });
    page.on("dialog", (dialog) => { dialogs.push(dialog.type()); void dialog.dismiss(); });
    return { requests, dialogs };
}
async function preview(page: Page) {
    await page.evaluate(() => { document.documentElement.dataset.artifactExecuted = "no"; });
    const pane = page.getByTestId("artifact-preview");
    const loaded = page.waitForEvent("framenavigated", (frame) => frame.url() === "about:srcdoc");
    await openDetails(pane);
    const frame = await loaded;
    await frame.waitForLoadState("load");
    return { pane, frame };
}
async function openFile(page: Page, extension: string, content: string) {
    const { a } = await ensureProjects();
    const project = await apiCall<{ root_path: string }>("GET", `/projects/${a.id}`);
    const name = `artifact-${randomUUID()}.${extension}`;
    writeFileSync(join(project.root_path, name), content);
    await login(page);
    await page.getByRole("button", { name: a.name, exact: true }).first().click();
    await openProjectFiles(page);
    await page.getByTestId("files-view").getByRole("button", { name, exact: true }).click();
    await expect(page.getByLabel("파일 내용")).toHaveValue(content);
    return name;
}

test("모델 HTML 산출물을 승인 후 현재 프로젝트에서 미리 보고 원문 그대로 내려받는다", async ({ page }) => {
    const boundary = await guard(page);
    const { a, b } = await ensureProjects();
    const profile = await ensureProfile();
    const title = `artifact-turn-${randomUUID()}`;
    const name = `${title}.html`;
    const other = await apiCall<{ root_path: string }>("GET", `/projects/${b.id}`);
    writeFileSync(join(other.root_path, name), "wrong project");
    const session = await apiCall<{ id: string }>("POST", `/projects/${a.id}/sessions`, { title });
    await apiCall("POST", "/recent/touch", { kind: "session", project_id: a.id, resource_id: session.id });
    await script({ marker: title, frames: frames.tool("artifact-write", "write", { path: name, content: html }) });
    await script({ marker: title, frames: frames.text(["artifact fixture complete"]) });
    await login(page);
    await page.locator(".recent").getByRole("button", { name: new RegExp(title) }).click();
    const view = page.getByTestId("session-view");
    await view.getByLabel("모델 프로필").selectOption(profile);
    await composerOption(view, "보내기 방식", "model");
    await composerOption(view, "도구", true);
    await view.getByLabel("메시지 입력").fill(title);
    await view.getByRole("button", { name: "보내기", exact: true }).click();
    await expect(view.getByTestId("approval")).toContainText(name);
    await view.getByTestId("approval").getByRole("button", { name: "이번만 승인", exact: true }).click();
    await expect(view.getByTestId("msg-assistant").filter({ hasText: "artifact fixture complete" })).toHaveCount(1);
    const changes = view.getByTestId("changes-panel");
    await openDetails(changes);
    await changes.getByRole("button", { name: "산출물 열기", exact: true }).click();
    await expect(page.getByLabel("파일 내용")).toHaveValue(html);
    const { pane, frame } = await preview(page);
    await expect(frame.getByRole("heading", { name: "Artifact fixture", exact: true })).toBeVisible();
    await expect(pane.locator("iframe")).toHaveAttribute("sandbox", "");
    await expect(frame.locator("script, iframe, object, form, base, template, meta[http-equiv=refresh]")).toHaveCount(0);
    await expect(frame.locator("a[href], img[src^='file:'], [onerror]")).toHaveCount(0);
    await expect(frame.getByRole("button", { name: "static button" })).toBeDisabled();
    await frame.getByText("unsafe navigation", { exact: true }).click();
    await frame.getByText("local file", { exact: true }).click();
    await expect.poll(() => frame.getByAltText("inline pixel").evaluate((node: HTMLImageElement) => node.naturalWidth)).toBe(1);
    expect(await frame.evaluate(() => {
        try { void parent.document.body; return "accessible"; } catch (error) { return (error as Error).name; }
    })).toBe("SecurityError");
    expect(await page.evaluate(() => document.documentElement.dataset.artifactExecuted)).toBe("no");
    expect(boundary.requests).toEqual([]);
    expect(boundary.dialogs).toEqual([]);
    await pane.getByRole("button", { name: "닫기", exact: true }).click();
    await expect(pane.getByRole("dialog")).toHaveCount(0);
    const downloading = page.waitForEvent("download");
    await page.getByRole("link", { name: "내려받기", exact: true }).click();
    const download = await downloading;
    expect(download.suggestedFilename()).toBe(name);
    expect(readFileSync((await download.path())!, "utf8")).toBe(html);
    expect(readFileSync(join(other.root_path, name), "utf8")).toBe("wrong project");
});

test("SVG는 정적 도형을 표시하고 script·외부 이미지·foreignObject·애니메이션 URL을 제거한다", async ({ page }) => {
    const boundary = await guard(page);
    const source = `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="120" onload="alert('artifact')">
<style>text{fill:blue}</style><rect width="300" height="120" fill="#eee"/><text x="10" y="40">SVG artifact</text>
<script>alert('artifact')</script><image href="/artifact-probe?svg"/><use href="/artifact-probe?use"/>
<foreignObject><iframe src="/artifact-probe?svgframe"/></foreignObject>
<set attributeName="href" to="/artifact-probe?set"/><a href="/artifact-probe?svglink"><text x="10" y="80">link</text></a></svg>`;
    await openFile(page, "svg", source);
    const { frame } = await preview(page);
    await expect(frame.getByText("SVG artifact", { exact: true })).toBeVisible();
    await expect(frame.locator("svg rect")).toHaveCount(1);
    await expect(frame.locator("script, image, use, foreignObject, set, [href], [onload]")).toHaveCount(0);
    expect(boundary.requests).toEqual([]);
    expect(boundary.dialogs).toEqual([]);
});

test("Markdown 문서와 저장 전 편집을 안전하게 표시하고 원문 스크립트는 실행하지 않는다", async ({ page }) => {
    const boundary = await guard(page);
    await openFile(page, "md", "# Document artifact\n\n<script>alert('artifact')</script>\n\n**original**");
    const area = page.getByLabel("파일 내용");
    await area.fill("# Unsaved artifact\n\n**local edit**\n\n<script>alert('artifact')</script>");
    const pane = page.getByTestId("artifact-preview");
    await openDetails(pane);
    await expect(pane.getByRole("dialog")).toContainText("저장 전 편집 사본");
    await expect(pane.getByRole("heading", { name: "Unsaved artifact", exact: true })).toBeVisible();
    await expect(pane.locator("strong")).toHaveText("local edit");
    await expect(pane.locator("script, iframe")).toHaveCount(0);
    expect(boundary.requests).toEqual([]);
    expect(boundary.dialogs).toEqual([]);
});

test("편집 한도를 넘는 SVG도 기존 image preview에서 스크립트·외부 자원을 실행하지 않는다", async ({ page }) => {
    const boundary = await guard(page);
    const source = `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="120" onload="alert('artifact')">
<image href="/artifact-probe?large"/><script>alert('artifact')</script><rect width="300" height="120" fill="green"/>
<!--${"x".repeat(2 * 1024 * 1024)}--></svg>`;
    const { a } = await ensureProjects();
    const project = await apiCall<{ root_path: string }>("GET", `/projects/${a.id}`);
    const name = `large-artifact-${randomUUID()}.svg`;
    writeFileSync(join(project.root_path, name), source);
    await login(page);
    await page.getByRole("button", { name: a.name, exact: true }).first().click();
    await openProjectFiles(page);
    await page.getByTestId("files-view").getByRole("button", { name, exact: true }).click();
    const image = page.getByRole("img", { name, exact: true });
    await expect.poll(() => image.evaluate((node: HTMLImageElement) => node.naturalWidth)).toBe(300);
    await expect(page.getByLabel("파일 내용")).toHaveCount(0);
    expect(boundary.requests).toEqual([]);
    expect(boundary.dialogs).toEqual([]);
});
