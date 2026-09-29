"""
Build the talking head from the drawings in .tmp/portrait/ (see gen.sh):
cut her out, then cut each mouth and the blink into a small feathered patch
that sits exactly over the portrait, and write them to public/aida/.

    python3 -m venv .tmp/venv && .tmp/venv/bin/pip install pillow numpy "rembg[cpu]"
    .tmp/venv/bin/python scripts/portrait/build.py

Every edit redraws the whole picture a little (the grain and texture move),
so whole frames would shimmer when swapped. Only what changed near the mouth
(or the eyes) is kept, tone-matched to the portrait, with a soft edge.
"""
import json
import os
import numpy as np
from PIL import Image, ImageFilter
from rembg import new_session, remove

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, '..', '..', '.tmp', 'portrait') + os.sep
OUT = os.path.join(HERE, '..', '..', 'public', 'aida') + os.sep
QA = SRC

B = np.asarray(Image.open(SRC + 'base.png').convert('RGB')).astype(np.float32)
cut = remove(Image.open(SRC + 'base.png').convert('RGB'), session=new_session('isnet-anime')).convert('RGBA')
H, W = B.shape[:2]

def patch(variant_file, box, thresh, grow, feather, cover_lines=True):
    V = np.asarray(Image.open(SRC + variant_file).convert('RGB')).astype(np.float32)
    x0, y0, x1, y1 = box
    b = B[y0:y1, x0:x1]; v = V[y0:y1, x0:x1]
    d = np.abs(v - b).sum(2)
    lum_b = b.mean(2)
    m = (d > thresh) | ((lum_b < 150) & cover_lines)   # what changed, plus (for the mouth) the base line work
    mi = Image.fromarray((m * 255).astype(np.uint8))
    mi = mi.filter(ImageFilter.MinFilter(3)).filter(ImageFilter.MaxFilter(3))   # drop grain speckle
    mi = mi.filter(ImageFilter.MaxFilter(grow)).filter(ImageFilter.GaussianBlur(feather))
    a = np.asarray(mi).astype(np.float32) / 255
    # Match the skin tone: shift the variant by the mean difference where the two agree (the ring).
    ring = (a > 0.05) & (a < 0.6) & (d < 60)
    shift = (b[ring] - v[ring]).mean(0) if ring.sum() > 50 else np.zeros(3)
    v2 = np.clip(v + shift * 0.9, 0, 255)
    # Fade alpha to zero at the crop edge so no hard line can show.
    edge = np.ones_like(a); k = 6
    edge[:k] *= np.linspace(0, 1, k)[:, None]; edge[-k:] *= np.linspace(1, 0, k)[:, None]
    edge[:, :k] *= np.linspace(0, 1, k)[None]; edge[:, -k:] *= np.linspace(1, 0, k)[None]
    alpha = (a * edge * 255).astype(np.uint8)
    rgba = np.dstack([v2.astype(np.uint8), alpha])
    return Image.fromarray(rgba, 'RGBA'), shift

MOUTH = (425, 445, 610, 600)
EYES = (330, 300, 700, 440)
shapes = {name: name + '.png' for name in ['small', 'mid', 'wide', 'round', 'pucker']}
meta = {'size': [W, H], 'mouth': MOUTH, 'eyes': EYES, 'shift': {}}
patches = {}
for name, f in shapes.items():
    p, s = patch(f, MOUTH, 70, 17, 5); patches[name] = p; meta['shift'][name] = [round(float(x), 1) for x in s]
    p.save(f'{OUT}mouth-{name}.webp', quality=88, method=6)
p, s = patch('blink.png', EYES, 80, 13, 5, cover_lines=False); patches['blink'] = p; meta['shift']['blink'] = [round(float(x), 1) for x in s]
p.save(OUT + 'blink.webp', quality=88, method=6)

# The figure: tidy the bottom corners the matte left soft, and export at two sizes.
ca = np.asarray(cut).copy()
HEM = 983                                   # the jacket's bottom line; below it the matte kept paper
ca[HEM:, :, 3] = 0
ca[880:HEM, :, 3] = np.where(ca[880:HEM, :, 3] > 230, ca[880:HEM, :, 3], 0)   # soft corner fringe
fig = Image.fromarray(ca, 'RGBA')
fig.save(OUT + 'aida.webp', quality=84, method=6)
fig.resize((640, 640), Image.LANCZOS).save(OUT + 'aida-640.webp', quality=84, method=6)

# QA: every frame composited, at display size, on the page colour.
tiles = []
for name in ['closed', 'small', 'mid', 'wide', 'round', 'pucker', 'blink']:
    f = fig.copy()
    if name in patches:
        box = EYES if name == 'blink' else MOUTH
        f.alpha_composite(patches[name], (box[0], box[1]))
    bg = Image.new('RGBA', f.size, (241, 232, 212, 255)); bg.alpha_composite(f)
    tiles.append(bg.crop((300, 250, 724, 650)).convert('RGB'))
sheet = Image.new('RGB', (424 * 7, 400)); [sheet.paste(t, (i * 424, 0)) for i, t in enumerate(tiles)]
sheet.save(QA + 'qa-frames.jpg', quality=88)   # look at this before shipping
print(json.dumps(meta))
