const HTML = new Set("a abbr article aside b blockquote br button caption code col colgroup dd del details div dl dt em figcaption figure footer h1 h2 h3 h4 h5 h6 header hr i img input kbd label li main mark nav ol p pre s section small span strong style sub summary sup table tbody td textarea tfoot th thead tr u ul".split(" "));
const SVG = new Set("svg g defs style path rect circle ellipse line polyline polygon text tspan title desc lineargradient radialgradient stop clippath mask pattern".split(" "));
const ATTRS = new Set("id class title role dir lang style alt width height colspan rowspan viewbox xmlns d x y x1 y1 x2 y2 cx cy r rx ry points fill fill-rule fill-opacity stroke stroke-width stroke-linecap stroke-linejoin stroke-dasharray stroke-opacity opacity transform preserveaspectratio offset stop-color stop-opacity gradientunits gradienttransform patternunits patterntransform clip-path clip-rule mask text-anchor font-family font-size font-weight".split(" "));
const CSP = "default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";

export function isArtifact(path: string): boolean {
    return /\.(html?|svg|md|markdown|pdf|txt)$/i.test(path);
}

// template는 파싱 중에도 inert다. DOMParser는 격리 문서에서도 자원을 받을 수 있으므로 쓰지 않는다.
// 허용 목록은 정적 표시 전용이다. URL·redirect·폼·활성 SVG를 없애고 sandbox/CSP도 별도로 강제한다.
export function artifactDocument(source: string): string {
    const template = document.createElement("template");
    template.innerHTML = source;
    for (const element of template.content.querySelectorAll("*")) {
        const tag = element.localName.toLowerCase();
        const allowed = element.namespaceURI === "http://www.w3.org/1999/xhtml" ? HTML : element.namespaceURI === "http://www.w3.org/2000/svg" ? SVG : null;
        if (!allowed?.has(tag)) { element.remove(); continue; }
        for (const attribute of [...element.attributes]) {
            const name = attribute.name.toLowerCase();
            const image = tag === "img" && name === "src" && /^data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/=\s]+$/i.test(attribute.value);
            if (!ATTRS.has(name) && !name.startsWith("aria-") && !image) element.removeAttributeNode(attribute);
        }
        if (["button", "input", "textarea"].includes(tag)) element.setAttribute("disabled", "");
    }
    return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${CSP}"><style>body{margin:1rem;font:16px/1.5 system-ui;color:#202020;background:#fff;overflow-wrap:anywhere}img,svg{max-width:100%}table{border-collapse:collapse}td,th{padding:.3em;border:1px solid #ccc}</style></head><body>${template.innerHTML}</body></html>`;
}
