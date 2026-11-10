// 빌드 산출물의 service worker에 버전(자산 hash)과 precache 목록을 넣는다.
// 같은 입력이면 같은 버전 → 불필요한 업데이트 안내가 생기지 않는다.
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

const root = new URL("../build/client/", import.meta.url).pathname;
const files = [];
const walk = (d) => {
    for (const f of readdirSync(d)) {
        const p = join(d, f);
        if (statSync(p).isDirectory()) walk(p);
        else files.push(p);
    }
};
walk(root);
const urls = files
    .map((p) => "/" + relative(root, p).split("\\").join("/"))
    .filter((u) => u !== "/sw.js" && !u.endsWith(".map"))
    .map((u) => (u === "/index.html" ? "/" : u))
    .sort();
const h = createHash("sha256");
for (const p of files.filter((f) => !f.endsWith("sw.js")).sort()) {
    h.update(relative(root, p));
    h.update(readFileSync(p));
}
const version = h.digest("hex").slice(0, 16);
const swPath = join(root, "sw.js");
const sw = readFileSync(swPath, "utf8").replace("__GROVE_BUILD__", version);
writeFileSync(swPath, `self.__GROVE_ASSETS__ = ${JSON.stringify(urls)};\n` + sw);
console.log(`sw version ${version}, ${urls.length} assets`);
