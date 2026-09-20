import { readZipEntry, readZipIndex, type ZipEntry } from './zip.ts';

export interface EpubChapterRef {
  /** caminho da entrada dentro do zip, ja' resolvido a partir do OPF */
  href: string;
  title?: string;
}

export interface EpubInfo {
  title?: string;
  author?: string;
  lang?: string;
  /** entrada da capa dentro do zip, quando o OPF declara */
  cover?: string;
  spine: EpubChapterRef[];
}

export interface TextBlock {
  id: number;
  text: string;
}

const CONTAINER = 'META-INF/container.xml';

const decodeEntities = (s: string): string =>
  s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;|&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, '&');

const attr = (tag: string, name: string): string | undefined =>
  // dentro de template literal uma barra so' nao vira escape de regex: `\s`
  // virava um 's' literal, e o atributo com espaco em volta do '=' nao casava
  new RegExp(`${name}\\s*=\\s*"([^"]*)"|${name}\\s*=\\s*'([^']*)'`, 'i').exec(tag)?.slice(1).find(Boolean);

/** Resolve o href do manifesto contra a pasta do OPF (ex. "OEBPS/" + "text/c1.xhtml"). */
function resolveHref(opfPath: string, href: string): string {
  const base = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/') + 1) : '';
  const parts = (base + decodeURIComponent(href.split('#')[0] ?? '')).split('/');
  const out: string[] = [];
  for (const p of parts) {
    if (p === '.' || p === '') continue;
    if (p === '..') out.pop();
    else out.push(p);
  }
  return out.join('/');
}

const findEntry = (entries: ZipEntry[], path: string): ZipEntry | undefined =>
  entries.find((e) => e.name === path) ?? entries.find((e) => e.name.toLowerCase() === path.toLowerCase());

async function text(path: string, entries: ZipEntry[], name: string): Promise<string> {
  const entry = findEntry(entries, name);
  if (!entry) throw new Error(`EPUB sem "${name}"`);
  return (await readZipEntry(path, entry)).toString('utf8');
}

/**
 * EPUB e' um ZIP com um OPF dentro: `container.xml` diz onde o OPF esta', o OPF
 * lista os arquivos e a ORDEM de leitura (o spine). Le com o zip.ts daqui e um
 * punhado de regex — o mesmo criterio do ComicInfo: um parser de XML completo
 * custaria mais que os campos que se le.
 */
export async function readEpub(path: string): Promise<EpubInfo> {
  const entries = await readZipIndex(path);
  const container = await text(path, entries, CONTAINER);
  const opfPath = attr(/<rootfile\b[^>]*>/i.exec(container)?.[0] ?? '', 'full-path');
  if (!opfPath) throw new Error('EPUB sem rootfile no container.xml');
  const opf = await text(path, entries, opfPath);

  const meta = (tag: string): string | undefined => {
    const m = new RegExp(`<(?:dc:)?${tag}(?:\\s[^>]*)?>([^<]*)</(?:dc:)?${tag}>`, 'i').exec(opf);
    return m?.[1] ? decodeEntities(m[1]).trim() || undefined : undefined;
  };

  // manifesto: id -> href resolvido
  const manifest = new Map<string, { href: string; type: string; properties: string }>();
  for (const tag of opf.match(/<item\b[^>]*\/?>/gi) ?? []) {
    const id = attr(tag, 'id');
    const href = attr(tag, 'href');
    if (id && href) {
      manifest.set(id, { href: resolveHref(opfPath, href), type: attr(tag, 'media-type') ?? '', properties: attr(tag, 'properties') ?? '' });
    }
  }

  const spine: EpubChapterRef[] = [];
  const spineTag = /<spine\b[^>]*>([\s\S]*?)<\/spine>/i.exec(opf)?.[1] ?? '';
  for (const tag of spineTag.match(/<itemref\b[^>]*\/?>/gi) ?? []) {
    const item = manifest.get(attr(tag, 'idref') ?? '');
    // `linear="no"` e' material fora do fio principal (notas, propaganda da editora)
    if (item && attr(tag, 'linear') !== 'no') spine.push({ href: item.href });
  }

  const cover =
    [...manifest.values()].find((i) => i.properties.includes('cover-image'))?.href ??
    manifest.get(attr(/<meta\b[^>]*name\s*=\s*["']cover["'][^>]*>/i.exec(opf)?.[0] ?? '', 'content') ?? '')?.href;

  return { title: meta('title'), author: meta('creator'), lang: meta('language')?.toLowerCase(), cover, spine };
}

const STRIP = /<(script|style|head)\b[^>]*>[\s\S]*?<\/\1>/gi;
/** tags que terminam um paragrafo: sem isto o capitulo inteiro virava um bloco so' */
const BREAK = /<\/?(p|div|br|li|h[1-6]|blockquote|tr|section|article)\b[^>]*>/gi;

/**
 * Paragrafos do capitulo. Bloco e' a unidade que vai ao tradutor — a mesma que o
 * OCR produz para um balao — entao o texto volta casado por id e o leitor troca
 * paragrafo por paragrafo.
 */
export function xhtmlToBlocks(xhtml: string): TextBlock[] {
  const body = /<body\b[^>]*>([\s\S]*)<\/body>/i.exec(xhtml)?.[1] ?? xhtml;
  return body
    .replace(STRIP, ' ')
    .replace(BREAK, '\n')
    .replace(/<[^>]+>/g, '')
    .split('\n')
    .map((line) => decodeEntities(line).replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .map((text, id) => ({ id, text }));
}

export async function readEpubChapter(path: string, href: string): Promise<TextBlock[]> {
  const entries = await readZipIndex(path);
  return xhtmlToBlocks(await text(path, entries, href));
}
