const inset = 3;
const maxRadius = 8;
const cornerSteps = 8;

export function perimeterGeometry(width: number, height: number) {
    const right = Math.max(inset, width - inset);
    const bottom = Math.max(inset, height - inset);
    const radius = Math.min(maxRadius, (right - inset) / 2, (bottom - inset) / 2);
    const horizontal = right - inset - 2 * radius;
    const vertical = bottom - inset - 2 * radius;
    return {
        right, bottom, radius, horizontal, vertical,
        path: `M${inset + radius} ${inset}H${right - radius}A${radius} ${radius} 0 0 1 ${right} ${inset + radius}V${bottom - radius}A${radius} ${radius} 0 0 1 ${right - radius} ${bottom}H${inset + radius}A${radius} ${radius} 0 0 1 ${inset} ${bottom - radius}V${inset + radius}A${radius} ${radius} 0 0 1 ${inset + radius} ${inset}Z`,
        perimeter: 2 * (horizontal + vertical) + 2 * Math.PI * radius,
    };
}

export function orbitKeyframes(geometry: ReturnType<typeof perimeterGeometry>): Keyframe[] {
    const { right, bottom, radius, horizontal, vertical, perimeter } = geometry;
    if (radius <= 0) return [];

    const frames: Keyframe[] = [];
    let distance = 0;
    const add = (x: number, y: number, angle: number, traveled: number) => {
        distance += traveled;
        frames.push({ offset: distance / perimeter, transform: `translate(${x}px, ${y}px) rotate(${angle}deg)` });
    };
    add(inset + radius, inset, 0, 0);
    const arcStep = Math.PI * radius / (2 * cornerSteps);
    const corners = [
        [right - radius, inset + radius, horizontal],
        [right - radius, bottom - radius, vertical],
        [inset + radius, bottom - radius, horizontal],
        [inset + radius, inset + radius, vertical],
    ] as const;
    corners.forEach(([cx, cy, straight], corner) => {
        // 직선에서는 위치만 보간하고, 모서리에서는 접선 방향까지 보간한다.
        for (let step = straight > 0 ? 0 : 1; step <= cornerSteps; step++) {
            const angle = (corner + step / cornerSteps) * 90;
            const radians = angle * Math.PI / 180;
            const x = cx + radius * Math.sin(radians);
            const y = cy - radius * Math.cos(radians);
            add(x, y, angle, step === 0 ? straight : arcStep);
        }
    });
    // 부동소수점 오차로 마지막 위치가 100%를 넘지 않게 고정한다.
    frames[frames.length - 1] = { offset: 1, transform: `translate(${inset + radius}px, ${inset}px) rotate(360deg)` };
    return frames;
}

export function orbitDelay(phase: number, distance: number, perimeter: number, duration: number) {
    return -duration * (((phase - distance / perimeter) % 1 + 1) % 1);
}
