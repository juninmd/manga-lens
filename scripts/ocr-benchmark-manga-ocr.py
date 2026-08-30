"""
Spike de benchmark (issue #5): roda manga-ocr (kha-white, transformer treinado
especificamente em manga japones) e EasyOCR (motor multi-idioma baseado em
deep learning, mais pesado que o Tesseract atual) contra o mesmo conjunto de
recortes usado por `scripts/ocr-benchmark.mjs`, e imprime CER/latencia.

manga-ocr so' reconhece japones -- roda so' no conjunto sintetico jp.
EasyOCR e' multi-idioma -- roda no conjunto real em ingles.

Nao faz parte do app: dependencia Python isolada (venv/pip --user), nao entra
em package.json nem no bundle.

Uso:
    pip install manga-ocr easyocr pillow
    python scripts/ocr-benchmark-manga-ocr.py
"""
import json
import os
import time

ROOT = os.path.join(os.path.dirname(__file__), "..", ".workflow", "5-competitive-quality")


def levenshtein(a, b):
    m, n = len(a), len(b)
    dp = [[0] * (n + 1) for _ in range(m + 1)]
    for i in range(m + 1):
        dp[i][0] = i
    for j in range(n + 1):
        dp[0][j] = j
    for i in range(1, m + 1):
        for j in range(1, n + 1):
            dp[i][j] = dp[i - 1][j - 1] if a[i - 1] == b[j - 1] else 1 + min(
                dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]
            )
    return dp[m][n]


def norm(s):
    return " ".join(s.strip().split()).upper()


def cer(hyp, ref):
    a, b = norm(hyp), norm(ref)
    if not b:
        return 0.0 if not a else 1.0
    return levenshtein(a, b) / len(b)


def run_manga_ocr():
    from manga_ocr import MangaOcr
    from PIL import Image

    with open(os.path.join(ROOT, "ocr-ground-truth-jp.json"), encoding="utf-8") as f:
        gt = json.load(f)

    print("\n=== manga-ocr (kha-white, transformer JP) ===")
    mocr = MangaOcr()
    total_cer, total_ms, n = 0.0, 0.0, 0
    for item_id, ref in gt["items"].items():
        img = Image.open(os.path.join(ROOT, "crops-jp", f"{item_id}.png"))
        t0 = time.time()
        hyp = mocr(img)
        ms = (time.time() - t0) * 1000
        c = cer(hyp, ref)
        total_cer += c
        total_ms += ms
        n += 1
        print(f"  [{item_id}] CER={c:.2f} {ms:.0f}ms\n    ref: {ref!r}\n    hyp: {hyp!r}")
    print(f"  -> CER medio: {total_cer / n:.3f} · latencia media: {total_ms / n:.0f}ms  ({n} itens)")
    return total_cer / n, total_ms / n


def run_easyocr():
    import easyocr
    from PIL import Image
    import numpy as np

    with open(os.path.join(ROOT, "ocr-ground-truth.json"), encoding="utf-8") as f:
        gt = json.load(f)

    print("\n=== EasyOCR (deep learning, multi-idioma, eng) ===")
    reader = easyocr.Reader(["en"], gpu=False, verbose=False)
    total_cer, total_ms, n = 0.0, 0.0, 0
    for item_id, ref in gt["items"].items():
        img = np.array(Image.open(os.path.join(ROOT, "crops", f"{item_id}.png")).convert("RGB"))
        t0 = time.time()
        result = reader.readtext(img, detail=0, paragraph=True)
        ms = (time.time() - t0) * 1000
        hyp = " ".join(result)
        c = cer(hyp, ref)
        total_cer += c
        total_ms += ms
        n += 1
        print(f"  [{item_id}] CER={c:.2f} {ms:.0f}ms\n    ref: {ref!r}\n    hyp: {hyp!r}")
    print(f"  -> CER medio: {total_cer / n:.3f} · latencia media: {total_ms / n:.0f}ms  ({n} itens)")
    return total_cer / n, total_ms / n


if __name__ == "__main__":
    jp_cer, jp_ms = run_manga_ocr()
    en_cer, en_ms = run_easyocr()
    print("\n=== Resumo ===")
    print(f"  manga-ocr (jpn, sintetico): CER medio {jp_cer:.3f}, {jp_ms:.0f}ms/item")
    print(f"  EasyOCR (eng, paginas reais): CER medio {en_cer:.3f}, {en_ms:.0f}ms/item")
