import { describe, expect, it } from "vitest";
import { fileAttemptKey, loadFileAttempt, loadFileBuffer, loadFileView, parseFileBuffer, saveFileBuffer, saveFileView, type FileBuffer } from "./fileState";

function storage() {
    const data = new Map<string, string>();
    return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => { data.set(k, v); }, removeItem: (k: string) => { data.delete(k); } };
}
const buffer: FileBuffer = { text: "편집 사본", base: "a".repeat(64), start: 2, end: 4, direction: "backward", top: 400, left: 30 };

describe("파일 작업 이어하기", () => {
    it("기존 탭은 자기 사본을 유지하고 새 탭만 마지막 사본을 복제한다", () => {
        const s = storage();
        saveFileBuffer(s, "p", "a.txt", "one", buffer);
        const second = { ...buffer, text: "다른 사본" };
        saveFileBuffer(s, "p", "a.txt", "two", second);
        expect(loadFileBuffer(s, "p", "a.txt", "one")?.buffer).toEqual(buffer);
        expect(loadFileBuffer(s, "p", "a.txt", "three")).toEqual({ copy: "two", buffer: second });
        expect(loadFileBuffer(s, "other", "a.txt", "one")).toBeNull();
        expect(loadFileBuffer(s, "p", "other.txt", "one")).toBeNull();
    });
    it("깨진 사본과 잘못된 선택·해시·좌표를 무시한다", () => {
        expect(parseFileBuffer("{")).toBeNull();
        for (const changed of [{ start: -1 }, { end: 1 }, { top: -1 }, { base: "bad" }, { direction: "up" }, { text: 2 }]) {
            expect(parseFileBuffer(JSON.stringify({ ...buffer, ...changed }))).toBeNull();
        }
        expect(parseFileBuffer(JSON.stringify({ ...buffer, text: null, base: null }))).toEqual({ ...buffer, text: null, base: null });
    });
    it("파일 탐색기의 선택은 프로젝트·탭별로 분리한다", () => {
        const s = storage();
        saveFileView(s, "p", "one", "src/a.txt");
        expect(loadFileView(s, "p", "one")).toBe("src/a.txt");
        expect(loadFileView(s, "other", "one")).toBeNull();
        expect(loadFileView(s, "p", "two")).toBeNull();
    });
    it("보류 요청은 같은 대상·본문·키로만 복원한다", () => {
        const s = storage();
        const key = fileAttemptKey("p", "a", "one");
        expect(fileAttemptKey("p", "op", "one", "op")).not.toBe(fileAttemptKey("p", "op", "one"));
        const attempt = { method: "put", path: "/projects/p/files/content", body: { path: "a", text: "편집", expected_sha256: buffer.base }, key: "same-request" };
        s.setItem(key, JSON.stringify(attempt));
        expect(loadFileAttempt(s, key, attempt.path, "put", "a")).toEqual(attempt);
        expect(loadFileAttempt(s, key, "/projects/q/files/content", "put", "a")).toBeNull();
        expect(loadFileAttempt(s, key, attempt.path, "post", "a")).toBeNull();
        expect(loadFileAttempt(s, key, attempt.path, "put", "b")).toBeNull();
    });
});
