from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont


ROOT = Path(__file__).resolve().parents[1]
ASSETS = ROOT / "assets"
BG = (248, 244, 238, 255)
NAVY = (16, 50, 74, 255)
BLUE = (24, 75, 109, 255)
ORANGE = (255, 122, 89, 255)
GOLD = (245, 183, 0, 255)
PAPER = (255, 248, 238, 255)
PAPER_FOLD = (255, 217, 190, 255)
MUTED = (72, 101, 120, 255)
LIGHT = (255, 216, 199, 255)
WHITE = (253, 253, 253, 255)
DARK_BG = (10, 18, 28, 255)
DARK_PANEL = (17, 31, 47, 255)
DARK_MUTED = (145, 170, 191, 255)
CYAN = (83, 203, 255, 255)


def load_font(size: int, bold: bool = False) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    candidates = []
    if bold:
        candidates.extend(
            [
                "C:/Windows/Fonts/segoeuib.ttf",
                "C:/Windows/Fonts/arialbd.ttf",
                "C:/Windows/Fonts/calibrib.ttf",
            ]
        )
    else:
        candidates.extend(
            [
                "C:/Windows/Fonts/segoeui.ttf",
                "C:/Windows/Fonts/arial.ttf",
                "C:/Windows/Fonts/calibri.ttf",
            ]
        )

    for candidate in candidates:
        path = Path(candidate)
        if path.exists():
            return ImageFont.truetype(str(path), size=size)

    return ImageFont.load_default()


def rounded_gradient(
    size: tuple[int, int],
    start: tuple[int, int, int],
    end: tuple[int, int, int],
    radius: int,
) -> Image.Image:
    width, height = size
    gradient = Image.new("RGBA", size)
    pixels = gradient.load()

    for y in range(height):
        for x in range(width):
            t = (x + y) / max(width + height - 2, 1)
            pixels[x, y] = (
                round(start[0] + (end[0] - start[0]) * t),
                round(start[1] + (end[1] - start[1]) * t),
                round(start[2] + (end[2] - start[2]) * t),
                255,
            )

    mask = Image.new("L", size, 0)
    mask_draw = ImageDraw.Draw(mask)
    mask_draw.rounded_rectangle((0, 0, width, height), radius=radius, fill=255)
    gradient.putalpha(mask)
    return gradient


def add_shadow(
    size: tuple[int, int],
    box: tuple[int, int, int, int],
    radius: int,
    blur: int,
    color: tuple[int, int, int, int],
) -> Image.Image:
    shadow = Image.new("RGBA", size, (0, 0, 0, 0))
    shadow_draw = ImageDraw.Draw(shadow)
    shadow_draw.rounded_rectangle(box, radius=radius, fill=color)
    return shadow.filter(ImageFilter.GaussianBlur(blur))


def draw_document(base: Image.Image, box: tuple[int, int, int, int], scale: float = 1.0) -> None:
    draw = ImageDraw.Draw(base)
    x1, y1, x2, y2 = box
    fold = round(36 * scale)
    line_h = max(round(14 * scale), 4)
    radius = max(round(18 * scale), 6)

    draw.rounded_rectangle(box, radius=radius, fill=PAPER)
    draw.polygon([(x2 - fold, y1), (x2, y1 + fold), (x2 - fold, y1 + fold)], fill=PAPER_FOLD)
    draw.rectangle((x2 - fold - 1, y1, x2 - fold + 1, y1 + fold), fill=PAPER)

    draw.rounded_rectangle((x1 + round(22 * scale), y1 + round(44 * scale), x1 + round(98 * scale), y1 + round(44 * scale) + line_h), radius=line_h // 2, fill=ORANGE)
    draw.rounded_rectangle((x1 + round(22 * scale), y1 + round(74 * scale), x1 + round(128 * scale), y1 + round(74 * scale) + line_h), radius=line_h // 2, fill=LIGHT)
    draw.rounded_rectangle((x1 + round(22 * scale), y1 + round(104 * scale), x1 + round(110 * scale), y1 + round(104 * scale) + line_h), radius=line_h // 2, fill=LIGHT)
    draw.rounded_rectangle((x1 + round(22 * scale), y1 + round(134 * scale), x1 + round(82 * scale), y1 + round(134 * scale) + line_h), radius=line_h // 2, fill=LIGHT)


def draw_magnifier(base: Image.Image, center: tuple[int, int], radius: int, handle: int | None = None) -> None:
    draw = ImageDraw.Draw(base)
    cx, cy = center
    outer = (cx - radius, cy - radius, cx + radius, cy + radius)
    inner_gap = max(radius // 4, 8)
    inner = (cx - radius + inner_gap, cy - radius + inner_gap, cx + radius - inner_gap, cy + radius - inner_gap)
    handle_len = handle or round(radius * 0.9)
    handle_width = max(radius // 3, 8)

    draw.ellipse(outer, fill=WHITE)
    draw.ellipse(inner, fill=BLUE)
    draw.line(
        (cx + radius - inner_gap, cy + radius - inner_gap + 2, cx + radius - inner_gap + handle_len, cy + radius - inner_gap + handle_len),
        fill=NAVY,
        width=handle_width,
    )

    check = [(cx - round(radius * 0.38), cy + round(radius * 0.02)), (cx - round(radius * 0.12), cy + round(radius * 0.3)), (cx + round(radius * 0.36), cy - round(radius * 0.24))]
    draw.line(check, fill=PAPER, width=max(radius // 5, 4), joint="curve")


def draw_stars(base: Image.Image, points: list[tuple[int, int, int]]) -> None:
    draw = ImageDraw.Draw(base)
    for x, y, r in points:
        draw.regular_polygon((x, y, r), 4, rotation=45, fill=NAVY)


def draw_chip(base: Image.Image, xy: tuple[int, int], text: str, fill: tuple[int, int, int, int], text_fill: tuple[int, int, int, int]) -> None:
    draw = ImageDraw.Draw(base)
    font = load_font(28, bold=True)
    bbox = draw.textbbox((0, 0), text, font=font)
    width = bbox[2] - bbox[0] + 36
    height = bbox[3] - bbox[1] + 18
    x, y = xy
    draw.rounded_rectangle((x, y, x + width, y + height), radius=height // 2, fill=fill)
    draw.text((x + 18, y + 8), text, font=font, fill=text_fill)


def draw_outline_chip(
    base: Image.Image,
    xy: tuple[int, int],
    text: str,
    outline: tuple[int, int, int, int],
    text_fill: tuple[int, int, int, int],
    fill: tuple[int, int, int, int] = (0, 0, 0, 0),
) -> None:
    draw = ImageDraw.Draw(base)
    font = load_font(28, bold=True)
    bbox = draw.textbbox((0, 0), text, font=font)
    width = bbox[2] - bbox[0] + 36
    height = bbox[3] - bbox[1] + 18
    x, y = xy
    draw.rounded_rectangle((x, y, x + width, y + height), radius=height // 2, fill=fill, outline=outline, width=3)
    draw.text((x + 18, y + 8), text, font=font, fill=text_fill)


def make_wordmark(
    image: Image.Image,
    origin: tuple[int, int],
    title_size: int,
    subtitle_size: int,
    tagline: str,
) -> None:
    draw = ImageDraw.Draw(image)
    title_font = load_font(title_size, bold=True)
    subtitle_font = load_font(subtitle_size, bold=True)
    x, y = origin
    draw.text((x, y), "CI Failure", font=title_font, fill=NAVY)
    draw.text((x, y + round(title_size * 1.02)), "Explainer", font=title_font, fill=ORANGE)
    draw.text((x + 4, y + round(title_size * 2.1)), tagline, font=subtitle_font, fill=MUTED)


def make_logo() -> None:
    image = Image.new("RGBA", (1200, 320), BG)
    shadow = add_shadow(image.size, (44, 36, 280, 272), 52, 10, (16, 50, 74, 45))
    image = Image.alpha_composite(shadow, image)
    panel = rounded_gradient((236, 236), ORANGE[:3], GOLD[:3], 52)
    image.alpha_composite(panel, (44, 28))

    draw_document(image, (103, 65, 220, 216))
    draw_magnifier(image, (224, 179), 40)
    draw_stars(image, [(278, 70, 14), (314, 244, 11)])
    make_wordmark(image, (350, 70), 74, 26, "AI explanations for broken GitHub Actions runs in seconds")

    image.save(ASSETS / "logo.png", format="PNG")


def make_icon() -> None:
    image = Image.new("RGBA", (512, 512), BG)
    shadow = add_shadow(image.size, (44, 56, 468, 480), 96, 18, (16, 50, 74, 48))
    image = Image.alpha_composite(shadow, image)
    panel = rounded_gradient((424, 424), ORANGE[:3], GOLD[:3], 96)
    image.alpha_composite(panel, (44, 44))

    draw_document(image, (132, 118, 340, 374), 1.0)
    draw_magnifier(image, (325, 290), 56, handle=48)
    draw_stars(image, [(120, 124, 16), (394, 118, 14)])

    image.save(ASSETS / "logo-icon.png", format="PNG")
    image.resize((64, 64), Image.LANCZOS).save(ASSETS / "favicon.png", format="PNG")
    image.resize((32, 32), Image.LANCZOS).save(ASSETS / "favicon-32.png", format="PNG")
    image.resize((16, 16), Image.LANCZOS).save(ASSETS / "favicon-16.png", format="PNG")
    image.save(ASSETS / "favicon.ico", format="ICO", sizes=[(16, 16), (32, 32), (48, 48), (64, 64)])


def make_social_preview() -> None:
    image = Image.new("RGBA", (1280, 640), BG)
    draw = ImageDraw.Draw(image)

    left_panel_shadow = add_shadow(image.size, (72, 92, 454, 548), 72, 20, (16, 50, 74, 40))
    image = Image.alpha_composite(left_panel_shadow, image)
    left_panel = rounded_gradient((382, 456), ORANGE[:3], GOLD[:3], 72)
    image.alpha_composite(left_panel, (72, 80))

    draw_document(image, (148, 166, 328, 388), 1.15)
    draw_magnifier(image, (334, 320), 60, handle=56)
    draw_stars(image, [(380, 142, 15), (420, 476, 12)])

    glow = Image.new("RGBA", image.size, (0, 0, 0, 0))
    glow_draw = ImageDraw.Draw(glow)
    glow_draw.ellipse((938, 78, 1248, 388), fill=(255, 226, 180, 95))
    glow = glow.filter(ImageFilter.GaussianBlur(36))
    image = Image.alpha_composite(image, glow)

    make_wordmark(image, (510, 128), 90, 30, "AI explanations for broken GitHub Actions runs in seconds")

    hero_font = load_font(34, bold=True)
    draw.text((514, 338), "Short summary. Root cause. Fix steps. Confidence.", font=hero_font, fill=NAVY)
    draw.text((514, 392), "Built for pull requests, job summaries, and fast triage.", font=hero_font, fill=MUTED)

    draw_chip(image, (512, 474), "GitHub Actions", NAVY, PAPER)
    draw_chip(image, (746, 474), "OpenAI", ORANGE, PAPER)
    draw_chip(image, (894, 474), "PR Comments", (255, 233, 212, 255), NAVY)

    image.save(ASSETS / "social-preview.png", format="PNG")


def make_marketplace_banner() -> None:
    image = Image.new("RGBA", (1600, 480), BG)
    draw = ImageDraw.Draw(image)

    halo = Image.new("RGBA", image.size, (0, 0, 0, 0))
    halo_draw = ImageDraw.Draw(halo)
    halo_draw.ellipse((1110, -10, 1620, 500), fill=(255, 225, 186, 110))
    halo_draw.ellipse((-120, 200, 220, 540), fill=(255, 216, 199, 70))
    halo = halo.filter(ImageFilter.GaussianBlur(50))
    image = Image.alpha_composite(image, halo)

    card_shadow = add_shadow(image.size, (74, 82, 458, 438), 64, 18, (16, 50, 74, 42))
    image = Image.alpha_composite(card_shadow, image)
    card = rounded_gradient((384, 356), ORANGE[:3], GOLD[:3], 64)
    image.alpha_composite(card, (74, 64))

    draw_document(image, (148, 126, 336, 354), 1.08)
    draw_magnifier(image, (348, 282), 58, handle=54)
    draw_stars(image, [(410, 112, 16), (432, 380, 12), (112, 110, 12)])

    title_font = load_font(92, bold=True)
    sub_font = load_font(34, bold=True)
    body_font = load_font(28, bold=False)
    draw.text((520, 110), "CI Failure", font=title_font, fill=NAVY)
    draw.text((520, 208), "Explainer", font=title_font, fill=ORANGE)
    draw.text((525, 315), "AI explanations for broken GitHub Actions runs in seconds", font=sub_font, fill=MUTED)
    draw.text((525, 372), "Stop reading CI logs. Let AI explain the failure.", font=body_font, fill=NAVY)

    draw_chip(image, (1180, 108), "AI triage", NAVY, PAPER)
    draw_chip(image, (1180, 170), "Job logs", ORANGE, PAPER)
    draw_chip(image, (1180, 232), "PR comments", (255, 233, 212, 255), NAVY)

    image.save(ASSETS / "marketplace-banner.png", format="PNG")


def make_marketplace_banner_dark() -> None:
    image = Image.new("RGBA", (1600, 560), DARK_BG)

    haze = Image.new("RGBA", image.size, (0, 0, 0, 0))
    haze_draw = ImageDraw.Draw(haze)
    haze_draw.ellipse((-80, 300, 460, 760), fill=(255, 122, 89, 58))
    haze_draw.ellipse((1080, -120, 1640, 440), fill=(83, 203, 255, 62))
    haze_draw.ellipse((620, 90, 980, 450), fill=(245, 183, 0, 28))
    haze = haze.filter(ImageFilter.GaussianBlur(70))
    image = Image.alpha_composite(image, haze)

    grid = Image.new("RGBA", image.size, (0, 0, 0, 0))
    grid_draw = ImageDraw.Draw(grid)
    for x in range(0, 1600, 64):
        grid_draw.line((x, 0, x, 560), fill=(255, 255, 255, 10), width=1)
    for y in range(0, 560, 64):
        grid_draw.line((0, y, 1600, y), fill=(255, 255, 255, 10), width=1)
    image = Image.alpha_composite(image, grid)

    panel_shadow = add_shadow(image.size, (76, 110, 496, 490), 72, 24, (0, 0, 0, 90))
    image = Image.alpha_composite(image, panel_shadow)

    panel = Image.new("RGBA", (420, 380), DARK_PANEL)
    panel_draw = ImageDraw.Draw(panel)
    panel_draw.rounded_rectangle((0, 0, 420, 380), radius=72, fill=DARK_PANEL, outline=(255, 255, 255, 18), width=2)
    image.alpha_composite(panel, (76, 110))

    left_card = rounded_gradient((228, 228), ORANGE[:3], GOLD[:3], 54)
    image.alpha_composite(left_card, (128, 155))
    draw_document(image, (180, 206, 305, 367), 0.84)
    draw_magnifier(image, (319, 316), 44, handle=38)
    draw_stars(image, [(162, 184, 10), (400, 174, 12), (420, 414, 9)])

    draw = ImageDraw.Draw(image)
    title_font = load_font(96, bold=True)
    subtitle_font = load_font(34, bold=True)
    body_font = load_font(30, bold=False)
    kicker_font = load_font(24, bold=True)

    draw.text((574, 104), "CI Failure", font=title_font, fill=PAPER)
    draw.text((574, 205), "Explainer", font=title_font, fill=ORANGE)
    draw.text((578, 324), "AI explanations for broken GitHub Actions runs in seconds", font=subtitle_font, fill=DARK_MUTED)
    draw.text((578, 378), "Stop reading CI logs. Let AI explain the failure.", font=body_font, fill=PAPER)

    draw.rounded_rectangle((579, 446, 963, 492), radius=23, fill=(255, 255, 255, 10))
    draw.text((602, 456), "Focuses on the first failing step, not the noise.", font=kicker_font, fill=CYAN)

    draw_outline_chip(image, (1188, 124), "GitHub Actions", CYAN, CYAN)
    draw_outline_chip(image, (1188, 192), "AI triage", ORANGE, ORANGE)
    draw_outline_chip(image, (1188, 260), "PR comments", (255, 255, 255, 160), PAPER)
    draw_outline_chip(image, (1188, 328), "Job summary", (245, 183, 0, 200), (255, 230, 168, 255))

    waveform = Image.new("RGBA", image.size, (0, 0, 0, 0))
    wave_draw = ImageDraw.Draw(waveform)
    points = []
    start_x = 1090
    for i in range(0, 360, 18):
        x = start_x + i
        y = 448 - int((i % 72) * 0.55) if (i // 18) % 2 == 0 else 448 - int((72 - (i % 72)) * 0.55)
        points.append((x, y))
    if len(points) > 1:
        wave_draw.line(points, fill=(83, 203, 255, 180), width=4)
    waveform = waveform.filter(ImageFilter.GaussianBlur(1))
    image = Image.alpha_composite(image, waveform)

    image.save(ASSETS / "marketplace-banner-dark.png", format="PNG")


def main() -> None:
    ASSETS.mkdir(parents=True, exist_ok=True)
    make_logo()
    make_icon()
    make_social_preview()
    make_marketplace_banner()
    make_marketplace_banner_dark()


if __name__ == "__main__":
    main()
