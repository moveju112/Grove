// 호스트 목록은 이 origin의 브라우저에만 보관한다. 인증 정보·서버 데이터는 넣지 않는다.
export type Host = { origin: string; alias: string; lastOpenedAt: number | null };
export type HostStorage = Pick<Storage, "getItem" | "setItem">;
export const HOSTS_KEY = "grove.hosts.v1";
export const MAX_HOSTS = 50;

export function hostOrigin(address: string): string {
    const raw = address.trim();
    if (!/^https?:\/\//i.test(raw) || /[\s?#\\]/.test(raw)) {
        throw new Error("http:// 또는 https://로 시작하는 서버 주소만 입력하세요. 경로·인증 정보·query·fragment는 넣지 마세요.");
    }
    let url: URL;
    try {
        url = new URL(raw);
    } catch {
        throw new Error("올바른 서버 주소를 입력하세요.");
    }
    if (url.username || url.password || url.pathname !== "/") {
        throw new Error("서버 주소에는 경로나 인증 정보를 넣을 수 없습니다.");
    }
    return url.origin;
}

export function loadHosts(storage: HostStorage): Host[] {
    try {
        const data: unknown = JSON.parse(storage.getItem(HOSTS_KEY) ?? "null");
        if (!data || typeof data !== "object" || !("schema" in data) || data.schema !== 1 || !("hosts" in data) || !Array.isArray(data.hosts)) return [];
        const hosts: Host[] = [];
        for (const row of data.hosts.slice(0, MAX_HOSTS)) {
            if (!row || typeof row.origin !== "string" || typeof row.alias !== "string") continue;
            let origin: string;
            try {
                origin = hostOrigin(row.origin);
            } catch {
                continue;
            }
            const alias = row.alias.trim();
            if (!alias || alias.length > 80 || hosts.some((h) => h.origin === origin)) continue;
            hosts.push({
                origin,
                alias,
                lastOpenedAt: typeof row.lastOpenedAt === "number" && Number.isFinite(row.lastOpenedAt) && row.lastOpenedAt >= 0 ? row.lastOpenedAt : null,
            });
        }
        return hosts;
    } catch {
        return [];
    }
}

function write(storage: HostStorage, hosts: Host[]): Host[] {
    storage.setItem(HOSTS_KEY, JSON.stringify({ schema: 1, hosts }));
    return hosts;
}

export function saveHost(storage: HostStorage, address: string, name: string, previousOrigin?: string): Host[] {
    const origin = hostOrigin(address);
    const alias = name.trim();
    if (!alias || alias.length > 80) throw new Error("별명은 1~80자로 입력하세요.");
    const hosts = loadHosts(storage);
    const previous = hosts.find((h) => h.origin === previousOrigin);
    if (hosts.some((h) => h.origin === origin && h.origin !== previousOrigin)) throw new Error("이미 등록한 호스트입니다.");
    if (!previous && hosts.length >= MAX_HOSTS) throw new Error(`호스트는 ${MAX_HOSTS}개까지 등록할 수 있습니다.`);
    // 주소가 바뀌면 이전 주소의 접속 이력을 새 서버에 붙이지 않는다.
    const next: Host = { origin, alias, lastOpenedAt: previous?.origin === origin ? previous.lastOpenedAt : null };
    return write(storage, previous ? hosts.map((h) => h === previous ? next : h) : [...hosts, next]);
}

export function removeHost(storage: HostStorage, origin: string): Host[] {
    return write(storage, loadHosts(storage).filter((h) => h.origin !== origin));
}

export function markHostOpened(storage: HostStorage, origin: string, now = Date.now()): Host[] {
    return write(storage, loadHosts(storage).map((h) => h.origin === origin ? { ...h, lastOpenedAt: now } : h));
}

export function recentHosts(hosts: Host[]): Host[] {
    return [...hosts].sort((a, b) => (b.lastOpenedAt ?? -1) - (a.lastOpenedAt ?? -1) || a.alias.localeCompare(b.alias));
}

export function insecureRemote(origin: string): boolean {
    const url = new URL(origin);
    return url.protocol === "http:" && url.hostname !== "localhost" && url.hostname !== "[::1]" && !/^127\./.test(url.hostname);
}
