import type { OcrBlock } from './ocr.ts';

/** Lado maior da imagem enviada: legivel para o modelo de visao sem estourar tokens. */
const MAX_SIDE = 1024;
const QUALITY = 0.72;

/**
 * Pagina reduzida com o id de cada balao desenhado por cima — o formato que
 * rendeu melhor no paper de traducao multimodal de manga (COLING 2025): o
 * modelo liga cada texto ao balao e ve a cena (quem fala, genero, tom).
 * `undefined` quando o canvas nao pode ser lido (imagem sem CORS).
 */
export function numberedPage(img: HTMLImageElement, blocks: readonly OcrBlock[]): string | undefined {
  const scale = Math.min(1, MAX_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
  const ctx = canvas.getContext('2d');
  if (!ctx) return undefined;
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

  const radius = Math.max(9, Math.round(canvas.width / 70));
  ctx.font = `bold ${Math.round(radius * 1.2)}px sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (const b of blocks) {
    const cx = (b.x + b.w / 2) * scale;
    const cy = Math.max(radius, b.y * scale);
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.fillStyle = '#d0021b';
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = '#fff';
    ctx.stroke();
    ctx.fillStyle = '#fff';
    ctx.fillText(String(b.id), cx, cy + 1);
  }
  try {
    return canvas.toDataURL('image/jpeg', QUALITY);
  } catch {
    // canvas "tainted": segue so' com o texto, que e' o caminho padrao
    return undefined;
  }
}
