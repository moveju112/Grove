import { expect, test } from "@playwright/test";
import { frames } from "./fixture";
import { apiCall, ensureProfile, ensureProjects, login, script, sessionView } from "./helpers";

for (const width of [390, 1280]) {
    test(`${width}px: 답변의 본문·코드·목록은 같은 글자 크기와 줄 높이를 유지한다`, async ({ page }, info) => {
        await page.setViewportSize({ width, height: 1000 });
        await page.emulateMedia({ reducedMotion: "reduce" });
        const { a } = await ensureProjects();
        const profile = await ensureProfile();
        const title = `메시지 정렬 ${width}`;
        const session = await apiCall<{ id: string }>("POST", `/projects/${a.id}/sessions`, { title });
        await apiCall("POST", "/recent/touch", { kind: "session", project_id: a.id, resource_id: session.id });
        await login(page);
        const sidebar = page.getByRole("button", { name: "사이드바", exact: true });
        if (await sidebar.getAttribute("aria-expanded") === "false") await sidebar.click();
        await page.getByRole("region", { name: "최근", exact: true }).getByRole("button", { name: new RegExp(title) }).first().click();
        const view = sessionView(page, session.id);
        const answer = [
            "일반 문장의 기준선이야.",
            "",
            "`workspace-write` 코드 설명이야.",
            "",
            "파일 `AGENTS.md:3` 참조야.",
            "",
            "- `workspace-write`: 지정된 경로만 쓰기 허용.",
            "- 일반 목록 항목이야.",
            "- 여러 줄로 감기는 목록에서도 글자 크기와 줄 높이는 본문과 같고 목록 기호는 첫 줄에 맞아야 해.",
            "",
            "1. `approval_policy=never`: 승인 요청 불가.",
            "2. 순서 목록도 본문과 같은 크기야.",
        ].join("\n");
        await script({ frames: frames.text([answer]) });
        await apiCall("POST", `/sessions/${session.id}/turns`, { profile_id: profile, text: title });
        const msg = view.getByTestId("msg-assistant").last();
        const markdown = msg.getByTestId("msg-answer").getByTestId("markdown");
        await expect(markdown).toContainText("순서 목록도 본문과 같은 크기야.");
        await page.evaluate(() => document.fonts.ready);
        await msg.scrollIntoViewIfNeeded();
        await page.screenshot({ path: info.outputPath(`message-alignment-${width}.png`) });
        const nameSize = await msg.getByTestId("msg-who").evaluate((node) => getComputedStyle(node).fontSize);
        const labelSize = await msg.getByTestId("msg-answer").getByText("답변", { exact: true })
            .evaluate((node) => getComputedStyle(node).fontSize);
        expect(nameSize).toBe(labelSize);
        expect(await markdown.getByTestId("file-ref").evaluate((node) =>
            getComputedStyle(node).paddingInlineStart)).toBe("0px");
        const geometry = await markdown.evaluate((node) => {
            const paragraphs = [...node.querySelectorAll("p")];
            const style = (el: Element) => {
                const css = getComputedStyle(el);
                const rect = el.getBoundingClientRect();
                return { fontSize: css.fontSize, lineHeight: css.lineHeight, x: rect.x, height: rect.height };
            };
            return {
                body: style(paragraphs[0]!),
                paragraphs: paragraphs.map(style),
                codes: [...node.querySelectorAll("code")].map(style),
                labels: [...node.querySelectorAll("li span")].filter((el) =>
                    [...el.childNodes].some((child) => child.nodeType === Node.TEXT_NODE && child.textContent!.trim())).map(style),
            };
        });
        expect(geometry.codes.map((code) => code.fontSize), JSON.stringify(geometry)).toEqual(
            geometry.codes.map(() => geometry.body.fontSize));
        for (const paragraph of geometry.paragraphs) {
            expect(paragraph.x).toBeCloseTo(geometry.body.x, 0);
            expect(paragraph.height).toBeCloseTo(geometry.body.height, 0);
        }
        expect(geometry.labels.length).toBe(5);
        for (const label of geometry.labels) {
            expect(label.fontSize).toBe(geometry.body.fontSize);
            expect(label.lineHeight).toBe(geometry.body.lineHeight);
        }
    });
}
