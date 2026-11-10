"""public/icon.svg와 같은 모양의 PNG 아이콘(192, 512)을 만든다. 실행: python3 scripts/make-icons.py"""
from pathlib import Path

from PIL import Image, ImageDraw

OUT = Path(__file__).resolve().parent.parent / "public"


def draw(size: int) -> Image.Image:
    s = size / 64
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle([0, 0, size - 1, size - 1], radius=int(14 * s), fill="#2f6b3f")
    w = max(2, int(4 * s))
    light = "#e8f5ea"
    # 줄기
    d.line([(32 * s, 54 * s), (32 * s, 30 * s)], fill=light, width=w)
    # 오른쪽 잎
    d.polygon([(32 * s, 30 * s), (38 * s, 19 * s), (45 * s, 16 * s), (42 * s, 25 * s)], outline=light, width=w)
    # 왼쪽 잎
    d.polygon([(32 * s, 36 * s), (27 * s, 27 * s), (21 * s, 24 * s), (24 * s, 32 * s)], outline=light, width=w)
    # 작은 싹 두 개
    d.line([(20 * s, 54 * s), (20 * s, 42 * s)], fill="#9fd3ad", width=w)
    d.line([(44 * s, 54 * s), (44 * s, 44 * s)], fill="#9fd3ad", width=w)
    return img


for n in (192, 512):
    draw(n).save(OUT / f"icon-{n}.png", optimize=True)
    print(f"wrote icon-{n}.png")
