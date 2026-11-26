"""public/icon.svg와 같은 모양의 PNG 아이콘(192, 512)을 만든다. 실행: python3 scripts/make-icons.py

icon.svg를 바꾸면 아래 좌표도 함께 바꾼다. 새싹은 components/icons.tsx의 sprout(24 격자)과 같은 곡선이다.
"""
import math
from pathlib import Path

from PIL import Image, ImageDraw

OUT = Path(__file__).resolve().parent.parent / "public"
BASE = 2048  # 이 크기로 그린 뒤 줄여서 가장자리를 부드럽게 한다.
GREEN, MINT, WHITE = "#2f7d55", "#9fd3ad", "#ffffff"


def cubic(p0, p1, p2, p3, n=48):
    return [
        (
            (1 - t) ** 3 * p0[0] + 3 * (1 - t) ** 2 * t * p1[0] + 3 * (1 - t) * t * t * p2[0] + t ** 3 * p3[0],
            (1 - t) ** 3 * p0[1] + 3 * (1 - t) ** 2 * t * p1[1] + 3 * (1 - t) * t * t * p2[1] + t ** 3 * p3[1],
        )
        for t in (i / n for i in range(n + 1))
    ]


# icons.tsx sprout: 줄기, 오른쪽 잎, 왼쪽 잎 (24 격자)
SPROUT = [
    [(12, 21), (12, 12)],
    cubic((12, 12), (12, 8.7), (14.4, 6), (18, 6)) + cubic((18, 6), (18, 9.3), (15.6, 12), (12, 12))[1:],
    cubic((12, 14), (12, 11), (9.8, 8.5), (6.5, 8.5)) + cubic((6.5, 8.5), (6.5, 11.5), (8.7, 14), (12, 14))[1:],
]


def stroke(d, pts, width, color):
    """둥근 끝·이음의 굵은 선. PIL line의 joint는 두꺼운 곡선에서 틈이 생겨 직접 채운다."""
    r = width / 2
    for (x0, y0), (x1, y1) in zip(pts, pts[1:]):
        length = math.hypot(x1 - x0, y1 - y0) or 1
        nx, ny = -(y1 - y0) / length * r, (x1 - x0) / length * r
        d.polygon([(x0 + nx, y0 + ny), (x1 + nx, y1 + ny), (x1 - nx, y1 - ny), (x0 - nx, y0 - ny)], fill=color)
    for x, y in pts:
        d.ellipse([x - r, y - r, x + r, y + r], fill=color)


def sprout(d, k, cx, cy, s, width, color):
    """icon.svg의 translate(cx-12.25s, cy-13.5s) scale(s), 512 좌표계."""
    tx, ty = cx - 12.25 * s, cy - 13.5 * s
    for path in SPROUT:
        stroke(d, [((tx + x * s) * k, (ty + y * s) * k) for x, y in path], width * s * k, color)


def draw(size: int) -> Image.Image:
    k = BASE / 512
    img = Image.new("RGBA", (BASE, BASE), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle([0, 0, BASE - 1, BASE - 1], radius=round(112 * k), fill=GREEN)
    stroke(d, [(108 * k, 356 * k), (404 * k, 356 * k)], 20 * k, MINT)  # 땅
    sprout(d, k, 136, 289.5, 7, 2.6, MINT)
    sprout(d, k, 376, 289.5, 7, 2.6, MINT)
    sprout(d, k, 256, 237, 14, 2.2, WHITE)
    return img.resize((size, size), Image.LANCZOS)


for n in (192, 512):
    draw(n).save(OUT / f"icon-{n}.png", optimize=True)
    print(f"wrote icon-{n}.png")
