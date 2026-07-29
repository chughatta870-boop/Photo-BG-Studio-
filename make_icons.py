from PIL import Image, ImageDraw, ImageFont
import os

OUT = os.path.dirname(os.path.abspath(__file__))
SIZES = [72, 96, 128, 144, 152, 192, 384, 512]

def get_font(size):
    candidates = [
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    ]
    for c in candidates:
        if os.path.exists(c):
            return ImageFont.truetype(c, size)
    return ImageFont.load_default()

def base_icon(size, padding_ratio=0.0):
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    pad = int(size * padding_ratio)

    # rounded square background gradient (indigo -> cyan)
    for y in range(size):
        t = y / size
        r = int(99 + (34 - 99) * t)
        g = int(102 + (211 - 102) * t)
        b = int(241 + (238 - 241) * t)
        d.line([(0, y), (size, y)], fill=(r, g, b, 255))

    mask = Image.new("L", (size, size), 0)
    md = ImageDraw.Draw(mask)
    radius = int(size * 0.22)
    md.rounded_rectangle([pad, pad, size - pad, size - pad], radius=radius, fill=255)
    rounded = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    rounded.paste(img, (0, 0), mask)
    img = rounded
    d = ImageDraw.Draw(img)

    # simple camera/frame glyph
    cx, cy = size / 2, size * 0.46
    fw, fh = size * 0.5, size * 0.36
    lens_r = size * 0.13
    d.rounded_rectangle(
        [cx - fw / 2, cy - fh / 2, cx + fw / 2, cy + fh / 2],
        radius=int(size * 0.06),
        outline=(255, 255, 255, 255),
        width=max(2, int(size * 0.025))
    )
    d.ellipse(
        [cx - lens_r, cy - lens_r, cx + lens_r, cy + lens_r],
        outline=(255, 255, 255, 255),
        width=max(2, int(size * 0.025))
    )
    d.ellipse(
        [cx - lens_r * 0.4, cy - lens_r * 0.4, cx + lens_r * 0.4, cy + lens_r * 0.4],
        fill=(255, 255, 255, 230)
    )

    # watermark text
    if size >= 96:
        font_main = get_font(max(8, int(size * 0.085)))
        text = "M Ijaz"
        bbox = d.textbbox((0, 0), text, font=font_main)
        tw = bbox[2] - bbox[0]
        d.text((size / 2 - tw / 2, size * 0.72), text, font=font_main, fill=(255, 255, 255, 255))
        if size >= 144:
            font_sub = get_font(max(6, int(size * 0.05)))
            sub = "GHS 124/NB"
            bbox2 = d.textbbox((0, 0), sub, font=font_sub)
            sw = bbox2[2] - bbox2[0]
            d.text((size / 2 - sw / 2, size * 0.85), sub, font=font_sub, fill=(230, 230, 255, 230))

    return img

def maskable_icon(size):
    # maskable needs extra safe-zone padding (icon content inside ~80% center)
    img = Image.new("RGBA", (size, size), (15, 23, 42, 255))
    inner = base_icon(int(size * 0.7), padding_ratio=0.0)
    inner = inner.resize((int(size * 0.7), int(size * 0.7)))
    offset = ((size - inner.width) // 2, (size - inner.height) // 2)
    img.paste(inner, offset, inner)
    return img.convert("RGBA")

for s in SIZES:
    icon = base_icon(s)
    icon.save(os.path.join(OUT, f"icon-{s}.png"))

for s in [192, 512]:
    m = maskable_icon(s)
    m.save(os.path.join(OUT, f"icon-maskable-{s}.png"))

print("Icons generated:", os.listdir(OUT))
