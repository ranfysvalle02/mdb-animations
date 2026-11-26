"""Shared scenes: a looping GIF anyone can watch, and a page that explains how it moves.

A share is a snapshot taken when the artist presses Share (share again to refresh it). The token is
unguessable, and the page shows only that snapshot: the clip, its direction, its beats, and its cast.
"""
from __future__ import annotations

import html
import io

from PIL import Image as PILImage, ImageDraw, ImageFont

from backend.library import render_image
from backend.models import Layer

CLIP_WIDTH = 480
HOLD_MS = 900  # the last pose lingers before the loop restarts

# The same words the studio uses, so the page teaches what the artist saw.
PRINCIPLES = {
    "anticipation": "A small move the other way first, so the big move reads.",
    "squash": "It flattens on impact (and keeps its volume), so it feels soft and heavy.",
    "stretch": "It stretches with speed, like a smear of motion.",
    "arc": "Living things move on curves, not straight lines.",
    "slow in": "Easing into a pose: more frames near it, so it slows down.",
    "slow out": "Easing out of a pose: it starts slow and speeds up.",
    "overshoot": "Going a little past the target...",
    "settle": "...and settling back. Nothing stops dead.",
    "hold": "A still moment so the pose reads.",
    "takeoff": "The moment it leaves the ground: maximum stretch.",
    "apex": "The top of the arc: the slowest moment of a jump.",
    "turn": "Rotation, eased in and out.",
    "contact": "The moment a foot (or a ball) meets the ground.",
}


def render_clip(stacks: list[list[Layer]], fps: int) -> tuple[bytes, bytes]:
    """An optimized looping GIF of every frame, and a PNG poster of frame 1."""
    height = round(CLIP_WIDTH * 650 / 1000)
    pictures = [render_image(stack).convert("RGB").resize((CLIP_WIDTH, height), PILImage.LANCZOS) for stack in stacks]
    frames = [picture.quantize(colors=96, method=PILImage.Quantize.MEDIANCUT, dither=PILImage.Dither.NONE) for picture in pictures]
    step = round(1000 / fps)
    clip = io.BytesIO()
    frames[0].save(clip, format="GIF", save_all=True, append_images=frames[1:], loop=0, optimize=True, disposal=1,
                   duration=[step] * (len(frames) - 1) + [max(step, HOLD_MS)])
    poster = io.BytesIO()
    pictures[0].save(poster, format="PNG", optimize=True)
    return clip.getvalue(), poster.getvalue()


# A printable flipbook: US Letter at 150 dpi, ten frames a page, each with a strip on the left to staple.
PAGE_W, PAGE_H, MARGIN, HEAD = 1275, 1650, 60, 56
COLS, ROWS, TAB = 2, 5, 96


def dashed_box(draw: ImageDraw.ImageDraw, box: tuple[int, int, int, int], dash: int = 10) -> None:
    x0, y0, x1, y1 = box
    for x in range(x0, x1, dash * 2):
        draw.line([(x, y0), (min(x + dash, x1), y0)], fill="#b6c2bb", width=2)
        draw.line([(x, y1), (min(x + dash, x1), y1)], fill="#b6c2bb", width=2)
    for y in range(y0, y1, dash * 2):
        draw.line([(x0, y), (x0, min(y + dash, y1))], fill="#b6c2bb", width=2)
        draw.line([(x1, y), (x1, min(y + dash, y1))], fill="#b6c2bb", width=2)


def render_flipbook(stacks: list[list[Layer]], code: str) -> bytes:
    """Every frame on paper: cut on the dashed lines, stack them in order (1 on top), staple the strip, flip."""
    cell_w, cell_h = (PAGE_W - 2 * MARGIN) // COLS, (PAGE_H - 2 * MARGIN - HEAD) // ROWS
    pic_h = cell_h - 24
    pic_w = min(cell_w - TAB - 16, round(pic_h * 1000 / 650))
    pic_h = round(pic_w * 650 / 1000)
    small, big = ImageFont.load_default(size=22), ImageFont.load_default(size=30)
    per = COLS * ROWS
    pages = []
    for start in range(0, len(stacks), per):
        page = PILImage.new("RGB", (PAGE_W, PAGE_H), "white")
        draw = ImageDraw.Draw(page)
        draw.text((MARGIN, MARGIN), f"Inkling flipbook \u00b7 {code} \u00b7 {len(stacks)} frames \u00b7 page {start // per + 1} of "
                  f"{-(-len(stacks) // per)}", fill="#12302c", font=small)
        draw.text((MARGIN, MARGIN + 26), "Cut on the dashed lines. Stack in order, 1 on top. Staple the left strip. Flip with your thumb.",
                  fill="#5f726d", font=small)
        for i, stack in enumerate(stacks[start:start + per]):
            x0, y0 = MARGIN + (i % COLS) * cell_w, MARGIN + HEAD + (i // COLS) * cell_h
            dashed_box(draw, (x0, y0, x0 + cell_w - 1, y0 + cell_h - 1))
            draw.text((x0 + 14, y0 + 12), str(start + i + 1), fill="#12302c", font=big)
            for dot in (0.3, 0.7):  # where the staples go
                cy = y0 + round(cell_h * dot)
                draw.ellipse((x0 + TAB // 2 - 5, cy - 5, x0 + TAB // 2 + 5, cy + 5), outline="#b6c2bb", width=2)
            picture = render_image(stack).convert("RGB").resize((pic_w, pic_h), PILImage.LANCZOS)
            page.paste(picture, (x0 + TAB, y0 + (cell_h - pic_h) // 2))
            draw.rectangle((x0 + TAB, y0 + (cell_h - pic_h) // 2, x0 + TAB + pic_w - 1, y0 + (cell_h - pic_h) // 2 + pic_h - 1), outline="#dbe4dc")
        pages.append(page)
    out = io.BytesIO()
    pages[0].save(out, format="PDF", save_all=True, append_images=pages[1:], resolution=150)
    return out.getvalue()


def explain(motion: dict | None, frames: int, fps: int) -> dict:
    """How it moves, in plain words: keyframes chosen, in-betweens computed, principles used."""
    seconds = frames / fps
    if not motion:
        return {"lead": f"{frames} frames at {fps} frames a second: {seconds:.1f} seconds, drawn frame by frame.",
                "beats": [], "principles": []}
    keys = sorted({round(key["t"] * (frames - 1)) for track in motion["tracks"] for key in track["keys"]})
    who = {"ai": "An AI director", "path": "The artist's drawn path"}.get(motion["by"], "A quick-move preset")
    chose = "became" if motion["by"] == "path" else "chose"
    lead = (f"{seconds:.1f} seconds, {frames} frames. {who} {chose} {len(keys)} keyframes, the poses that matter. "
            f"The other {frames - len(keys)} frames are in-betweens: the artist's own drawing, moved, squashed and turned "
            "on a smooth curve. Nothing was redrawn.")
    many = len(motion["tracks"]) > 1
    beats = [{"label": key.get("label") or "key", "at": round(round(key["t"] * (frames - 1)) / fps, 1),
              "who": track["name"] if many else ""}
             for track in motion["tracks"] for key in track["keys"]]
    used = dict.fromkeys(b["label"] for b in beats if b["label"] in PRINCIPLES)
    return {"lead": lead, "beats": beats, "principles": [{"name": name, "means": PRINCIPLES[name]} for name in used]}


def page(share: dict, origin: str) -> str:
    """The public page for one shared scene. Every value from the share is escaped."""
    e = lambda value: html.escape(str(value), quote=True)  # noqa: E731
    origin = e(origin)  # it may come from the Host header
    token = e(share["token"])
    title = share.get("description") or share["code"]
    cast = share.get("cast") or []
    motion = share.get("motion")
    story = explain(motion, share["frames"], share["fps"])
    direction = ""
    if motion:
        words = motion.get("prompt") if motion["by"] == "ai" else motion.get("note")
        how = {"ai": "&#10022; Directed with AI", "path": "&#12336; A path the artist drew"}.get(motion["by"], "Quick move")
        direction = f'<p class="direction">{how}: &ldquo;{e(words)}&rdquo;</p>'
    beats = "".join(f'<li><b>{e(b["label"])}</b><small>{e(b["who"]) + " &middot; " if b["who"] else ""}{b["at"]:.1f} s</small></li>'
                    for b in story["beats"][:24])
    principles = "".join(f"<div><dt>{e(p['name'])}</dt><dd>{e(p['means'])}</dd></div>" for p in story["principles"])
    cast_line = f'<p class="cast">Cast: {", ".join(f"&#9670; {e(name)}" for name in cast)}</p>' if cast else ""
    sketch = share.get("sketch") or {}
    code_section = (f'<section class="code"><h2>&#10216;/&#10217; The code that moves it</h2>'
                    f'<p class="muted">Every animation in Inkling is a small p5.js sketch: the keyframes are numbers you can read '
                    f'and change. {"Gemini chose these poses" if sketch.get("by") == "ai" else "These are the poses"}; '
                    f'math draws every frame between them, from the artist&rsquo;s own strokes.</p>'
                    f'<pre><code>{e(sketch["code"])}</code></pre>'
                    f'<div class="actions"><a class="primary" href="{origin}/?remix={token}">&#8635; Remix in Inkling</a></div></section>'
                    if sketch.get("code") else "")
    clip = f"{origin}/s/{token}/clip.gif"
    return f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>{e(title)} &middot; made in Inkling</title>
<meta name="description" content="A hand-drawn scene, animated with AI keyframes. Watch it, then see how it moves.">
<meta property="og:type" content="video.other">
<meta property="og:title" content="{e(title)} &middot; made in Inkling">
<meta property="og:description" content="{e(story['lead'])}">
<meta property="og:image" content="{origin}/s/{token}/poster.png">
<meta property="og:url" content="{origin}/s/{token}">
<meta name="twitter:card" content="summary_large_image">
<meta name="theme-color" content="#0b2422">
<style>
:root {{ color-scheme: light; --ink: #0b2422; --lime: #c3f192; --violet: #6d28d9; --paper: #f6f8f4; --muted: #4b5f5b; }}
* {{ box-sizing: border-box; }}
body {{ margin: 0; font: 16px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; color: var(--ink); background: var(--paper); }}
main {{ max-width: 760px; margin: 0 auto; padding: max(16px, env(safe-area-inset-top)) 16px 48px; }}
.brand {{ display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 14px; }}
.brand a {{ color: var(--ink); font-weight: 800; text-decoration: none; letter-spacing: -0.02em; font-size: 20px; }}
.brand a.cta {{ font-size: 15px; background: var(--ink); color: var(--lime); padding: 10px 16px; border-radius: 999px; }}
h1 {{ font-size: clamp(24px, 6vw, 34px); line-height: 1.15; margin: 6px 0 4px; letter-spacing: -0.02em; overflow-wrap: anywhere; }}
.clip {{ display: block; width: 100%; height: auto; border-radius: 18px; background: #fff; box-shadow: 0 10px 40px rgba(11, 36, 34, 0.15); }}
.direction {{ font-weight: 600; margin: 14px 0 4px; overflow-wrap: anywhere; }}
.cast, .muted {{ color: var(--muted); margin: 4px 0; }}
section {{ background: #fff; border-radius: 18px; padding: 18px; margin-top: 18px; box-shadow: 0 2px 10px rgba(11, 36, 34, 0.06); }}
h2 {{ font-size: 18px; margin: 0 0 8px; }}
ol.beats {{ list-style: none; padding: 0; margin: 12px 0 0; display: flex; flex-wrap: wrap; gap: 8px; }}
ol.beats li {{ background: var(--paper); border-radius: 12px; padding: 6px 10px; display: flex; flex-direction: column; }}
ol.beats li::before {{ content: "\\25C6"; color: var(--violet); font-size: 11px; }}
ol.beats small {{ color: var(--muted); }}
dl {{ margin: 0; display: grid; gap: 10px; }}
dt {{ font-weight: 700; text-transform: capitalize; }}
dd {{ margin: 0; color: var(--muted); }}
.actions {{ display: flex; flex-wrap: wrap; gap: 10px; margin-top: 14px; }}
.actions a {{ flex: 1 1 180px; text-align: center; padding: 12px 16px; border-radius: 999px; font-weight: 700; text-decoration: none; }}
.primary {{ background: var(--violet); color: #fff; }}
.ghost {{ background: #fff; color: var(--ink); border: 2px solid var(--ink); }}
footer {{ margin-top: 28px; color: var(--muted); font-size: 14px; text-align: center; }}
pre {{ margin: 12px 0 0; max-height: 340px; overflow: auto; background: var(--ink); color: #e6f4e0; border-radius: 12px; padding: 14px;
  font: 12.5px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; white-space: pre; tab-size: 2; }}
</style>
</head>
<body>
<main>
<div class="brand"><a href="{origin}/">&#9998; Inkling</a><a class="cta" href="{origin}/">Draw your own</a></div>
<h1>{e(title)}</h1>
<p class="muted">{e(share['code'])} &middot; {share['frames']} frames &middot; {share['frames'] / share['fps']:.1f} s</p>
<img class="clip" src="{clip}" width="{CLIP_WIDTH}" height="{round(CLIP_WIDTH * 0.65)}" alt="{e(title)}, animated">
{direction}
{cast_line}
<div class="actions"><a class="primary" href="{origin}/">&#9998; Make one like it</a><a class="ghost" href="{clip}" download="{e(share['code'])}.gif">&#11015; Download GIF</a></div>
<section>
<h2>&#9670; How it moves</h2>
<p>{e(story['lead'])}</p>
{f'<ol class="beats" aria-label="Keyframes">{beats}</ol>' if beats else ''}
</section>
{code_section}
{f'<section><h2>The animation principles in it</h2><dl>{principles}</dl></section>' if principles else ''}
<section>
<h2>Keep the pencil. Hand AI the in-betweens.</h2>
<p class="muted">Every line here was drawn by hand. AI picked the poses, math drew the frames between them, and the artist could change any of it. Nothing was redrawn.</p>
</section>
<footer>Made in Inkling &middot; MongoDB Atlas &middot; Voyage AI &middot; Gemini</footer>
</main>
</body>
</html>
"""
