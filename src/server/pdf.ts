import { stat } from 'node:fs/promises';
import { encodePng } from './png.ts';

/** pdf.js so' e' carregado quando um PDF e' aberto de verdade (~1 MB de modulo). */
type PdfjsModule = typeof import('pdfjs-dist/legacy/build/pdf.mjs');
let pdfjs: PdfjsModule | null = null;
async function lib(): Promise<PdfjsModule> {
  pdfjs ??= await import('pdfjs-dist/legacy/build/pdf.mjs');
  return pdfjs;
}

/** Objeto do pdf.js que o store devolve para uma imagem desenhada na pagina. */
interface PdfImage {
  width: number;
  height: number;
  kind?: number;
  data?: Uint8Array;
}

/** Deposito de objetos do pdf.js: resolve por callback, nao por promise. */
interface PdfObjs {
  has?(name: string): boolean;
  get(name: string, cb: (value: PdfImage | null) => void): void;
}

/**
 * A fatia do pdf.js que este modulo usa. O pacote nao publica tipo para ela, e
 * declarar so' o necessario deixa o compilador cobrar cada campo — com `any`
 * um `getOperatorList` renomeado numa versao nova passaria batido.
 */
interface PdfPage {
  getOperatorList(): Promise<{ fnArray: number[]; argsArray: unknown[][] }>;
  getTextContent(): Promise<{ items: { str?: string }[] }>;
  objs?: PdfObjs;
  commonObjs?: PdfObjs;
}

interface Doc {
  numPages: number;
  getPage(n: number): Promise<PdfPage>;
  destroy(): Promise<void>;
}

/**
 * Um documento aberto por vez, carimbado por mtime+tamanho — mesma regra do CBR:
 * a leitura e' sequencial dentro do mesmo arquivo e manter varios PDFs abertos
 * seguraria o buffer de cada um.
 */
let open: { path: string; mtimeMs: number; size: number; doc: Doc } | null = null;

async function document(path: string): Promise<Doc> {
  const st = await stat(path);
  if (open && open.path === path && open.mtimeMs === st.mtimeMs && open.size === st.size) return open.doc;
  await open?.doc.destroy().catch(() => undefined);
  const { getDocument } = await lib();
  const data = new Uint8Array(await Bun.file(path).arrayBuffer());
  // sem fonte do sistema e sem converter fonte embutida: o PDF e' arquivo de
  // terceiro e aqui so' se extrai pixel e texto — nada precisa ser renderizado
  const doc = (await getDocument({ data, useSystemFonts: false, disableFontFace: true }).promise) as unknown as Doc;
  open = { path, mtimeMs: st.mtimeMs, size: st.size, doc };
  return doc;
}

export async function pdfPageCount(path: string): Promise<number> {
  return (await document(path)).numPages;
}

/** Imagens desenhadas na pagina, da maior para a menor. */
async function imagesOf(page: PdfPage): Promise<string[]> {
  const { OPS } = await lib();
  const ops = await page.getOperatorList();
  const names: string[] = [];
  for (let i = 0; i < ops.fnArray.length; i++) {
    if (ops.fnArray[i] === OPS.paintImageXObject) {
      const name = ops.argsArray[i]?.[0];
      if (typeof name === 'string' && !names.includes(name)) names.push(name);
    }
  }
  return names;
}

/** `objs` resolve por callback; imagem grande as vezes mora no `commonObjs`. */
function resolveImage(page: PdfPage, name: string): Promise<PdfImage | null> {
  const store = page.objs?.has?.(name) ? page.objs : page.commonObjs?.has?.(name) ? page.commonObjs : page.objs;
  // com `any` isto passava batido: pagina sem nenhum objeto desenhado nao tem
  // `objs`, e o `.get` estourava dentro da Promise
  if (!store) return Promise.resolve(null);
  return new Promise((resolve) => {
    try {
      store.get(name, resolve);
    } catch {
      resolve(null);
    }
  });
}

/** 1 = cinza empacotado em bits, 2 = RGB, 3 = RGBA (ImageKind do pdf.js). */
function toPixels(img: { width: number; height: number; kind?: number; data?: Uint8Array }): { channels: 1 | 3 | 4; pixels: Uint8Array } | null {
  const data = img.data;
  if (!data) return null;
  if (img.kind === 3 || data.length === img.width * img.height * 4) return { channels: 4, pixels: data };
  if (img.kind === 2 || data.length === img.width * img.height * 3) return { channels: 3, pixels: data };
  if (img.kind === 1) {
    // 1 bit por pixel, MSB primeiro, 0 = preto: expande para 8 bits
    const out = new Uint8Array(img.width * img.height);
    const rowBytes = (img.width + 7) >> 3;
    for (let y = 0; y < img.height; y++) {
      for (let x = 0; x < img.width; x++) {
        const byte = data[y * rowBytes + (x >> 3)] ?? 0;
        out[y * img.width + x] = (byte >> (7 - (x & 7))) & 1 ? 255 : 0;
      }
    }
    return { channels: 1, pixels: out };
  }
  return null;
}

/**
 * A pagina como imagem PNG, extraindo o bitmap que o PDF ja' carrega — sem
 * rasterizar. Cobre o caso que importa aqui: PDF que e' scan de HQ/livro, uma
 * imagem por pagina, que e' exatamente o que precisa de OCR. `null` quando a
 * pagina e' texto nativo (nada a extrair): ai' ela nao tem imagem nenhuma.
 */
export async function pdfPageImage(path: string, index: number): Promise<Uint8Array<ArrayBuffer> | null> {
  const doc = await document(path);
  if (index < 0 || index >= doc.numPages) return null;
  const page = await doc.getPage(index + 1);
  let best: { channels: 1 | 3 | 4; pixels: Uint8Array; w: number; h: number } | null = null;
  for (const name of await imagesOf(page)) {
    const img = await resolveImage(page, name);
    if (!img?.width || !img?.height) continue;
    const px = toPixels(img);
    if (!px) continue;
    // a maior imagem e' a pagina; as menores sao logotipo, selo, ornamento
    if (!best || img.width * img.height > best.w * best.h) best = { ...px, w: img.width, h: img.height };
  }
  if (!best) return null;
  return encodePng(best.w, best.h, best.channels, best.pixels);
}

/** Texto nativo da pagina, quando o PDF nao e' scan. */
export async function pdfPageText(path: string, index: number): Promise<string> {
  const doc = await document(path);
  if (index < 0 || index >= doc.numPages) return '';
  const page = await doc.getPage(index + 1);
  const content = await page.getTextContent();
  return (content.items as { str?: string; hasEOL?: boolean }[])
    .map((i) => (i.str ?? '') + (i.hasEOL ? '\n' : ''))
    .join('')
    .trim();
}
