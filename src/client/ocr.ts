import { createWorker, type Worker } from 'tesseract.js';
import { translate } from './api.ts';
import { api } from './base.ts';

/** Mascara do balao em coordenadas reduzidas, relativa ao bbox do bloco. */
export interface BalloonMask {
  w: number;
  h: number;
  /** 1 = interior do balao (inclui os buracos das letras) */
  data: Uint8Array;
}

export interface OcrBlock {
  id: number;
  text: string;
  pt?: string;
  confidence: number;
  x: number;
  y: number;
  w: number;
  h: number;
  mask?: BalloonMask;
  /** cor de fundo do balao e cor da tinta, amostradas da propria pagina */
  bg?: string;
  fg?: string;
  /** o texto original era caixa alta? a traducao acompanha */
  upper?: boolean;
}

export interface OcrProgress {
  stage: string;
  ratio: number;
}

const TESS_BY_LANG: Record<string, string> = {
  ja: 'jpn+jpn_vert',
  ko: 'kor',
  zh: 'chi_sim',
  'zh-hk': 'chi_tra',
  en: 'eng',
  'pt-br': 'por',
  pt: 'por',
  es: 'spa',
  'es-la': 'spa',
  fr: 'fra',
  it: 'ita',
  de: 'deu',
  ru: 'rus',
  id: 'ind',
  unknown: 'jpn+jpn_vert+eng',
};

/**
 * O idioma do OCR e' o do SCAN, nao o da obra: Naruto e' japones, mas o capitulo
 * publicado em ingles precisa de `eng`. So cai no idioma original quando o
 * capitulo nao declara nada (raw, arquivo local).
 */
export function langFor(chapterLang: string | undefined, origin: string | undefined, setting: string): string {
  if (setting !== 'auto') return setting;
  const scan = (chapterLang ?? '').toLowerCase();
  if (scan && scan !== 'local' && TESS_BY_LANG[scan]) return TESS_BY_LANG[scan]!;
  return TESS_BY_LANG[(origin ?? 'unknown').toLowerCase()] ?? TESS_BY_LANG['unknown']!;
}

/**
 * Um worker por nucleo (teto de 4, chao de 1). Cada balao e' um reconhecimento
 * independente, entao a pagina inteira paralela bem; o teto existe porque cada
 * worker carrega sua propria copia do modelo do idioma. O chao era 2 antes, o
 * que forcava 2 workers ate' em maquina de 1-2 nucleos reportados — cada um
 * competindo com a thread principal pela mesma CPU.
 */
const CORES = navigator.hardwareConcurrency || 4;
const POOL_SIZE = Math.max(1, Math.min(4, CORES - 1));
// idioma trocado no meio da leitura (ex. um scan em ingles depois de um em
// japones) nao pode ir empilhando pool: o teto vale para todos os idiomas
// juntos, nao por idioma — senao 3 idiomas abertos viram 9-12 workers.
const GLOBAL_CAP = Math.max(POOL_SIZE, CORES);

const pools = new Map<string, Promise<Worker>[]>();
const lastUsed = new Map<string, number>();
let clock = 0;

function totalWorkers(): number {
  let n = 0;
  for (const p of pools.values()) n += p.length;
  return n;
}

/** Derruba os idiomas ha mais tempo sem uso ate' sobrar espaco pro pool novo. */
async function evictLru(except: string, need: number): Promise<void> {
  const order = [...lastUsed.entries()]
    .filter(([lang]) => lang !== except && pools.has(lang))
    .sort((a, b) => a[1] - b[1]);
  for (const [lang] of order) {
    if (totalWorkers() + need <= GLOBAL_CAP) return;
    const pool = pools.get(lang);
    if (!pool) continue;
    pools.delete(lang);
    lastUsed.delete(lang);
    for (const w of pool) await (await w).terminate().catch(() => undefined);
  }
}

/**
 * O logger e' fixado na criacao do worker, que acontece uma vez so'. Passar o
 * callback do primeiro chamador direto para la' prendia a barra de status na
 * primeira pagina para sempre: a fila adiantava a pagina 30 e a barra anunciava
 * "pag. 1: recognizing text". O ponteiro movel faz o progresso pertencer a quem
 * esta' reconhecendo agora.
 */
let activeProgress: ((p: OcrProgress) => void) | undefined;

function getPool(lang: string): Promise<Worker>[] {
  // marca o uso para a eviccao LRU do teto global de workers (PR #3)
  lastUsed.set(lang, ++clock);
  let pool = pools.get(lang);
  if (!pool) {
    void evictLru(lang, POOL_SIZE);
    pool = Array.from({ length: POOL_SIZE }, (_, i) =>
      createWorker(lang, 1, {
        workerPath: '/vendor/tesseract/worker.min.js',
        corePath: '/vendor/tesseract/',
        langPath: api('/api/tessdata'),
        // so' o primeiro reporta: N workers baixando o mesmo modelo viram ruido na
        // barra. Os outros levam um no-op — o tesseract chama o logger sempre, e
        // `undefined` ali dispara TypeError a cada evento de progresso.
        logger:
          i === 0
            ? (m: { status: string; progress: number }) =>
                activeProgress?.({ stage: m.status, ratio: m.progress ?? 0 })
            : () => undefined,
      }),
    );
    pools.set(lang, pool);
  }
  return pool;
}

export async function disposeOcr(): Promise<void> {
  for (const [, pool] of pools) {
    for (const w of pool) await (await w).terminate().catch(() => undefined);
  }
  pools.clear();
  lastUsed.clear();
}

const UPSCALE = 2; // OCR de balao melhora muito com a pagina ampliada antes de reconhecer

/** Pre-processa: escala 2x, cinza e ganho de contraste. Sem isso o japones vira ruido. */
function preprocess(img: HTMLImageElement): HTMLCanvasElement {
  const w = Math.round(img.naturalWidth * UPSCALE);
  const h = Math.round(img.naturalHeight * UPSCALE);
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0, w, h);

  const data = ctx.getImageData(0, 0, w, h);
  const px = data.data;
  // Janela fixa de proposito. Tentei deriva-la do histograma da pagina (como o
  // corte da deteccao) e o resultado piorou: extraiu mais letras, mas de ruido, e
  // derrubou a confianca dos baloes bons de 65 para 24 — o Tesseract ja' faz a
  // propria binarizacao e se sai melhor com o contraste duro.
  for (let i = 0; i < px.length; i += 4) {
    const g = 0.299 * px[i]! + 0.587 * px[i + 1]! + 0.114 * px[i + 2]!;
    const boosted = g < 110 ? 0 : g > 165 ? 255 : (g - 110) * (255 / 55);
    px[i] = px[i + 1] = px[i + 2] = boosted;
  }
  ctx.putImageData(data, 0, 0);
  return canvas;
}

interface Region {
  /** em coordenadas reduzidas da deteccao */
  x: number;
  y: number;
  w: number;
  h: number;
  mask: Uint8Array;
  bg: string;
  fg: string;
}

const DETECT_WIDTH = 1000;

/**
 * Corte de "claro" que define o interior do balao. Fixo em 205 ele assumia papel
 * branco: em scan de papel-jornal escurecido (Plastic Man 005 tem 90o percentil
 * em 211, contra ~250 de uma pagina branca) o interior do balao mal encosta no
 * corte e se estilhaça em milhares de componentes minusculos — a pagina inteira
 * sai com 0 a 3 baloes. O topo do histograma e' o proprio papel: o corte desce
 * junto com ele, e o teto em 205 mantem a pagina branca com o comportamento antigo.
 */
function brightCut(gray: Uint8Array): number {
  const hist = new Uint32Array(256);
  for (let i = 0; i < gray.length; i++) {
    const g = gray[i] ?? 0;
    hist[g] = (hist[g] ?? 0) + 1;
  }
  const target = gray.length * 0.9;
  let seen = 0;
  let paper = 255;
  for (let v = 0; v < 256; v++) {
    seen += hist[v] ?? 0;
    if (seen >= target) {
      paper = v;
      break;
    }
  }
  return Math.max(150, Math.min(205, paper - 35));
}

/**
 * Preenche os buracos da mancha: as letras sao furos dentro do balao, entao o
 * interior "cheio" e' o que precisa ser limpo para receber a traducao — pintar
 * so' a mancha branca deixaria o texto original por baixo.
 */
function fillHoles(comp: Uint8Array, w: number, h: number): Uint8Array {
  const outside = new Uint8Array(w * h);
  const stack: number[] = [];
  const push = (p: number): void => {
    if (!outside[p] && !comp[p]) {
      outside[p] = 1;
      stack.push(p);
    }
  };
  for (let x = 0; x < w; x++) {
    push(x);
    push((h - 1) * w + x);
  }
  for (let y = 0; y < h; y++) {
    push(y * w);
    push(y * w + w - 1);
  }
  while (stack.length) {
    const p = stack.pop()!;
    const y = (p / w) | 0;
    const x = p - y * w;
    if (x > 0) push(p - 1);
    if (x < w - 1) push(p + 1);
    if (y > 0) push(p - w);
    if (y < h - 1) push(p + w);
  }
  const filled = new Uint8Array(w * h);
  for (let p = 0; p < filled.length; p++) filled[p] = outside[p] ? 0 : 1;
  return filled;
}

/** Encolhe a mascara para nao pintar por cima do contorno preto do balao. */
function erode(mask: Uint8Array, w: number, h: number, rounds: number): Uint8Array {
  let current = mask;
  for (let r = 0; r < rounds; r++) {
    const next = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const p = y * w + x;
        if (!current[p]) continue;
        const edge =
          x === 0 ||
          y === 0 ||
          x === w - 1 ||
          y === h - 1 ||
          !current[p - 1] ||
          !current[p + 1] ||
          !current[p - w] ||
          !current[p + w];
        next[p] = edge ? 0 : 1;
      }
    }
    current = next;
  }
  return current;
}

const rgb = (r: number, g: number, b: number): string => `rgb(${r | 0}, ${g | 0}, ${b | 0})`;

/**
 * Detecta baloes antes do OCR. A analise de layout do Tesseract se perde na arte
 * do quadrinho e devolve a pagina inteira como um paragrafo so'; achando as
 * manchas brancas fechadas primeiro, cada balao vira uma regiao propria.
 */
function detectBalloons(img: HTMLImageElement): { regions: Region[]; scale: number } {
  const scale = Math.min(1, DETECT_WIDTH / (img.naturalWidth || DETECT_WIDTH));
  const w = Math.max(Math.round(img.naturalWidth * scale), 1);
  const h = Math.max(Math.round(img.naturalHeight * scale), 1);
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(img, 0, 0, w, h);
  const px = ctx.getImageData(0, 0, w, h).data;

  const gray = new Uint8Array(w * h);
  for (let i = 0, p = 0; i < px.length; i += 4, p++) {
    gray[p] = (0.299 * px[i]! + 0.587 * px[i + 1]! + 0.114 * px[i + 2]!) | 0;
  }
  const BRIGHT = brightCut(gray);

  const visited = new Uint8Array(w * h);
  const stack = new Int32Array(w * h);
  const regions: Region[] = [];
  const area = w * h;
  const seeds: { seed: number; x0: number; y0: number; x1: number; y1: number }[] = [];

  for (let start = 0; start < gray.length; start++) {
    if (visited[start] || gray[start]! < BRIGHT) continue;
    let top = 0;
    stack[top++] = start;
    visited[start] = 1;
    let count = 0;
    let x0 = w;
    let y0 = h;
    let x1 = 0;
    let y1 = 0;

    while (top > 0) {
      const p = stack[--top]!;
      const y = (p / w) | 0;
      const x = p - y * w;
      count++;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
      // sequencia com virgula no lugar de bloco: este laco roda por pixel da
      // pagina inteira e o corpo em uma linha e' o que mantem o custo baixo
      /* oxlint-disable no-unused-expressions */
      if (x > 0 && !visited[p - 1] && gray[p - 1]! >= BRIGHT) (visited[p - 1] = 1), (stack[top++] = p - 1);
      if (x < w - 1 && !visited[p + 1] && gray[p + 1]! >= BRIGHT) (visited[p + 1] = 1), (stack[top++] = p + 1);
      if (y > 0 && !visited[p - w] && gray[p - w]! >= BRIGHT) (visited[p - w] = 1), (stack[top++] = p - w);
      if (y < h - 1 && !visited[p + w] && gray[p + w]! >= BRIGHT) (visited[p + w] = 1), (stack[top++] = p + w);
      /* oxlint-enable no-unused-expressions */
    }

    const bw = x1 - x0 + 1;
    const bh = y1 - y0 + 1;
    const fill = count / (bw * bh);
    const aspect = bw / bh;
    if (count < area * 0.0006 || count > area * 0.13) continue;
    if (bw < 26 || bh < 20) continue;
    if (fill < 0.5 || aspect < 0.18 || aspect > 7) continue;

    // dentro do balao tem que existir tinta — descarta ceu, camisa branca, moldura
    let dark = 0;
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) if (gray[y * w + x]! < 110) dark++;
    }
    const inkRatio = dark / (bw * bh);
    if (inkRatio < 0.012 || inkRatio > 0.45) continue;

    seeds.push({ seed: start, x0, y0, x1, y1 });
  }

  for (const s of seeds) {
    const bw = s.x1 - s.x0 + 1;
    const bh = s.y1 - s.y0 + 1;
    const comp = new Uint8Array(bw * bh);
    const local = new Int32Array(bw * bh);
    let top = 0;
    const seedLocal = (((s.seed / w) | 0) - s.y0) * bw + ((s.seed % w) - s.x0);
    local[top++] = seedLocal;
    comp[seedLocal] = 1;
    while (top > 0) {
      const p = local[--top]!;
      const ly = (p / bw) | 0;
      const lx = p - ly * bw;
      const push = (np: number, nx: number, ny: number): void => {
        if (nx < 0 || ny < 0 || nx >= bw || ny >= bh || comp[np]) return;
        if (gray[(ny + s.y0) * w + (nx + s.x0)]! < BRIGHT) return;
        comp[np] = 1;
        local[top++] = np;
      };
      push(p - 1, lx - 1, ly);
      push(p + 1, lx + 1, ly);
      push(p - bw, lx, ly - 1);
      push(p + bw, lx, ly + 1);
    }

    const filled = erode(fillHoles(comp, bw, bh), bw, bh, 2);

    // cores amostradas da propria pagina: o balao pode ser creme, cinza, preto
    let bgR = 0;
    let bgG = 0;
    let bgB = 0;
    let bgN = 0;
    let fgR = 0;
    let fgG = 0;
    let fgB = 0;
    let fgN = 0;
    for (let ly = 0; ly < bh; ly++) {
      for (let lx = 0; lx < bw; lx++) {
        if (!filled[ly * bw + lx]) continue;
        const p = ((ly + s.y0) * w + (lx + s.x0)) * 4;
        const isInk = gray[(ly + s.y0) * w + (lx + s.x0)]! < 120;
        if (isInk) {
          fgR += px[p]!;
          fgG += px[p + 1]!;
          fgB += px[p + 2]!;
          fgN++;
        } else if (comp[ly * bw + lx]) {
          bgR += px[p]!;
          bgG += px[p + 1]!;
          bgB += px[p + 2]!;
          bgN++;
        }
      }
    }

    regions.push({
      x: s.x0,
      y: s.y0,
      w: bw,
      h: bh,
      mask: filled,
      bg: bgN ? rgb(bgR / bgN, bgG / bgN, bgB / bgN) : '#ffffff',
      fg: fgN ? rgb(fgR / fgN, fgG / fgN, fgB / fgN) : '#111111',
    });
  }

  return { regions: mergeOverlaps(regions).sort((a, b) => a.y - b.y || a.x - b.x), scale };
}

const MERGE_RATIO = 0.45; // fracao do menor bbox que precisa estar coberta para virar um so'

/**
 * Quanto do MENOR dos dois bboxes esta' dentro do outro. Encostar nao basta: numa
 * pagina cheia os baloes vizinhos se tocam pelas bordas, e fundir nesse toque
 * juntava quatro falas num bloco so' — o OCR lia tudo grudado e a traducao saia
 * empilhada num balao enquanto os outros ficavam no idioma original.
 */
function overlapRatio(a: Region, b: Region): number {
  const ix = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const iy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  if (ix <= 0 || iy <= 0) return 0;
  return (ix * iy) / Math.min(a.w * a.h, b.w * b.h);
}

/** Ao juntar dois baloes encostados, as mascaras tambem precisam ser unidas. */
function mergeOverlaps(regions: Region[]): Region[] {
  const out: Region[] = [];
  for (const r of regions) {
    const hit = out.find((o) => overlapRatio(o, r) >= MERGE_RATIO);
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

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

function crop(source: HTMLCanvasElement, r: Box, pad: number): HTMLCanvasElement {
  const x = Math.max(Math.round(r.x * UPSCALE) - pad, 0);
  const y = Math.max(Math.round(r.y * UPSCALE) - pad, 0);
  const w = Math.min(Math.round(r.w * UPSCALE) + pad * 2, source.width - x);
  const h = Math.min(Math.round(r.h * UPSCALE) + pad * 2, source.height - y);
  const out = document.createElement('canvas');
  out.width = w;
  out.height = h;
  const ctx = out.getContext('2d')!;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(source, x, y, w, h, 0, 0, w, h);
  return out;
}

export async function recognizePage(
  img: HTMLImageElement,
  lang: string,
  onProgress?: (p: OcrProgress) => void,
): Promise<OcrBlock[]> {
  const previous = activeProgress;
  activeProgress = onProgress;
  try {
    return await recognize(img, lang, onProgress);
  } finally {
    activeProgress = previous;
  }
}

async function recognize(
  img: HTMLImageElement,
  lang: string,
  onProgress?: (p: OcrProgress) => void,
): Promise<OcrBlock[]> {
  const pool = await Promise.all(getPool(lang));
  const page = preprocess(img);
  const { regions, scale } = detectBalloons(img);

  // Sem balao detectado (pagina colorida, HQ ocidental), cai para a pagina inteira.
  if (!regions.length) {
    const worker = pool[0]!;
    await worker.setParameters({ tessedit_pageseg_mode: '3' as never });
    const { data } = await worker.recognize(page, {}, { text: true });
    const text = (data.text ?? '').trim();
    return text.length > 3
      ? [{ id: 0, text, confidence: data.confidence ?? 0, x: 0, y: 0, w: img.naturalWidth, h: img.naturalHeight }]
      : [];
  }

  // vertical (japones) le melhor em coluna unica; o resto, bloco uniforme
  const vertical = lang.includes('vert');
  await Promise.all(
    pool.map((w) => w.setParameters({ tessedit_pageseg_mode: (vertical ? '5' : '6') as never })),
  );

  // Um balao nao depende do outro: cada worker puxa o proximo da fila e reconhece
  // em paralelo. A ordem de leitura e' preservada pelo indice, nao pela chegada.
  const found = new Array<OcrBlock | null>(regions.length).fill(null);
  let next = 0;
  let done = 0;

  await Promise.all(
    pool.map(async (worker) => {
      for (;;) {
        const i = next++;
        if (i >= regions.length) return;
        const region = regions[i]!;
        // deteccao trabalha reduzida; o OCR e a composicao usam o tamanho real
        const box: Box = { x: region.x / scale, y: region.y / scale, w: region.w / scale, h: region.h / scale };
        const { data } = await worker.recognize(crop(page, box, 6), {}, { text: true });
        done++;
        onProgress?.({ stage: `balao ${done}/${regions.length}`, ratio: done / regions.length });

        const text = (data.text ?? '').replace(/\s*\n\s*/g, '\n').trim();
        if (text.replace(/[\s|_\-.,'"]/g, '').length < 2) continue;
        // confianca abaixo disso e' ruido de verdade: medido em scan de 1946, o
        // texto legivel pontuou 59 e o ilegivel ficou entre 15 e 25
        if ((data.confidence ?? 0) < 30) continue;

        const letters = text.replace(/[^\p{L}]/gu, '');
        const uppers = text.replace(/[^\p{Lu}]/gu, '');
        found[i] = {
          id: 0, // o id definitivo so' sai depois de descartar os vazios
          text,
          confidence: data.confidence ?? 0,
          ...box,
          mask: { w: region.w, h: region.h, data: region.mask },
          bg: region.bg,
          fg: region.fg,
          upper: letters.length > 0 && uppers.length / letters.length > 0.7,
        };
      }
    }),
  );

  // id contiguo: a traducao volta casada por id, entao nao pode ter buraco
  return found.filter((b): b is OcrBlock => b !== null).map((b, id) => ({ ...b, id }));
}

export async function translateBlocks(
  blocks: OcrBlock[],
  meta: { sourceLang?: string; series?: string; chapter?: string; engine?: string; target?: string },
): Promise<OcrBlock[]> {
  if (!blocks.length) return blocks;
  const { translations } = await translate({
    blocks: blocks.map((b) => ({ id: b.id, text: b.text })),
    ...meta,
  });
  const map = new Map(translations.map((t) => [t.id, t.pt]));
  return blocks.map((b) => ({ ...b, pt: map.get(b.id) ?? '' }));
}

export type LetterFont = 'comic' | 'sans' | 'serif';

const FONT_STACK: Record<LetterFont, string> = {
  // Wild Words/CC (padrao de scanlation) sao proprietarias; estas existem no Windows
  comic: '"Comic Sans MS", "Comic Neue", "Segoe UI", system-ui, sans-serif',
  sans: '"Segoe UI Semibold", "Segoe UI", system-ui, sans-serif',
  serif: 'Georgia, "Times New Roman", serif',
};

/** Uma linha ja' posicionada: o centro muda de linha para linha porque o balao e' redondo. */
interface Line {
  text: string;
  cx: number;
  width: number;
}

interface Layout {
  lines: Line[];
  size: number;
  lineHeight: number;
  top: number;
}

/** Largura util do balao em cada faixa horizontal, lida da propria mascara. */
interface Shape {
  /** t0/t1 sao fracoes verticais do bbox; devolve centro e largura em px da pagina */
  band(t0: number, t1: number): { cx: number; w: number } | null;
}

/**
 * A bbox e' um retangulo, o balao e' uma elipse: letreirar na bbox faz a primeira
 * e a ultima linha atravessarem o contorno. Aqui cada linha ganha a largura que
 * o balao realmente oferece na altura dela — a mancha de texto acompanha a forma.
 */
function shapeOf(b: OcrBlock): Shape | null {
  const m = b.mask;
  if (!m) return null;
  // maior corrida horizontal contigua de cada linha da mascara
  const runs = new Int32Array(m.h * 2);
  for (let y = 0; y < m.h; y++) {
    let bestS = -1;
    let bestE = -2;
    let s = -1;
    for (let x = 0; x <= m.w; x++) {
      if (x < m.w && m.data[y * m.w + x]) {
        if (s < 0) s = x;
      } else if (s >= 0) {
        if (x - 1 - s > bestE - bestS) {
          bestS = s;
          bestE = x - 1;
        }
        s = -1;
      }
    }
    runs[y * 2] = bestS;
    runs[y * 2 + 1] = bestE;
  }

  return {
    band(t0, t1) {
      const y0 = Math.max(Math.floor(t0 * m.h), 0);
      const y1 = Math.min(Math.ceil(t1 * m.h), m.h - 1);
      if (y1 < y0) return null;
      // a linha precisa caber em TODAS as alturas que ocupa, nao so' no meio dela
      let left = -Infinity;
      let right = Infinity;
      for (let y = y0; y <= y1; y++) {
        const s = runs[y * 2]!;
        const e = runs[y * 2 + 1]!;
        if (e < s) return null;
        if (s > left) left = s;
        if (e < right) right = e;
      }
      const w = ((right - left + 1) / m.w) * b.w;
      if (!Number.isFinite(w) || w < MIN_FONT) return null;
      return { cx: b.x + (((left + right + 1) / 2) / m.w) * b.w, w };
    },
  };
}

/** Maior prefixo de `word` que cabe em `w` ja' contando o hifen. */
function fitPrefix(ctx: CanvasRenderingContext2D, word: string, w: number): string {
  let lo = 1;
  let hi = word.length - 1;
  let best = '';
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const head = word.slice(0, mid);
    if (ctx.measureText(`${head}-`).width <= w) {
      best = head;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best;
}

const MAX_LINES = 40; // trava de seguranca: balao minusculo com texto longo nao pode girar sem fim

/**
 * Quebra gulosa usando a largura disponivel de CADA linha. Devolve null quando o
 * corpo nao serve — e' o sinal que a busca binaria usa para diminuir a fonte.
 */
function greedyWrap(
  ctx: CanvasRenderingContext2D,
  words: string[],
  size: number,
  n: number,
  bandOf: (i: number, n: number, size: number) => { cx: number; w: number },
  hyphenate: boolean,
): Line[] | null {
  const lines: Line[] = [];
  const queue = [...words];
  let band = bandOf(0, n, size);
  let line = '';
  const push = (): void => {
    lines.push({ text: line, cx: band.cx, width: band.w });
    line = '';
    band = bandOf(Math.min(lines.length, n - 1), n, size);
  };

  while (queue.length) {
    if (lines.length >= MAX_LINES) return null;
    const word = queue[0]!;
    const candidate = line ? `${line} ${word}` : word;
    if (ctx.measureText(candidate).width <= band.w) {
      line = candidate;
      queue.shift();
      continue;
    }
    // ainda ha' texto na linha: fecha e tenta a palavra na proxima, mais larga ou nao
    if (line) {
      push();
      continue;
    }
    // palavra sozinha nao cabe: sem hifenizacao esse corpo esta' descartado
    if (!hyphenate) return null;
    const head = fitPrefix(ctx, word, band.w) || word.slice(0, 1);
    queue[0] = word.slice(head.length);
    line = `${head}-`;
    push();
  }
  if (line) push();
  return lines;
}

/**
 * Escolhe o maior corpo que ainda cabe DENTRO do balao. Busca binaria em vez de
 * tentativa e erro: o resultado e' estavel entre paginas, que e' o que faz a
 * pagina inteira parecer letreirada pela mesma mao.
 */
function layoutText(ctx: CanvasRenderingContext2D, text: string, b: OcrBlock, font: string): Layout {
  const empty: Layout = { lines: [], size: 0, lineHeight: 0, top: 0 };
  const words = text.split(/\s+/).filter(Boolean);
  if (!words.length) return empty;

  const shape = shapeOf(b);
  const boxW = Math.max(b.w * (1 - PADDING * 2), MIN_FONT);
  const boxH = Math.max(b.h * (1 - PADDING * 2), MIN_FONT);
  const cy = b.y + b.h / 2;
  const cx = b.x + b.w / 2;

  const bandOf = (i: number, n: number, size: number): { cx: number; w: number } => {
    const yc = cy + (i - (n - 1) / 2) * size * LINE_HEIGHT;
    if (!shape) return { cx, w: boxW };
    // faixa que os glifos ocupam de fato, nao a entrelinha inteira
    const band = shape.band((yc - size * 0.5 - b.y) / b.h, (yc + size * 0.5 - b.y) / b.h);
    return band ? { cx: band.cx, w: Math.min(band.w * SHAPE_INSET, boxW) } : { cx, w: boxW };
  };

  const wrap = (size: number, hyphenate: boolean): Line[] | null => {
    ctx.font = `700 ${size}px ${font}`;
    // a largura de cada linha depende de quantas linhas existem, e vice-versa:
    // itera ate' o numero de linhas parar de mudar
    let n = 1;
    for (let pass = 0; pass < 5; pass++) {
      if (n * size * LINE_HEIGHT > boxH) return null;
      const lines = greedyWrap(ctx, words, size, n, bandOf, hyphenate);
      if (!lines?.length) return null;
      if (lines.length === n) return lines.length * size * LINE_HEIGHT <= boxH ? lines : null;
      n = lines.length;
    }
    return null;
  };

  const finish = (lines: Line[], size: number): Layout => ({
    lines,
    size,
    lineHeight: size * LINE_HEIGHT,
    top: cy - ((lines.length - 1) * size * LINE_HEIGHT) / 2,
  });

  const search = (hyphenate: boolean): Layout | null => {
    let lo = MIN_FONT;
    let hi = Math.max(Math.min(boxH, 96), MIN_FONT);
    let best: Layout | null = null;
    for (let i = 0; i < 9 && lo <= hi; i++) {
      const mid = (lo + hi) / 2;
      const lines = wrap(mid, hyphenate);
      if (lines) {
        best = finish(lines, mid);
        lo = mid + 0.5;
      } else {
        hi = mid - 0.5;
      }
    }
    return best;
  };

  const plain = search(false);
  // Palavra longa num balao estreito — o caso do portugues — espremeria a frase
  // inteira num corpo minusculo. Cortar com hifen so' compensa quando devolve um
  // texto bem maior; por isso o ganho tem de ser grande, nao qualquer um.
  const cut = plain && plain.size >= MIN_FONT * 2 ? null : search(true);
  if (cut && (!plain || cut.size >= plain.size * 1.25)) return cut;
  if (plain) return plain;

  // nem hifenizando coube: usa o menor corpo legivel e aceita transbordar de leve
  ctx.font = `700 ${MIN_FONT}px ${font}`;
  const lines = greedyWrap(ctx, words, MIN_FONT, 1, bandOf, true);
  return lines?.length ? finish(lines, MIN_FONT) : empty;
}

const LINE_HEIGHT = 1.14;
const MIN_FONT = 7;
const PADDING = 0.12; // fracao da caixa reservada para nao encostar no contorno
const SHAPE_INSET = 0.94; // a mascara ja' vem erodida; sobra so' o respiro do contorno

function lumaOf(css: string): number {
  const hex = /^#([0-9a-f]{6})$/i.exec(css.trim());
  const [r, g, b] = hex
    ? [0, 2, 4].map((i) => parseInt(hex[1]!.slice(i, i + 2), 16))
    : (css.match(/\d+/g)?.map(Number) ?? [0, 0, 0]);
  return 0.299 * (r ?? 0) + 0.587 * (g ?? 0) + 0.114 * (b ?? 0);
}

/**
 * A tinta e' amostrada da pagina e as vezes sai clara demais para o balao dela
 * (balao cinza, texto cinza). Sem contraste minimo a traducao some — nesse caso
 * cai para preto ou branco, o que a cor do balao pedir.
 */
function inkFor(bg: string, fg: string): string {
  return Math.abs(lumaOf(bg) - lumaOf(fg)) >= 70 ? fg : lumaOf(bg) > 140 ? '#111111' : '#f5f5f5';
}

/** Pinta o interior do balao com a cor dele — apaga o texto original sem tocar na arte. */
function eraseBalloon(ctx: CanvasRenderingContext2D, b: OcrBlock): void {
  if (!b.mask) {
    ctx.fillStyle = b.bg ?? '#ffffff';
    ctx.fillRect(b.x, b.y, b.w, b.h);
    return;
  }
  const { w, h, data } = b.mask;
  const stamp = document.createElement('canvas');
  stamp.width = w;
  stamp.height = h;
  const sctx = stamp.getContext('2d')!;
  const img = sctx.createImageData(w, h);
  const [r, g, bl] = (b.bg ?? 'rgb(255,255,255)').match(/\d+/g)?.map(Number) ?? [255, 255, 255];
  for (let p = 0; p < data.length; p++) {
    if (!data[p]) continue;
    img.data[p * 4] = r!;
    img.data[p * 4 + 1] = g!;
    img.data[p * 4 + 2] = bl!;
    img.data[p * 4 + 3] = 255;
  }
  sctx.putImageData(img, 0, 0);
  // a mascara vive na escala da deteccao; ampliar suavizado esconde o serrilhado
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(stamp, b.x, b.y, b.w, b.h);
}

/**
 * Compoe a pagina traduzida: apaga o texto de cada balao e letreira a traducao no
 * mesmo espaco, com a cor de tinta e a caixa (alta/baixa) do original.
 */
export function paintPage(
  canvas: HTMLCanvasElement,
  blocks: OcrBlock[],
  opts: { showOriginal: boolean; font: LetterFont; width: number; height: number },
): void {
  if (canvas.width !== opts.width || canvas.height !== opts.height) {
    canvas.width = opts.width;
    canvas.height = opts.height;
  }
  const ctx = canvas.getContext('2d')!;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (!blocks.length) return;

  const family = FONT_STACK[opts.font];
  for (const b of blocks) {
    const raw = opts.showOriginal ? b.text : b.pt || '';
    if (!raw.trim()) continue;
    const text = b.upper && !opts.showOriginal ? raw.toLocaleUpperCase('pt-BR') : raw;

    eraseBalloon(ctx, b);

    const { lines, size, lineHeight, top } = layoutText(ctx, text, b, family);
    if (!lines.length) continue;

    const bg = b.bg ?? '#ffffff';
    ctx.font = `700 ${size}px ${family}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = inkFor(bg, b.fg ?? '#111111');
    // contorno na cor do balao: come qualquer resto do texto original que o
    // apagamento tenha deixado encostado no glifo
    ctx.strokeStyle = bg;
    ctx.lineWidth = Math.max(size * 0.16, 1);
    ctx.lineJoin = 'round';
    ctx.miterLimit = 2;

    for (const [i, line] of lines.entries()) {
      const y = top + i * lineHeight;
      ctx.strokeText(line.text, line.cx, y);
      ctx.fillText(line.text, line.cx, y);
    }
  }
}
