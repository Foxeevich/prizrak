#!/usr/bin/env python3
# Генерирует Android launcher-иконки Prizrak из packages/desktop/build/icon.png
# (1024×1024 плитка с призраком). Делает:
#   1) legacy ic_launcher / ic_launcher_round (PNG во всех плотностях) — Android <8;
#   2) АДАПТИВНУЮ иконку (Android 8+): mipmap-anydpi-v26/*.xml +
#      слои foreground (призрак, вырезанный из плитки) и background (градиент).
# Призрак вырезается из плитки аналитически: фон — известный диагональный
# градиент (36,26,74)→(13,14,22), альфа = отличие пикселя от градиента.
from PIL import Image, ImageDraw, ImageFilter
import os

SRC = 'packages/desktop/build/icon.png'
RES = 'packages/mobile/android/app/src/main/res'
SIZES = {'mdpi': 48, 'hdpi': 72, 'xhdpi': 96, 'xxhdpi': 144, 'xxxhdpi': 192}
ADAPTIVE = {'mdpi': 108, 'hdpi': 162, 'xhdpi': 216, 'xxhdpi': 324, 'xxxhdpi': 432}
C1, C2 = (36, 26, 74), (13, 14, 22)  # градиент плитки (из scripts/make-icon.py)

src = Image.open(SRC).convert('RGBA')
S = src.size[0]

# ── Вырезаем призрака из плитки ────────────────────────────────────────────
px = src.load()
ghost = Image.new('RGBA', (S, S), (0, 0, 0, 0))
gp = ghost.load()
for y in range(S):
    for x in range(S):
        r, g, b, a = px[x, y]
        if a == 0:
            continue
        t = (x + y) / (2 * (S - 1))
        er = C1[0] + (C2[0] - C1[0]) * t
        eg = C1[1] + (C2[1] - C1[1]) * t
        eb = C1[2] + (C2[2] - C1[2]) * t
        diff = max(abs(r - er), abs(g - eg), abs(b - eb))
        if diff > 18:  # не фон → призрак/тень/язык
            na = min(255, int((diff - 18) * 6))
            gp[x, y] = (r, g, b, min(a, na))
# лёгкое сглаживание альфы
alpha = ghost.split()[3].filter(ImageFilter.GaussianBlur(0.6))
ghost.putalpha(alpha)
bbox = ghost.getbbox()
ghost = ghost.crop(bbox)
gw, gh = ghost.size
print(f'призрак вырезан: {gw}×{gh}')

# ── Градиент-фон для adaptive background ───────────────────────────────────
def gradient(size):
    im = Image.new('RGB', (size, size))
    p = im.load()
    for y in range(size):
        for x in range(size):
            t = (x + y) / (2 * (size - 1))
            p[x, y] = (round(C1[0] + (C2[0] - C1[0]) * t),
                       round(C1[1] + (C2[1] - C1[1]) * t),
                       round(C1[2] + (C2[2] - C1[2]) * t))
    return im.convert('RGBA')

def round_icon(im, size):
    big = 4 * size
    tile = im.resize((big, big), Image.LANCZOS)
    mask = Image.new('L', (big, big), 0)
    d = ImageDraw.Draw(mask)
    d.ellipse((0, 0, big - 1, big - 1), fill=255)
    out = Image.new('RGBA', (big, big), (0, 0, 0, 0))
    out.paste(tile, (0, 0), mask)
    return out.resize((size, size), Image.LANCZOS)

for dpi, pxs in SIZES.items():
    d = os.path.join(RES, f'mipmap-{dpi}')
    os.makedirs(d, exist_ok=True)
    src.resize((pxs, pxs), Image.LANCZOS).save(os.path.join(d, 'ic_launcher.png'))
    round_icon(src, pxs).save(os.path.join(d, 'ic_launcher_round.png'))
    # adaptive-слои
    a = ADAPTIVE[dpi]
    # foreground: призрак в центре, ~52% канвы (безопасная зона 66%)
    fg = Image.new('RGBA', (a, a), (0, 0, 0, 0))
    avail = round(a * 0.52)
    k = min(avail / gw, avail / gh)
    ng = (max(1, round(gw * k)), max(1, round(gh * k)))
    gr = ghost.resize(ng, Image.LANCZOS)
    fg.paste(gr, ((a - ng[0]) // 2, (a - ng[1]) // 2), gr)
    fg.save(os.path.join(d, 'ic_launcher_foreground.png'))
    gradient(a).save(os.path.join(d, 'ic_launcher_background.png'))
    print(f'✅ mipmap-{dpi}: legacy {pxs}px + adaptive {a}px')

# ── anydpi-v26 XML (Android 8+ берёт именно их) ────────────────────────────
anydpi = os.path.join(RES, 'mipmap-anydpi-v26')
os.makedirs(anydpi, exist_ok=True)
XML = '''<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@mipmap/ic_launcher_background"/>
    <foreground android:drawable="@mipmap/ic_launcher_foreground"/>
</adaptive-icon>
'''
for name in ('ic_launcher.xml', 'ic_launcher_round.xml'):
    with open(os.path.join(anydpi, name), 'w') as f:
        f.write(XML)
print('✅ mipmap-anydpi-v26: адаптивные XML созданы')
print('Готово.')
