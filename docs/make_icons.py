"""Build the app icons (home screen, install prompt, Apple touch) from the brand mark.

    python docs/make_icons.py

The ink drop and its spark on Inkling's paper. "Maskable" keeps the mark inside the 80% safe zone so
Android can crop it to any shape.
"""

import math
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "icons"
PAPER, INK, SPARK = (246, 247, 241), (18, 59, 56), (124, 58, 237)


def icon(size: int, *, safe: float) -> Image.Image:
    scale = 4  # draw big, then shrink: smooth edges without a vector renderer
    big = size * scale
    image = Image.new("RGB", (big, big), PAPER)
    draw = ImageDraw.Draw(image)
    k = big * safe / 26  # the mark spans ~26 units of its 32-unit box
    x0, y0 = (big - 26 * k) / 2 - 4 * k, (big - 26 * k) / 2 - 2.5 * k
    P = lambda px, py: (x0 + px * k, y0 + py * k)  # noqa: E731
    # The drop: a circle and the two lines from its tip that touch it exactly (tangents), so there's no seam.
    cx, cy, r, tip = 14, 19.5, 8, 4
    reach = math.acos(r / (cy - tip))  # angle at the center between "toward the tip" and each tangent point
    sides = [(cx + r * math.sin(s * reach), cy - r * math.cos(reach)) for s in (-1, 1)]
    draw.polygon([P(cx, tip), P(*sides[0]), P(cx, cy), P(*sides[1])], fill=INK)
    draw.ellipse([P(cx - r, cy - r), P(cx + r, cy + r)], fill=INK)
    draw.polygon([P(25, 3), P(26.3, 6.2), P(29.5, 7.5), P(26.3, 8.8), P(25, 12), P(23.7, 8.8), P(20.5, 7.5), P(23.7, 6.2)], fill=SPARK)
    return image.resize((size, size), Image.LANCZOS)


def main() -> None:
    OUT.mkdir(exist_ok=True)
    for name, size, safe in (("icon-192.png", 192, 0.62), ("icon-512.png", 512, 0.62),
                             ("maskable-512.png", 512, 0.5), ("apple-touch-icon.png", 180, 0.58)):
        icon(size, safe=safe).save(OUT / name, optimize=True)
        print(OUT / name)


if __name__ == "__main__":
    main()
