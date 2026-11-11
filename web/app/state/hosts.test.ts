import { beforeEach, describe, expect, it } from "vitest";
import { HOSTS_KEY, hostOrigin, insecureRemote, loadHosts, markHostOpened, recentHosts, removeHost, saveHost } from "./hosts";

const values = new Map<string, string>();
const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
beforeEach(() => values.clear());

describe("origin별 호스트 목록", () => {
    it("동등한 URL을 정규화하고 같은 호스트의 중복을 거절한다", () => {
        expect(hostOrigin(" HTTPS://EXAMPLE.COM:443/ ")).toBe("https://example.com");
        saveHost(storage, "https://example.com/", " 첫 서버 ");
        expect(() => saveHost(storage, "https://EXAMPLE.com:443", "중복")).toThrow("이미 등록");
        expect(loadHosts(storage)).toEqual([{ origin: "https://example.com", alias: "첫 서버", lastOpenedAt: null }]);
    });

    it.each([
        "https://user:secret@example.com", "https://example.com/path", "https://example.com/?token=secret",
        "https://example.com/#secret", "javascript:alert(1)", "//example.com", "https://example.com\\@other.test",
        "https://exa\nmple.com", "https://example.com?", "https://example.com#",
    ])("자격증명·경로·모호한 주소를 저장하지 않는다: %s", (address) => {
        expect(() => saveHost(storage, address, "호스트")).toThrow();
        expect(values.size).toBe(0);
    });

    it("별명 수정은 열기 이력을 보존하고 주소 변경은 이력을 초기화한다", () => {
        saveHost(storage, "https://a.test", "A");
        markHostOpened(storage, "https://a.test", 100);
        saveHost(storage, "https://a.test", "바뀐 A", "https://a.test");
        expect(loadHosts(storage)[0]).toMatchObject({ alias: "바뀐 A", lastOpenedAt: 100 });
        saveHost(storage, "https://b.test", "B", "https://a.test");
        expect(loadHosts(storage)).toEqual([{ origin: "https://b.test", alias: "B", lastOpenedAt: null }]);
    });

    it("최근 선택 순서로 정렬하고 삭제는 자격증명·초안 등 다른 저장 항목을 건드리지 않는다", () => {
        storage.setItem("grove.draft.session:1", "보존");
        saveHost(storage, "https://a.test", "A");
        saveHost(storage, "https://b.test", "B");
        markHostOpened(storage, "https://b.test", 100);
        markHostOpened(storage, "https://a.test", 200);
        expect(recentHosts(loadHosts(storage)).map((h) => h.alias)).toEqual(["A", "B"]);
        removeHost(storage, "https://a.test");
        expect(loadHosts(storage).map((h) => h.alias)).toEqual(["B"]);
        expect(storage.getItem("grove.draft.session:1")).toBe("보존");
    });

    it("손상·지원하지 않는 schema는 복원하지 않고 저장 필드는 허용 목록만 복원한다", () => {
        storage.setItem(HOSTS_KEY, "{");
        expect(loadHosts(storage)).toEqual([]);
        storage.setItem(HOSTS_KEY, JSON.stringify({ schema: 2, hosts: [] }));
        expect(loadHosts(storage)).toEqual([]);
        storage.setItem(HOSTS_KEY, JSON.stringify({ schema: 1, hosts: [
            { origin: "https://a.test", alias: "A", lastOpenedAt: -1, token: "not-retained" },
            { origin: "https://user:secret@b.test", alias: "B" },
        ] }));
        expect(loadHosts(storage)).toEqual([{ origin: "https://a.test", alias: "A", lastOpenedAt: null }]);
        markHostOpened(storage, "https://a.test", 100);
        expect(storage.getItem(HOSTS_KEY)).not.toContain("not-retained");
    });

    it("이름·용량을 제한하고 원격 평문 HTTP를 구별한다", () => {
        expect(() => saveHost(storage, "https://a.test", " ")).toThrow();
        expect(() => saveHost(storage, "https://a.test", "a".repeat(81))).toThrow();
        for (let i = 0; i < 50; i++) saveHost(storage, `https://h${i}.test`, `${i}`);
        expect(() => saveHost(storage, "https://overflow.test", "초과")).toThrow("50개");
        for (const url of ["http://localhost:7741", "http://127.0.0.2", "http://[::1]", "https://remote.test"]) expect(insecureRemote(url)).toBe(false);
        expect(insecureRemote("http://remote.test")).toBe(true);
    });
});
