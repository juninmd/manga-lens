/** Caixa em pixels da pagina original. */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Saida do detector neural: 0 = balao, 1 = texto em balao, 2 = texto solto. */
export interface Detection extends Rect {
  label: 0 | 1 | 2;
  score: number;
}

/** Regiao da heuristica de manchas claras, em coordenadas reduzidas (`scale`). */
export interface HeuristicRegion extends Rect {
  mask: Uint8Array;
  bg: string;
  fg: string;
}

export interface OcrTarget {
  /** o que o OCR le: a caixa justa do texto quando o modelo achou */
  ocr: Rect;
  /** onde a traducao e' letreirada (e o que `mask` cobre) */
  block: Rect;
  mask?: { w: number; h: number; data: Uint8Array };
  bg?: string;
  fg?: string;
  /** sem balao heuristico: o chamador decide entre cor lisa e difusao */
  free: boolean;
}

export const MIN_SCORE = 0.5;
const DUP_IOU = 0.6;
const INSIDE = 0.6;
/** margem da area apagada/letreirada em volta do texto solto */
const TEXT_MARGIN = 0.06;
/**
 * O Tesseract erra letra de borda sem respiro branco: em balao o recorte do OCR
 * e' folgado (o que cai fora da mascara e' branqueado antes da leitura).
 */
const OCR_MARGIN = 0.15;

const area = (r: Rect): number => Math.max(0, r.w) * Math.max(0, r.h);

function intersect(a: Rect, b: Rect): Rect {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  return { x, y, w: Math.min(a.x + a.w, b.x + b.w) - x, h: Math.min(a.y + a.h, b.y + b.h) - y };
}

/** Fracao de `inner` que esta' dentro de `outer`. */
export function coverage(inner: Rect, outer: Rect): number {
  const i = intersect(inner, outer);
  return i.w > 0 && i.h > 0 ? area(i) / Math.max(area(inner), 1) : 0;
}

const iou = (a: Rect, b: Rect): number => {
  const i = intersect(a, b);
  if (i.w <= 0 || i.h <= 0) return 0;
  const inter = area(i);
  return inter / (area(a) + area(b) - inter);
};

const grow = (r: Rect, f: number, page: { w: number; h: number }): Rect =>
  intersect({ x: r.x - r.w * f, y: r.y - r.h * f, w: r.w * (1 + 2 * f), h: r.h * (1 + 2 * f) }, { x: 0, y: 0, ...page });

const toImage = (r: Rect, scale: number): Rect => ({ x: r.x / scale, y: r.y / scale, w: r.w / scale, h: r.h / scale });

/** Recorta a mascara da regiao para `sub` (coordenadas reduzidas), para dividir baloes fundidos. */
export function cropMask(region: HeuristicRegion, sub: Rect): { box: Rect; mask: { w: number; h: number; data: Uint8Array } } | null {
  const x0 = Math.max(Math.floor(sub.x), region.x);
  const y0 = Math.max(Math.floor(sub.y), region.y);
  const x1 = Math.min(Math.ceil(sub.x + sub.w), region.x + region.w);
  const y1 = Math.min(Math.ceil(sub.y + sub.h), region.y + region.h);
  const w = x1 - x0;
  const h = y1 - y0;
  if (w <= 0 || h <= 0) return null;
  const data = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) data[y * w + x] = region.mask[(y + y0 - region.y) * region.w + (x + x0 - region.x)]!;
  }
  return { box: { x: x0, y: y0, w, h }, mask: { w, h, data } };
}

/**
 * Funde o detector neural com a heuristica. O modelo sabe ONDE ha texto (inclusive
 * fora de balao e em pagina colorida); a heuristica sabe o formato exato do balao
 * (mascara) e a cor dele, que o letreiramento precisa. Regras:
 * - regiao heuristica com um texto: mascara dela, OCR na caixa justa do modelo;
 * - regiao que engoliu varios textos (baloes vizinhos fundidos): dividida pelas
 *   caixas de balao do modelo;
 * - texto sem regiao heuristica: vira alvo "livre" (legenda, SFX, balao colorido);
 * - regiao sem texto do modelo so' e' lida quando o modelo nao achou texto
 *   nenhum na pagina (estilo que ele nao conhece): nas paginas de teste, toda
 *   regiao assim era trama ou borda e so' virava lixo para o LLM.
 */
export function planTargets(
  detections: Detection[],
  regions: HeuristicRegion[],
  scale: number,
  page: { w: number; h: number },
): OcrTarget[] {
  const confident = detections.filter((d) => d.score >= MIN_SCORE);
  const bubbles = confident.filter((d) => d.label === 0);
  const texts: Detection[] = [];
  for (const t of confident.filter((d) => d.label !== 0).sort((a, b) => b.score - a.score)) {
    if (!texts.some((k) => iou(k, t) > DUP_IOU)) texts.push(t);
  }

  const used = new Set<Detection>();
  const out: OcrTarget[] = [];
  for (const r of regions) {
    const rImg = toImage(r, scale);
    const inside = texts.filter((t) => !used.has(t) && coverage(t, rImg) >= INSIDE);
    // o modelo leu a pagina e nao viu texto aqui: trama/borda (ou texto que so' atravessa, lido como livre)
    if (!inside.length && texts.length > 0) continue;
    if (inside.length <= 1) {
      const t = inside[0];
      if (t) used.add(t);
      out.push({ ocr: t ? grow(t, OCR_MARGIN, page) : rImg, block: rImg, mask: { w: r.w, h: r.h, data: r.mask }, bg: r.bg, fg: r.fg, free: false });
      continue;
    }
    for (const t of inside) {
      used.add(t);
      const bubble = bubbles
        .filter((b) => coverage(t, b) >= 0.8)
        .sort((a, b) => area(a) - area(b))[0];
      const sub = bubble ?? grow(t, TEXT_MARGIN, page);
      const cut = cropMask(r, { x: sub.x * scale, y: sub.y * scale, w: sub.w * scale, h: sub.h * scale });
      if (!cut) continue;
      out.push({ ocr: grow(t, OCR_MARGIN, page), block: toImage(cut.box, scale), mask: cut.mask, bg: r.bg, fg: r.fg, free: false });
    }
  }
  for (const t of texts) {
    // sem mascara nada e' branqueado: margem curta, senao a arte em volta entra na leitura
    if (!used.has(t)) out.push({ ocr: grow(t, TEXT_MARGIN, page), block: grow(t, TEXT_MARGIN, page), free: true });
  }
  return out;
}
