"""Art math: what a drawing is made of, computed from its strokes.

Stored next to each asset (and each asset version) so a library can be searched by *how* things
were made: mostly by hand, which colors, how much ink, how long the pencil was down.
"""

import colorsys
import math
from collections import Counter

from backend.library import CANVAS_HEIGHT, CANVAS_WIDTH
from backend.models import Layer, Stroke

COLOR_FAMILIES = ("red", "orange", "yellow", "green", "blue", "purple", "pink", "brown", "black", "white", "gray")


def color_family(hex_color: str) -> str:
    r, g, b = (int(hex_color[i:i + 2], 16) / 255 for i in (1, 3, 5))
    hue, light, sat = colorsys.rgb_to_hls(r, g, b)
    hue *= 360
    if light < 0.16:
        return "black"
    if light > 0.9 and sat < 0.5:
        return "white"
    if sat < 0.25:  # slate and blue-grays read as gray to an artist
        return "gray"
    if 15 <= hue < 45 and light < 0.4:
        return "brown"
    for limit, name in ((15, "red"), (45, "orange"), (68, "yellow"), (170, "green"), (255, "blue"), (290, "purple"), (345, "pink")):
        if hue < limit:
            return name
    return "red"


def stroke_length(stroke: Stroke) -> float:
    return sum(math.dist((a.x * CANVAS_WIDTH, a.y * CANVAS_HEIGHT), (b.x * CANVAS_WIDTH, b.y * CANVAS_HEIGHT))
               for a, b in zip(stroke.points, stroke.points[1:]))


def art_stats(layers: list[Layer]) -> dict:
    strokes = [stroke for layer in layers for stroke in layer.strokes]
    # What you see is what counts: hidden layers (construction guides, backups) don't inflate the math.
    ink = [stroke for layer in layers if layer.visible for stroke in layer.strokes if not stroke.erase]
    ai = sum(1 for stroke in ink if stroke.ai)
    kit = sum(1 for stroke in ink if stroke.kit and not stroke.ai)
    weight: Counter[str] = Counter()
    for stroke in ink:
        # Line length (plus a little for dots and fills) decides which colors define the drawing.
        weight[stroke.color.lower()] += stroke_length(stroke) * stroke.width + stroke.width ** 2
        if stroke.fill:
            weight[stroke.fill.lower()] += 2000
    palette = [color for color, _ in weight.most_common(6)]
    return {
        "strokes": len(ink), "hand": len(ink) - ai - kit, "ai": ai, "kit": kit,
        "erasers": sum(1 for stroke in strokes if stroke.erase),
        "hand_share": round((len(ink) - ai - kit) / len(ink), 3) if ink else 1.0,
        "ink_px": round(sum(stroke_length(stroke) for stroke in ink)),
        "points": sum(len(stroke.points) for stroke in strokes),
        "draw_ms": sum(stroke.ms or 0 for stroke in strokes),
        "layers": len(layers), "palette": palette,
        "colors": list(dict.fromkeys(color_family(color) for color in palette)),
    }
