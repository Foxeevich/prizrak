#!/usr/bin/env python3
"""Собрать иконку приложения (призрак) из присланной картинки:
убрать светлый фон, положить призрака на тёмный скруглённый тайл,
экспортировать PNG 1024, ICO (мульти-размер), ICNS и icon-256."""
import sys, math
from PIL import Image, ImageDraw, ImageFilter

SRC = sys.argv[1]
OUT = sys.argv[2]  # каталог build

# 1. Загрузка + апскейл до рабочего размера с гладкой интерполяцией.
im = Image.open(SRC).convert('RGB')
work = 900
scale = work / max(im.size)
im = im.resize((round(im.size[0]*scale), round(im.size[1]*scale)), Image.LANCZOS)
W, H = im.size

# 2. Заливкой от четырёх углов помечаем светлый фон и делаем его прозрачным.
mark = (255, 0, 255)
flood = im.copy()
for corner in [(0, 0), (W-1, 0), (0, H-1), (W-1, H-1)]:
    ImageDraw.floodfill(flood, corner, mark, thresh=52)
px = flood.load()
alpha = Image.new('L', (W, H), 0)
ap = alpha.load()
for y in range(H):
    for x in range(W):
        ap[x, y] = 0 if px[x, y] == mark else 255
# сглаживаем край альфы, чтобы не было «пилы»
alpha = alpha.filter(ImageFilter.GaussianBlur(0.8))
ghost = im.convert('RGBA')
ghost.putalpha(alpha)

# 3. Обрезаем по призраку.
bbox = ghost.getbbox()
if bbox:
    ghost = ghost.crop(bbox)
gw, gh = ghost.size

# 4. Тёмный скруглённый тайл с диагональным градиентом (фиолетовый → почти чёрный).
S = 1024
tile = Image.new('RGBA', (S, S), (0, 0, 0, 0))
grad = Image.new('RGB', (S, S))
gp = grad.load()
c1 = (36, 26, 74)     # глубокий индиго-фиолет
c2 = (13, 14, 22)     # почти чёрный (фон приложения)
for y in range(S):
    for x in range(S):
        t = (x + y) / (2 * (S - 1))
        gp[x, y] = (
            round(c1[0] + (c2[0]-c1[0])*t),
            round(c1[1] + (c2[1]-c1[1])*t),
            round(c1[2] + (c2[2]-c1[2])*t),
        )
grad = grad.convert('RGBA')
# маска со скруглением (squircle-подобное — большой радиус)
mask = Image.new('L', (S, S), 0)
md = ImageDraw.Draw(mask)
r = round(S * 0.235)
md.rounded_rectangle([0, 0, S-1, S-1], radius=r, fill=255)
tile.paste(grad, (0, 0), mask)

# 5. Призрак по центру с полями + мягкая тень.
pad = round(S * 0.16)
avail = S - pad*2
k = min(avail/gw, avail/gh)
ng = (round(gw*k), round(gh*k))
ghost_r = ghost.resize(ng, Image.LANCZOS)
gx = (S - ng[0]) // 2
gy = (S - ng[1]) // 2

shadow = Image.new('RGBA', (S, S), (0, 0, 0, 0))
sh = Image.new('RGBA', (S, S), (0, 0, 0, 0))
sh.paste((0, 0, 0, 150), (gx, gy+round(S*0.02)), ghost_r)
sh = sh.filter(ImageFilter.GaussianBlur(round(S*0.02)))
tile = Image.alpha_composite(tile, sh)
tile.paste(ghost_r, (gx, gy), ghost_r)
# держим прозрачные углы тайла
tile.putalpha(Image.composite(tile.getchannel('A'), Image.new('L', (S, S), 0), mask))

# 6. Экспорт.
tile.save(f'{OUT}/icon.png')
tile.resize((256, 256), Image.LANCZOS).save(f'{OUT}/icon-256.png')
sizes = [16, 24, 32, 48, 64, 128, 256]
tile.save(f'{OUT}/icon.ico', sizes=[(s, s) for s in sizes])
try:
    tile.save(f'{OUT}/icon.icns')
except Exception as e:
    print('icns skip:', e)
print('icon written', tile.size)
