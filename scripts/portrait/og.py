# The social preview: 1200x630, her on a pink sunburst, the hello stamped beside her.
import math, sys
from PIL import Image, ImageDraw, ImageFont, ImageFilter
fig_path, font_path, out = sys.argv[1:4]
W, H = 1200, 630
PAPER, INK, PINK, RAY = (241, 232, 212), (35, 44, 92), (236, 79, 147), (239, 106, 163)
im = Image.new("RGB", (W, H), PAPER)
d = ImageDraw.Draw(im)
cx, cy = 860, 300
for k in range(24):                       # 24 rays, 7.5 degrees each, like the page
    a0 = math.radians(k * 15); a1 = math.radians(k * 15 + 7.5); R = 1600
    d.polygon([(cx, cy), (cx + R * math.cos(a0), cy + R * math.sin(a0)), (cx + R * math.cos(a1), cy + R * math.sin(a1))], fill=RAY)
fig = Image.open(fig_path).convert("RGBA").resize((660, 660), Image.LANCZOS)
shadow = Image.new("RGBA", fig.size, INK + (0,)); shadow.putalpha(fig.getchannel("A").point(lambda v: int(v * 0.85)))
im.paste(shadow, (cx - 330 + 11, H - 660 + 36), shadow)
im.paste(fig, (cx - 330, H - 660 + 30), fig)
font = ImageFont.truetype(font_path, 150)
def stamp(text, x, y, fill, shade, size):
    f = ImageFont.truetype(font_path, size)
    d.text((x + size * 0.05, y + size * 0.05), text, font=f, fill=shade)
    d.text((x, y), text, font=f, fill=fill, stroke_width=max(2, size // 30), stroke_fill=INK)
stamp("HELLO.", 60, 70, PINK, INK, 170)
stamp("I’M AIDA.", 60, 265, INK, PINK, 150)
f = ImageFont.truetype(font_path, 44)
tag = Image.new("RGBA", (330, 80), (0, 0, 0, 0)); td = ImageDraw.Draw(tag)
td.rounded_rectangle((3, 3, 326, 76), radius=8, outline=PINK, width=5)
td.text((165, 40), "COMING SOON", font=f, fill=PINK, anchor="mm")
tag = tag.rotate(6, expand=True, resample=Image.BICUBIC)
im.paste(tag, (60, 470), tag)
im.save(out, optimize=True)
print(out, im.size)
