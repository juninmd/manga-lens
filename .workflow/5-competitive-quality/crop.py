from PIL import Image
import json, os

base = os.path.dirname(__file__)
pages = os.path.join(base, "benchmark-pages")
out = os.path.join(base, "crops")
os.makedirs(out, exist_ok=True)

# box: [left, top, right, bottom] in source pixel coords (source is 1066x1600)
CROPS = {
    "p9-hokage-yes":   ("page-9.jpg",  [10, 120, 300, 430]),
    "p9-lordhokage":   ("page-9.jpg",  [780, 120, 1066, 330]),
    "p9-graffiti":     ("page-9.jpg",  [770, 470, 1066, 840]),
    "p9-inpaint":      ("page-9.jpg",  [255, 700, 490, 840]),
    "p9-hmf":          ("page-9.jpg",  [120, 740, 280, 890]),
    "p9-sickofit":     ("page-9.jpg",  [640, 920, 890, 1075]),
    "p9-enough":       ("page-9.jpg",  [850, 920, 1066, 1100]),
    "p9-lookatim":     ("page-9.jpg",  [450, 990, 610, 1110]),
    "p10-loosers":     ("page-10.jpg", [790, 200, 1066, 380]),
    "p10-drool":       ("page-10.jpg", [0, 380, 220, 570]),
    "p10-cantapolog":  ("page-10.jpg", [55, 655, 460, 800]),
    "p10-howdareyou":  ("page-10.jpg", [800, 855, 1015, 1000]),
    "p10-shf":         ("page-10.jpg", [575, 1080, 720, 1160]),
    "p5-oncetime":     ("page-5.jpg",  [10, 10, 1056, 130]),
    "p5-suffering":    ("page-5.jpg",  [30, 155, 1040, 250]),
    "p5-shinobidied":  ("page-5.jpg",  [50, 1090, 1000, 1140]),
    "p5-fourthhokage": ("page-5.jpg",  [50, 1180, 1030, 1300]),
}

manifest = {}
for name, (src, box) in CROPS.items():
    img = Image.open(os.path.join(pages, src)).convert("RGB")
    crop = img.crop(tuple(box))
    crop.save(os.path.join(out, f"{name}.png"))
    manifest[name] = {"src": src, "box": box, "size": crop.size}

with open(os.path.join(base, "crops-manifest.json"), "w", encoding="utf-8") as f:
    json.dump(manifest, f, indent=2)

print(f"{len(manifest)} crops written to {out}")
