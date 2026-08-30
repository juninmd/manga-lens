"""
Gera recortes sinteticos estilo balao de manga em japones, para comparar
Tesseract (jpn/jpn_vert, motor atual) contra manga-ocr (kha-white) — manga-ocr
so' reconhece japones, entao nao da' pra usar as paginas reais em ingles do
Naruto para essa comparacao. Fonte: MS Gothic (ja vem no Windows).
"""
from PIL import Image, ImageDraw, ImageFont
import json, os

base = os.path.dirname(__file__)
out = os.path.join(base, "crops-jp")
os.makedirs(out, exist_ok=True)

FONT = "C:/Windows/Fonts/msgothic.ttc"

# (id, texto, vertical?, fundo texturizado?)
ITEMS = [
    ("jp1-horizontal-clean", "おはようございます", False, False),
    ("jp2-horizontal-clean", "これは本当ですか", False, False),
    ("jp3-horizontal-textured", "ナルトは強い忍者だ", False, True),
    ("jp4-vertical-clean", "静かにしろ", True, False),
    ("jp5-vertical-textured", "助けてくれ", True, True),
    ("jp6-horizontal-clean", "火影様お許しください", False, False),
]

def textured_bg(w, h):
    import random
    img = Image.new("L", (w, h), 235)
    px = img.load()
    random.seed(42)
    for y in range(h):
        for x in range(w):
            px[x, y] = 210 + random.randint(-15, 15)
    return img.convert("RGB")

manifest = {}
for name, text, vertical, textured in ITEMS:
    size = 42
    font = ImageFont.truetype(FONT, size)
    if vertical:
        w, h = 90, 60 + size * len(text)
        img = textured_bg(w, h) if textured else Image.new("RGB", (w, h), "white")
        d = ImageDraw.Draw(img)
        y = 20
        for ch in text:
            d.text((20, y), ch, font=font, fill="black")
            y += size
    else:
        w, h = 40 + size * len(text), size + 50
        img = textured_bg(w, h) if textured else Image.new("RGB", (w, h), "white")
        d = ImageDraw.Draw(img)
        d.text((20, 20), text, font=font, fill="black")
    path = os.path.join(out, f"{name}.png")
    img.save(path)
    manifest[name] = text

with open(os.path.join(base, "ocr-ground-truth-jp.json"), "w", encoding="utf-8") as f:
    json.dump(
        {
            "lang": "jpn",
            "source": "sintetico (MS Gothic) — manga-ocr so' reconhece japones, sem raw JP a mao nesta rodada",
            "items": manifest,
        },
        f,
        ensure_ascii=False,
        indent=2,
    )

print(f"{len(manifest)} recortes sinteticos em {out}")
