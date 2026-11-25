"""Build og.png, the 1200x630 link-preview card, from the current phone screenshots.

    python docs/make_social_card.py      # after docs/capture_screenshots.py

Fonts: Georgia and SF on macOS; elsewhere it falls back to Pillow's default font (uglier, still valid).
"""

from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = Path(__file__).resolve().parent.parent
SHOTS = ROOT / "docs" / "screenshots"
W, H = 1200, 630
INK, MUTED, LIME = (233, 242, 236), (143, 179, 168), (195, 241, 146)


def font(names: list[str], size: int) -> ImageFont.ImageFont:
    for name in names:
        for folder in ("/System/Library/Fonts/Supplemental", "/System/Library/Fonts", "/usr/share/fonts/truetype/dejavu"):
            path = Path(folder) / name
            if path.exists():
                return ImageFont.truetype(str(path), size)
    return ImageFont.load_default(size)


def fit(draw: ImageDraw.ImageDraw, text: str, names: list[str], size: int, width: int) -> ImageFont.ImageFont:
    face = font(names, size)
    while draw.textlength(text, font=face) > width and size > 20:
        size -= 2
        face = font(names, size)
    return face


def phone(path: Path, height: int) -> Image.Image:
    shot = Image.open(path).convert("RGB")
    shot = shot.resize((round(shot.width * height / shot.height), height), Image.LANCZOS)
    mask = Image.new("L", shot.size, 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, *shot.size), radius=26, fill=255)
    card = Image.new("RGBA", shot.size)
    card.paste(shot, mask=mask)
    return card


def brand_mark(draw: ImageDraw.ImageDraw, x: float, y: float, k: float) -> None:
    """The ink drop and its spark, from the app's 32x32 SVG logo."""
    P = lambda px, py: (x + px * k, y + py * k)  # noqa: E731
    draw.polygon([P(14, 4), P(6.4, 17), P(21.6, 17)], fill=INK)
    draw.ellipse([P(6, 11.5), P(22, 27.5)], fill=INK)
    draw.polygon([P(25, 3), P(26.3, 6.2), P(29.5, 7.5), P(26.3, 8.8), P(25, 12), P(23.7, 8.8), P(20.5, 7.5), P(23.7, 6.2)], fill=LIME)


def main() -> None:
    card = Image.new("RGB", (W, H))
    top, bottom = (22, 78, 71), (7, 26, 25)
    for y in range(H):  # a soft vertical gradient, like the sign-in screen
        t = y / H
        ImageDraw.Draw(card).line([(0, y), (W, y)], fill=tuple(round(a + (b - a) * t) for a, b in zip(top, bottom)))

    shadow = Image.new("RGBA", (W, H))
    shade = ImageDraw.Draw(shadow)
    back, front = phone(SHOTS / "01-sign-in-phone.png", 500), phone(SHOTS / "13-shared-scene-phone.png", 520)
    spots = [(back, (712, 78)), (front, (930, 58))]
    for image, (x, y) in spots:
        shade.rounded_rectangle((x + 8, y + 18, x + image.width + 8, y + image.height + 18), radius=26, fill=(0, 0, 0, 140))
    card.paste(shadow.filter(ImageFilter.GaussianBlur(18)), mask=shadow.filter(ImageFilter.GaussianBlur(18)))
    for image, (x, y) in spots:
        card.paste(image, (x, y), image)

    draw = ImageDraw.Draw(card)
    serif, sans = ["Georgia Bold.ttf", "DejaVuSerif-Bold.ttf"], ["SFNS.ttf", "HelveticaNeue.ttc", "DejaVuSans.ttf"]
    left, width = 72, 600
    brand_mark(draw, left, 68, 1.6)
    draw.text((left + 58, 70), "inkling", font=font(serif, 40), fill=INK)
    head = fit(draw, "Hand AI the in-betweens.", serif, 66, width)
    draw.text((left, 180), "Keep the pencil.", font=head, fill=INK)
    draw.text((left, 180 + head.size + 8), "Hand AI the in-betweens.", font=head, fill=MUTED)
    body = font(sans, 30)
    y = 180 + 2 * head.size + 48
    for line in ("Choreography, not replacement.", "Every stroke has an author."):
        draw.text((left, y), line, font=body, fill=LIME)
        y += 42
    draw.text((left, H - 78), "Your sketchbook, remembered: find art by sketch or words.", font=font(sans, 22), fill=MUTED)
    draw.text((left, H - 46), "MongoDB Atlas \u00b7 Voyage AI \u00b7 Gemini", font=font(sans, 20), fill=MUTED)
    out = ROOT / "og.png"
    card.save(out, optimize=True)
    print(f"{out} ({out.stat().st_size // 1024} KB)")


if __name__ == "__main__":
    main()
