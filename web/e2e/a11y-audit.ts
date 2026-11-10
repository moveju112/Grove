import type { Page } from "@playwright/test";

// 접근성 점검(UI-029). 외부 도구 없이 화면에 보이는 요소를 직접 검사한다.
// - unnamed: 이름(aria-label·연결된 label·글자·title·alt)이 없는 조작 요소
// - contrast: 글자색과 실제 배경(불투명해질 때까지 조상을 따라감)의 대비가 기준(일반 4.5, 큰 글자 3) 미만
// - small: 터치 영역이 24×24px보다 작은 조작 요소(문장 안 링크는 제외)
export type Audit = { unnamed: string[]; contrast: string[]; small: string[] };

export async function audit(page: Page, opts: { touch?: boolean } = {}): Promise<Audit> {
    return page.evaluate((touch) => {
        // 닫힌 <details>의 내용은 크기가 있어도 그려지지 않는다(content-visibility). 요약 줄(summary)만 보인다.
        const inClosedDetails = (e: Element) => {
            for (let d = e.parentElement?.closest("details:not([open])"); d; d = d.parentElement?.closest("details:not([open])")) {
                const sum = d.querySelector(":scope > summary");
                if (!sum?.contains(e)) return true;
            }
            return false;
        };
        const visible = (e: Element) => {
            const r = e.getBoundingClientRect();
            const s = getComputedStyle(e);
            return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none" && !inClosedDetails(e);
        };
        const desc = (e: Element) => `${e.tagName.toLowerCase()}${e.id ? "#" + e.id : ""}.${[...e.classList].join(".")} "${(e.textContent ?? "").trim().slice(0, 40)}"`;
        const name = (e: Element): string => {
            const h = e as HTMLElement;
            const al = h.getAttribute("aria-label");
            if (al?.trim()) return al;
            const lb = h.getAttribute("aria-labelledby");
            if (lb) return lb.split(/\s+/).map((id) => document.getElementById(id)?.textContent ?? "").join(" ").trim();
            const labels = (h as HTMLInputElement).labels;
            if (labels && labels.length) return [...labels].map((l) => l.textContent ?? "").join(" ").trim();
            const t = (h.innerText ?? "").trim();
            if (t) return t;
            const img = h.querySelector("img[alt]");
            if (img?.getAttribute("alt")) return img.getAttribute("alt")!;
            return (h.getAttribute("title") ?? "").trim();
        };
        const ctrls = [...document.querySelectorAll("button, a[href], input:not([type=hidden]), select, textarea, summary, [role=button]")].filter(visible);
        const unnamed = ctrls.filter((e) => !name(e)).map(desc);

        const rgb = (c: string) => {
            const m = c.match(/rgba?\(([^)]+)\)/);
            if (!m) return null;
            const p = m[1]!.split(/[ ,/]+/).filter(Boolean).map(Number);
            return { r: p[0]!, g: p[1]!, b: p[2]!, a: p[3] ?? 1 };
        };
        const lum = (c: { r: number; g: number; b: number }) =>
            [c.r, c.g, c.b].map((v) => v / 255).map((x) => (x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4)).reduce((s, x, i) => s + x * [0.2126, 0.7152, 0.0722][i]!, 0);
        const bgOf = (e: Element | null): { r: number; g: number; b: number } => {
            // 불투명 배경이 나올 때까지 조상을 따라 섞는다(반투명은 아래 배경과 혼합).
            const stack: { r: number; g: number; b: number; a: number }[] = [];
            for (let x = e; x; x = x.parentElement) {
                const c = rgb(getComputedStyle(x).backgroundColor);
                if (c && c.a > 0) {
                    stack.push(c);
                    if (c.a >= 1) break;
                }
            }
            let base = { r: 255, g: 255, b: 255 };
            for (const c of stack.reverse()) base = { r: c.r * c.a + base.r * (1 - c.a), g: c.g * c.a + base.g * (1 - c.a), b: c.b * c.a + base.b * (1 - c.a) };
            return base;
        };
        const contrast: string[] = [];
        const seen = new Set<Element>();
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        for (let n = walker.nextNode(); n; n = walker.nextNode()) {
            if (!n.textContent?.trim()) continue;
            const el = n.parentElement;
            if (!el || seen.has(el) || !visible(el)) continue;
            seen.add(el);
            // 비활성 조작 요소는 대비 기준 예외(WCAG 1.4.3)
            if (el.closest("button:disabled, [aria-disabled=true], option, .xterm")) continue;
            const s = getComputedStyle(el);
            const fg = rgb(s.color);
            if (!fg) continue;
            const bg = bgOf(el);
            const f = { r: fg.r * fg.a + bg.r * (1 - fg.a), g: fg.g * fg.a + bg.g * (1 - fg.a), b: fg.b * fg.a + bg.b * (1 - fg.a) };
            const [hi, lo] = [lum(f), lum(bg)].sort((a, b) => b - a);
            const ratio = (hi! + 0.05) / (lo! + 0.05);
            const size = parseFloat(s.fontSize);
            const bold = Number(s.fontWeight) >= 700;
            const need = size >= 24 || (bold && size >= 18.66) ? 3 : 4.5;
            if (ratio < need) contrast.push(`${desc(el)} ${ratio.toFixed(2)} < ${need} (${s.color} on rgb(${bg.r | 0}, ${bg.g | 0}, ${bg.b | 0}))`);
        }
        const small = touch
            ? ctrls
                  .filter((e) => !(e.tagName === "A" && e.closest("p, li")) && !(e as HTMLInputElement).labels?.length)
                  .filter((e) => {
                      const r = e.getBoundingClientRect();
                      return r.width < 24 || r.height < 24;
                  })
                  .map((e) => `${desc(e)} ${Math.round(e.getBoundingClientRect().width)}x${Math.round(e.getBoundingClientRect().height)}`)
            : [];
        return { unnamed, contrast, small };
    }, !!opts.touch);
}
