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

interface OutlineItem {
  title?: string;
  dest?: string | unknown[] | null;
  items?: OutlineItem[];
}

interface Doc {
  numPages: number;
  getPage(n: number): Promise<PdfPage>;
  getOutline(): Promise<OutlineItem[] | null>;
  getDestination(name: string): Promise<unknown[] | null>;
  getPageIndex(ref: unknown): Promise<number>;
  getMetadata(): Promise<{ info?: { Title?: unknown; Author?: unknown; Language?: unknown } }>;
}

/**
 * Um documento aberto por vez, carimbado por mtime+tamanho — mesma regra do CBR:
 * a leitura e' sequencial dentro do mesmo arquivo e manter varios PDFs abertos
 * seguraria o buffer de cada um.
 */
let open: { path: string; mtimeMs: number; size: number; doc: Doc; close: () => Promise<void> } | null = null;

async function document(path: string): Promise<Doc> {
  const st = await stat(path);
  if (open && open.path === path && open.mtimeMs === st.mtimeMs && open.size === st.size) return open.doc;
  // quem se fecha e' a TAREFA de carga: no pdf.js 6 o documento nao tem `destroy`, e
  // chama-lo ali estourava ao trocar de arquivo — o segundo PDF da sessao nunca abria
  await open?.close().catch(() => undefined);
  open = null;
  const { getDocument } = await lib();
  const data = new Uint8Array(await Bun.file(path).arrayBuffer());
  // sem fonte do sistema e sem converter fonte embutida: o PDF e' arquivo de
  // terceiro e aqui so' se extrai pixel e texto — nada precisa ser renderizado
  const task = getDocument({ data, useSystemFonts: false, disableFontFace: true });
  const doc = (await task.promise) as unknown as Doc;
  open = { path, mtimeMs: st.mtimeMs, size: st.size, doc, close: () => task.destroy() };
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

/** Linhas de texto nativo da pagina, na ordem do PDF. */
export async function pdfPageLines(path: string, index: number): Promise<string[]> {
  return (await pdfPageText(path, index)).split('\n');
}

/**
 * PDF de TEXTO (livro exportado, artigo) x PDF escaneado. O escaneado tem um
 * bitmap por pagina e vai ao leitor de paginas com OCR; o de texto nao tem
 * imagem nenhuma para extrair e abre no leitor de livro. Amostra ate' 5 paginas
 * espalhadas: capa ilustrada ou figura isolada nao podem decidir pelo livro todo.
 */
export async function pdfIsText(path: string): Promise<boolean> {
  const doc = await document(path);
  const total = doc.numPages;
  const sample = [...new Set(Array.from({ length: Math.min(5, total) }, (_, i) => Math.floor((i * (total - 1)) / Math.max(1, Math.min(5, total) - 1))))];
  let textual = 0;
  for (const index of sample) {
    const page = await doc.getPage(index + 1);
    const hasImage = (await imagesOf(page)).length > 0;
    const chars = (await page.getTextContent()).items.reduce((n, i) => n + (i.str?.trim().length ?? 0), 0);
    if (!hasImage && chars >= 80) textual++;
  }
  return textual * 2 > sample.length;
}

/**
 * Sumario do PDF (marcadores) como `{titulo, pagina}`, na ordem do documento. So'
 * o primeiro nivel — e, quando ele e' um item so' (o titulo do livro), o nivel de
 * baixo. Destino que nao resolve para uma pagina e' ignorado: sumario quebrado nao
 * pode impedir o livro de abrir.
 */
export async function pdfOutline(path: string): Promise<{ title: string; page: number }[]> {
  const doc = await document(path);
  let items = (await doc.getOutline().catch(() => null)) ?? [];
  if (items.length === 1 && items[0]?.items?.length) items = items[0].items;
  const out: { title: string; page: number }[] = [];
  for (const item of items.slice(0, 500)) {
    try {
      const dest = typeof item.dest === 'string' ? await doc.getDestination(item.dest) : item.dest;
      if (!Array.isArray(dest) || dest[0] === undefined) continue;
      // destino por numero de pagina direto (raro) ou por referencia ao objeto da pagina (o comum)
      const page = typeof dest[0] === 'number' ? dest[0] : await doc.getPageIndex(dest[0]);
      const title = (item.title ?? '').replace(/\s+/g, ' ').trim();
      if (title && Number.isInteger(page)) out.push({ title, page });
    } catch {
      /* marcador com destino invalido: fica de fora */
    }
  }
  return out;
}

/** Titulo, autor e idioma que o PDF declara nos metadados, quando declara. */
export async function pdfInfo(path: string): Promise<{ title?: string; author?: string; lang?: string }> {
  const { info } = await (await document(path)).getMetadata().catch(() => ({ info: undefined }));
  const text = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.replace(/\s+/g, ' ').trim().slice(0, 200) : undefined);
  const title = text(info?.Title);
  return { title: title && !junkTitle(title) ? title : undefined, author: text(info?.Author), lang: text(info?.Language)?.toLowerCase() };
}

/**
 * Titulo que o programa que gerou o PDF carimbou, nao o do livro: "about:blank"
 * (navegador), "Microsoft Word - cap1.docx", "Untitled". Com ele o nome do
 * arquivo — que quem guardou o PDF escolheu — e' bem melhor.
 */
export const junkTitle = (title: string): boolean =>
  /^(about:blank|untitled\d*|sem t[ií]tulo|document\d*|documento\d*|title|titulo|título)$/i.test(title) ||
  /^microsoft (word|powerpoint|excel)\b/i.test(title) ||
  /\.(docx?|odt|rtf|pdf|indd|tex|pages|html?)$/i.test(title);
