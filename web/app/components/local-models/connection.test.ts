import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ApiError } from "../../api/client";
import { LocalModelConnection } from "./LocalModelConnection";
import { LocalProfileCreation, localProfileInput } from "./connection";

const draft = { name: " local ", base_url: " http://127.0.0.1:8000/v1/ ", model: " manual ", secret_id: "" };

describe("선택적 로컬 HTTP 연결", () => {
    it("명시 endpoint와 모델만 정규화하고 키·자동 모델을 만들지 않는다", () => {
        expect(localProfileInput(draft)).toEqual({
            name: "local", protocol: "openai", base_url: "http://127.0.0.1:8000/v1", model: "manual", secret_id: null,
        });
        expect(localProfileInput({ ...draft, base_url: "https://inference.lan:8443/api/v1", secret_id: "secret-ref" }).secret_id).toBe("secret-ref");
        expect(localProfileInput({ ...draft, base_url: "http://[::1]:8000/v1" }).base_url).toBe("http://[::1]:8000/v1");
    });
    it("endpoint의 키·query·fragment와 미지원 protocol·빈 모델을 전송하지 않는다", () => {
        for (const base_url of ["", "ollama://localhost", "file:///model", "http://", "http://user:password@localhost:8000/v1",
            "http://localhost:8000/v1?key=fixture", "http://localhost:8000/v1#fixture"]) {
            expect(() => localProfileInput({ ...draft, base_url })).toThrow();
        }
        for (const model of ["", "has space"]) expect(() => localProfileInput({ ...draft, model })).toThrow();
    });
    it("원격 Grove 서버 의미·수동 fallback·선택적 키를 표시하고 처음에는 endpoint가 비어 있다", () => {
        const html = renderToStaticMarkup(createElement(LocalModelConnection, { secrets: [], onCreate: vi.fn() }));
        expect(html).toContain("이 브라우저·휴대폰이 아니라 Grove 서버");
        expect(html).toContain("수동 모델은 유지");
        expect(html).toContain("키 없음");
        expect(html).toMatch(/aria-label="로컬 endpoint"[^>]*value=""/);
    });
    it("응답 유실 뒤에는 본문·키를 재사용하고 중복 생성·변경된 입력을 막는다", async () => {
        const request = new LocalProfileCreation();
        const create = vi.fn().mockRejectedValueOnce(new ApiError(0, "network_error", "lost", true, { result_unknown: true }))
            .mockResolvedValueOnce({ id: "profile" });
        await expect(request.run(draft, create)).rejects.toThrow("lost");
        expect(request.pending).not.toBeNull();
        await expect(request.run({ ...draft, model: "other" }, create)).rejects.toThrow("먼저 확인");
        await expect(request.run(draft, create)).resolves.toBe(true);
        expect(create).toHaveBeenCalledTimes(2);
        expect(create.mock.calls[0]).toEqual(create.mock.calls[1]);
        expect(request.pending).toBeNull();
    });
    it("확정 거절은 입력 수정을 허용하며 진행 중 재제출은 보내지 않는다", async () => {
        const request = new LocalProfileCreation();
        await expect(request.run(draft, vi.fn().mockRejectedValue(new ApiError(403, "forbidden", "owner only")))).rejects.toThrow("owner only");
        expect(request.pending).toBeNull();
        let release!: () => void;
        const create = vi.fn(() => new Promise<void>((resolve) => { release = resolve; }));
        const saving = request.run(draft, create);
        await expect(request.run(draft, create)).resolves.toBe(false);
        expect(create).toHaveBeenCalledTimes(1);
        release();
        await saving;
        expect(request.busy).toBe(false);
    });
});
