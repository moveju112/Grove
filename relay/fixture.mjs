// Rust 회귀 검사의 격리된 릴레이. 실서비스 설정·계정은 사용하지 않는다.
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
const mf = new Miniflare(convertV4MiniflareOptions({
    modules: true,
    scriptPath: new URL("./worker.mjs", import.meta.url).pathname,
    compatibilityDate: "2026-04-07",
    durableObjects: { RELAY: { className: "GroveRelay", useSQLite: true } },
    bindings: { ROOM: process.env.TEST_ROOM, DAEMON_TOKEN: process.env.TEST_TOKEN,
        ...(process.env.PAGES_ORIGIN ? { PAGES_ORIGIN: process.env.PAGES_ORIGIN } : {}) },
    host: "127.0.0.1",
    port: 0,
}));
console.log((await mf.ready).href);
// Rust 시험은 stdin을 닫아 종료한다. 로컬 시험 스택(scripts/relay_stack.py)은 SIGTERM으로 종료한다.
const stop = async () => { await mf.dispose(); process.exit(0); };
if (process.env.FIXTURE_DETACHED === "1") for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, stop);
else {
    process.stdin.resume();
    process.stdin.on("end", async () => { await mf.dispose(); });
}
