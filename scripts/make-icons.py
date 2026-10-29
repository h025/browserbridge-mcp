# 生成扩展图标：彩色渐变圆角方块 + 白色指针。需要 Pillow：python3 scripts/make-icons.py
# 颜色与 offscreen.js 里的 GIF 水印、indicator.js 的渐变保持一致
from pathlib import Path
from PIL import Image, ImageDraw

STOPS = [(0.0, (59, 130, 246)), (0.35, (139, 92, 246)), (0.7, (236, 72, 153)), (1.0, (245, 158, 11))]
POINTER = [(0.30, 0.22), (0.30, 0.78), (0.44, 0.65), (0.54, 0.84), (0.63, 0.80), (0.53, 0.61), (0.72, 0.61)]
OUT = Path(__file__).resolve().parent.parent / 'extension' / 'icons'


def color_at(t):
    for (t0, c0), (t1, c1) in zip(STOPS, STOPS[1:]):
        if t <= t1:
            k = (t - t0) / (t1 - t0)
            return tuple(round(a + (b - a) * k) for a, b in zip(c0, c1))
    return STOPS[-1][1]


def icon(size):
    big = size * 8
    grad = Image.new('RGBA', (big, big))
    px = grad.load()
    for y in range(big):
        for x in range(big):
            px[x, y] = (*color_at((x + y) / (2 * (big - 1))), 255)
    mask = Image.new('L', (big, big), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, big - 1, big - 1), radius=round(big * 0.22), fill=255)
    img = Image.new('RGBA', (big, big), (0, 0, 0, 0))
    img.paste(grad, (0, 0), mask)
    ImageDraw.Draw(img).polygon([(x * big, y * big) for x, y in POINTER], fill=(255, 255, 255, 245))
    return img.resize((size, size), Image.LANCZOS)


for s in (16, 32, 48, 128):
    icon(s).save(OUT / f'icon-{s}.png')
    print(f'icon-{s}.png')
