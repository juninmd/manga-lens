"""
Prova visual do passo 2 do plano (issue #5): antes/depois do apagamento por
difusao no caso que hoje e' descartado (texto solto sobre arte, sem balao).
Replica o mesmo algoritmo de `diffusePixels` (src/client/ocr.ts) em Python
so' para gerar a imagem de evidencia — a logica testada de verdade e' a do
TypeScript (tests/ocr-inpaint.test.ts), isto aqui e' so' visualizacao.
"""
from PIL import Image
import os

base = os.path.dirname(__file__)
pages = os.path.join(base, "benchmark-pages")

img = Image.open(os.path.join(pages, "page-10.jpg")).convert("RGB")
# bbox do texto "LOOOOSERS!! WANNA-BE'S!" (sem balao, direto sobre a arte)
box = (800, 215, 1060, 360)
margin = 12
sx, sy = box[0] - margin, box[1] - margin
ex, ey = box[2] + margin, box[3] + margin
region = img.crop((sx, sy, ex, ey))
w, h = region.size
px = region.load()

pad_x, pad_y = margin, margin
hole_w, hole_h = box[2] - box[0], box[3] - box[1]

unknown = [[False] * w for _ in range(h)]
for y in range(h):
    for x in range(w):
        if pad_x <= x < pad_x + hole_w and pad_y <= y < pad_y + hole_h:
            unknown[y][x] = True

data = [[list(px[x, y]) for x in range(w)] for y in range(h)]
before = region.copy()

for it in range(16):
    snapshot = [row[:] for row in data]
    for y in range(h):
        for x in range(w):
            if not unknown[y][x]:
                continue
            n, r, g, b = 0, 0, 0, 0
            for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                nx, ny = x + dx, y + dy
                if 0 <= nx < w and 0 <= ny < h:
                    n += 1
                    r += snapshot[ny][nx][0]
                    g += snapshot[ny][nx][1]
                    b += snapshot[ny][nx][2]
            if n:
                data[y][x] = [round(r / n), round(g / n), round(b / n)]

after = Image.new("RGB", (w, h))
apx = after.load()
for y in range(h):
    for x in range(w):
        apx[x, y] = tuple(data[y][x])

combo = Image.new("RGB", (w, h * 2 + 10), "red")
combo.paste(before, (0, 0))
combo.paste(after, (0, h + 10))
combo.save(os.path.join(base, "inpaint-before-after.png"))
print("salvo em inpaint-before-after.png (topo=antes, baixo=depois)")
