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
/**
 * Regiao muitas vezes maior que o unico texto dentro dela nao e' o balao desse
 * texto: e' um painel claro com uma legenda ou onomatopeia. Usada inteira, o
 * letreiramento repintava o painel todo (arte inclusa) para trocar uma palavra.
 */
const OVERSIZE = 12;

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

const MERGE_RATIO = 0.45; // fracao do menor bbox que precisa estar coberta para virar um so'

/**
 * Quanto do MENOR dos dois bboxes esta' dentro do outro. Encostar nao basta: numa
 * pagina cheia os baloes vizinhos se tocam pelas bordas, e fundir nesse toque
 * juntava quatro falas num bloco so' — o OCR lia tudo grudado e a traducao saia
 * empilhada num balao enquanto os outros ficavam no idioma original.
 */
function overlapRatio(a: HeuristicRegion, b: HeuristicRegion): number {
  const ix = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const iy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  if (ix <= 0 || iy <= 0) return 0;
  return (ix * iy) / Math.min(a.w * a.h, b.w * b.h);
}

/**
 * Uma regiao inteira dentro de outra bem maior: balao sobre painel de fundo claro
 * (pagina colorida, webtoon pastel), nao dois pedacos do mesmo balao.
 */
function nested(a: HeuristicRegion, b: HeuristicRegion): boolean {
  const [small, big] = a.w * a.h <= b.w * b.h ? [a, b] : [b, a];
  // quase todo dentro, nao 100%: o balao costuma passar uns pixels da borda do painel ou encostar num objeto
  return small.w * small.h < big.w * big.h * 0.5 && overlapRatio(small, big) >= 0.85;
}

/**
 * Ao juntar dois baloes encostados, as mascaras tambem precisam ser unidas.
 *
 * `keepNested` (caminho com detector neural): balao contido num painel claro NAO e'
 * fundido com o painel. Fundido, ele herdava a cor do painel e era repintado de
 * cinza/azul em vez do proprio branco; separado, `planTargets` da' cada texto a
 * menor regiao que o contem. Sem o detector a fusao antiga continua valendo: la'
 * toda regiao e' lida, e o painel solto viraria um segundo OCR por cima dos baloes.
 */
export function mergeOverlaps(regions: HeuristicRegion[], keepNested = false): HeuristicRegion[] {
  const out: HeuristicRegion[] = [];
  for (const r of regions) {
    const hit = out.find((o) => overlapRatio(o, r) >= MERGE_RATIO && !(keepNested && nested(o, r)));
    if (!hit) {
      out.push({ ...r });
      continue;
    }
    const x = Math.min(hit.x, r.x);
    const y = Math.min(hit.y, r.y);
    const w = Math.max(hit.x + hit.w, r.x + r.w) - x;
    const h = Math.max(hit.y + hit.h, r.y + r.h) - y;
    const mask = new Uint8Array(w * h);
    for (const src of [hit, r]) {
      for (let sy = 0; sy < src.h; sy++) {
        for (let sx = 0; sx < src.w; sx++) {
          if (src.mask[sy * src.w + sx]) mask[(sy + src.y - y) * w + (sx + src.x - x)] = 1;
        }
      }
    }
    hit.x = x;
    hit.y = y;
    hit.w = w;
    hit.h = h;
    hit.mask = mask;
  }
  return out;
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

  // Cada texto pertence a MENOR regiao que o contem. Painel de fundo claro (pagina
  // colorida, webtoon pastel) tambem e' uma "mancha clara fechada", e a caixa dele
  // contem todos os baloes de dentro: por ordem de chegada ele ficava com os textos,
  // e o balao era repintado com a cor do painel em vez do proprio branco.
  const owner = new Map<Detection, HeuristicRegion>();
  for (const t of texts) {
    let best: HeuristicRegion | undefined;
    for (const r of regions) {
      if (coverage(t, toImage(r, scale)) >= INSIDE && (!best || area(r) < area(best))) best = r;
    }
    if (best) owner.set(t, best);
  }

  const used = new Set<Detection>();
  const out: OcrTarget[] = [];
  for (const r of regions) {
    const rImg = toImage(r, scale);
    const inside = texts.filter((t) => owner.get(t) === r);
    // o modelo leu a pagina e nao viu texto aqui: trama/borda (ou texto que so' atravessa, lido como livre)
    if (!inside.length && texts.length > 0) continue;
    if (inside.length <= 1 && !(inside[0] && area(rImg) > OVERSIZE * area(inside[0]))) {
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
