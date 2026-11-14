// 로컬 relay 시험 스택의 네트워크 조건 주입 프록시. 브라우저·데몬 ↔ 로컬 relay 사이의 TCP를 그대로 중계한다.
// 실서비스 경로에는 쓰지 않는다. 제어(HTTP, 127.0.0.1 전용):
//   POST /delay?ms=N      방향마다 N ms 지연(순서 유지)
//   POST /cut             현재 연결을 모두 즉시 끊는다(모바일 백그라운드에서 OS가 소켓을 정리한 상황)
//   POST /blackhole?on=1  연결은 열어 둔 채 전달만 멈춘다(응답 없는 죽은 연결). on=0이면 다시 전달한다.
//   GET  /stats           현재 설정·연결 수
import net from "node:net";
import http from "node:http";

const arg = (name, fallback) => {
    const i = process.argv.indexOf(`--${name}`);
    return i >= 0 ? process.argv[i + 1] : fallback;
};
const [targetHost, targetPort] = arg("target", "").split(":");
if (!targetHost || !targetPort) { console.error("--target host:port가 필요합니다"); process.exit(2); }
const state = { delay: Number(arg("delay", "0")), blackhole: false, opened: 0 };
const sockets = new Set();

// 지연을 넣어도 바이트 순서는 바꾸지 않는다. 직전 chunk보다 먼저 쓰지 않는다.
function pipe(from, to) {
    let last = 0;
    from.on("data", (chunk) => {
        if (state.blackhole) return;
        const due = Math.max(Date.now() + state.delay, last);
        last = due;
        setTimeout(() => { if (!to.destroyed) to.write(chunk); }, due - Date.now());
    });
    from.on("end", () => setTimeout(() => to.end(), Math.max(0, last - Date.now())));
}

const proxy = net.createServer((client) => {
    state.opened++;
    // 실제 경로처럼 작은 frame을 바로 보낸다. 프록시가 Nagle 지연을 더하면 측정이 왜곡된다.
    client.setNoDelay(true);
    const upstream = net.connect(Number(targetPort), targetHost);
    upstream.setNoDelay(true);
    for (const socket of [client, upstream]) {
        sockets.add(socket);
        socket.on("close", () => sockets.delete(socket));
        socket.on("error", () => { client.destroy(); upstream.destroy(); });
    }
    pipe(client, upstream);
    pipe(upstream, client);
});

const control = http.createServer((req, res) => {
    const url = new URL(req.url, "http://control");
    if (req.method === "POST" && url.pathname === "/delay") state.delay = Math.max(0, Number(url.searchParams.get("ms") ?? "0"));
    else if (req.method === "POST" && url.pathname === "/cut") { for (const socket of sockets) socket.destroy(); }
    else if (req.method === "POST" && url.pathname === "/blackhole") state.blackhole = url.searchParams.get("on") === "1";
    else if (!(req.method === "GET" && url.pathname === "/stats")) { res.writeHead(404).end(); return; }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ delay: state.delay, blackhole: state.blackhole, open: sockets.size / 2, opened: state.opened }));
});

proxy.listen(Number(arg("port", "0")), "127.0.0.1", () => {
    control.listen(0, "127.0.0.1", () => {
        console.log(JSON.stringify({ proxy: proxy.address().port, control: control.address().port }));
    });
});
for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => { for (const s of sockets) s.destroy(); process.exit(0); });
