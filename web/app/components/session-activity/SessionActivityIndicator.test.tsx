import { describe, expect, it } from "vitest";
import type { ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { isWaitingForResponse, VineOrbit, VINE_DURATIONS, VINE_LENGTHS, VINE_LEAF_SPACING } from "./SessionActivityIndicator";
import { orbitDelay, orbitKeyframes, perimeterGeometry } from "./vineGeometry";

const render = (length: keyof typeof VINE_LENGTHS, groups: ComponentProps<typeof VineOrbit>["groups"] = 2) => renderToStaticMarkup(<VineOrbit width={400} height={600}
    pixels={VINE_LENGTHS[length]} duration={VINE_DURATIONS.normal} leafCount={Math.floor((VINE_LENGTHS[length] - VINE_LEAF_SPACING) / VINE_LEAF_SPACING)} groups={groups} />);

describe("대기 중 새싹 인디케이터", () => {
    it("접수·실행 중에만 움직이고 승인 대기·종료 상태에는 표시하지 않는다", () => {
        expect(isWaitingForResponse("queued")).toBe(true);
        expect(isWaitingForResponse("running")).toBe(true);
        for (const status of ["awaiting_approval", "completed", "failed", "cancelled", "interrupted", "unknown"] as const) {
            expect(isWaitingForResponse(status)).toBe(false);
        }
    });
    it("두 잎 무리에 잎 12장씩 두고 뒤쪽 잎을 점점 옅게 그린다", () => {
        const html = render("medium");
        expect(html.match(/data-vine-leaf=""/g)).toHaveLength(24);
        const leaves = [...html.matchAll(/data-vine-leaf=""[^>]+opacity="([\d.]+)"/g)].map((match) => Number(match[1]));
        expect(leaves).toHaveLength(24);
        expect(leaves.slice(0, 12).every((value, index, values) => index === 0 || value < values[index - 1]!)).toBe(true);
    });
    it("길수록 잎이 늘어나고 빠른 설정의 한 주기는 짧다", () => {
        const count = (length: keyof typeof VINE_LENGTHS) =>
            (render(length).match(/data-vine-leaf=""/g) ?? []).length;
        expect(count("short")).toBeLessThan(count("medium"));
        expect(count("medium")).toBeLessThan(count("long"));
        expect(VINE_LENGTHS.medium).toBe(104);
        expect(VINE_DURATIONS.fast).toBeLessThan(VINE_DURATIONS.normal);
        expect(VINE_DURATIONS.normal).toBeLessThan(VINE_DURATIONS.slow);
    });
    it("리사이즈된 세션의 가로·세로 길이를 모두 순환 경로에 반영한다", () => {
        const base = perimeterGeometry(400, 600);
        expect(perimeterGeometry(500, 600).perimeter - base.perimeter).toBeCloseTo(200);
        expect(perimeterGeometry(400, 700).perimeter - base.perimeter).toBeCloseTo(200);
    });
    it("직선은 길이에 비례하는 시간 동안 이동하고 모서리에서만 회전한다", () => {
        const geometry = perimeterGeometry(400, 600);
        const frames = orbitKeyframes(geometry);
        expect(frames[0]).toEqual({ offset: 0, transform: "translate(11px, 3px) rotate(0deg)" });
        expect(frames[1]!.offset).toBeCloseTo(378 / geometry.perimeter);
        expect(frames[1]!.transform).toBe("translate(389px, 3px) rotate(0deg)");
        expect(frames[9]!.transform).toBe("translate(397px, 11px) rotate(90deg)");
        expect(frames.at(-1)).toEqual({ offset: 1, transform: "translate(11px, 3px) rotate(360deg)" });
        expect(frames.slice(1).every((frame, i) => frame.offset! > frames[i]!.offset!)).toBe(true);
    });
    it("같은 무리의 뒤 잎은 둘레에서 8px 뒤따른다", () => {
        const { perimeter } = perimeterGeometry(400, 600);
        const duration = VINE_DURATIONS.normal;
        expect(orbitDelay(.18, 14, perimeter, duration) - orbitDelay(.18, 6, perimeter, duration))
            .toBeCloseTo(duration * VINE_LEAF_SPACING / perimeter, 10);
    });
    it("설정한 2~7개 무리마다 같은 수의 잎을 렌더링한다", () => {
        for (const groups of [2, 3, 4, 5, 6, 7] as const) {
            const html = render("medium", groups);
            expect(html.match(/data-testid="session-vine-runner"/g)).toHaveLength(groups);
            expect(html.match(/data-vine-leaf=""/g)).toHaveLength(groups * 12);
        }
    });
});
