import { readZipEntry, readZipIndex, type ZipEntry } from './zip.ts';
import { buildChapters, isHeading, type TextBook, type TextItem } from './text-book.ts';

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
  /** sinopse do OPF (`dc:description`), sem marcacao */
  description?: string;
  subjects?: string[];
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

/** `%` solto no href (arquivo "100%.xhtml") derrubava o decodeURIComponent e o livro inteiro. */
const safeDecode = (s: string): string => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

/** Resolve o href do manifesto contra a pasta do OPF (ex. "OEBPS/" + "text/c1.xhtml"). */
function resolveHref(opfPath: string, href: string): string {
  const base = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/') + 1) : '';
  const parts = (base + safeDecode(href.split('#')[0] ?? '')).split('/');
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

  // sumario: o `nav` do EPUB 3 ou o NCX do EPUB 2 — sem ele todo capitulo era "Capitulo N"
  const items = [...manifest.values()];
  const navItem = items.find((i) => /\bnav\b/.test(i.properties)) ?? items.find((i) => i.type === 'application/x-dtbncx+xml');
  if (navItem) {
    const titles = await text(path, entries, navItem.href)
      .then((doc) => tocTitles(doc, navItem.href))
      .catch(() => new Map<string, string>());
    for (const ref of spine) ref.title = titles.get(ref.href);
  }

  const description = stripTags(
    decodeEntities(/<(?:dc:)?description(?:\s[^>]*)?>([\s\S]*?)<\/(?:dc:)?description>/i.exec(opf)?.[1] ?? ''),
  ).slice(0, 900);
  const subjects = [...opf.matchAll(/<(?:dc:)?subject(?:\s[^>]*)?>([^<]*)<\/(?:dc:)?subject>/gi)]
    .map((m) => decodeEntities(m[1] ?? '').trim())
    .filter(Boolean)
    .slice(0, 8);

  return {
    title: meta('title'),
    author: meta('creator'),
    lang: meta('language')?.toLowerCase(),
    cover,
    ...(description ? { description } : {}),
    ...(subjects.length ? { subjects } : {}),
    spine,
  };
}

const stripTags = (s: string): string => s.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

/**
 * Titulo de cada arquivo do sumario. O mesmo arquivo pode ter varias entradas
 * (ancoras `#sec2`): vale a primeira, que e' a que abre o arquivo.
 */
export function tocTitles(doc: string, docPath: string): Map<string, string> {
  const out = new Map<string, string>();
  const put = (href: string | undefined, raw: string): void => {
    const title = stripTags(decodeEntities(raw)).slice(0, 120);
    if (!href || !title) return;
    const target = resolveHref(docPath, href);
    if (!out.has(target)) out.set(target, title);
  };
  // NCX (EPUB 2): <navPoint><navLabel><text>Titulo</text></navLabel><content src="c1.xhtml"/>
  for (const m of doc.matchAll(/<navLabel\b[^>]*>\s*<text\b[^>]*>([\s\S]*?)<\/text>\s*<\/navLabel>\s*(<content\b[^>]*>)/gi)) {
    put(attr(m[2] ?? '', 'src'), m[1] ?? '');
  }
  if (out.size) return out;
  // nav (EPUB 3): so' a lista marcada como `toc` — o mesmo arquivo traz `landmarks` e `page-list`
  const toc = /<nav\b[^>]*\btype\s*=\s*["'][^"']*\btoc\b[^"']*["'][^>]*>([\s\S]*?)<\/nav>/i.exec(doc)?.[1] ?? doc;
  for (const m of toc.matchAll(/(<a\b[^>]*>)([\s\S]*?)<\/a>/gi)) put(attr(m[1] ?? '', 'href'), m[2] ?? '');
  return out;
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
    // a quebra de linha do ARQUIVO nao e' paragrafo: HTML antigo vem com coluna de 70 e cada linha virava um bloco
    .replace(/\s+/g, ' ')
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

const HEADING = /<h[1-3]\b[^>]*>([\s\S]*?)<\/h[1-3]>/i;

/**
 * Capitulos legiveis do livro: o spine sem os arquivos que nao tem texto (capa
 * em imagem, folha de rosto vazia) e com titulo de verdade — o do sumario, ou o
 * primeiro cabecalho do arquivo. EPUB do Project Gutenberg abre com dois ou
 * tres arquivos so' de imagem, e eles viravam "capitulo sem texto" na lista.
 */
export async function epubChapters(path: string, info: EpubInfo): Promise<EpubChapterRef[]> {
  const entries = await readZipIndex(path);
  const out: EpubChapterRef[] = [];
  for (const ref of info.spine) {
    const doc = await text(path, entries, ref.href).catch(() => '');
    if (!xhtmlToBlocks(doc).length) continue;
    const heading = stripTags(decodeEntities(HEADING.exec(doc)?.[1] ?? '')).slice(0, 120);
    out.push({ href: ref.href, title: ref.title ?? (heading || undefined) });
  }
  return out;
}

/** marca de titulo que sobrevive a retirada das tags (caractere de controle nao existe em texto de livro) */
const MARK = '\u0001';

/** titulo de nivel baixo: `<h5>`/`<h6>` tanto numeram capitulo ("I") quanto enfeitam carta e poema */
const MINOR = '\u0002';

/** Como `xhtmlToBlocks`, mas dizendo quais linhas eram titulo (`<h1>`..`<h6>`). */
export function xhtmlToItems(xhtml: string): TextItem[] {
  const body = /<body\b[^>]*>([\s\S]*)<\/body>/i.exec(xhtml)?.[1] ?? xhtml;
  const items = body
    .replace(STRIP, ' ')
    .replace(/\s+/g, ' ')
    .replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_, level: string, inner: string) => `\n${Number(level) >= 5 ? MINOR : MARK}${inner.replace(BREAK, ' ')}\n`)
    .replace(BREAK, '\n')
    .replace(/<[^>]+>/g, '')
    .split('\n')
    .map((line): TextItem => {
      const minor = line.includes(MINOR);
      const heading = minor || line.includes(MARK);
      return { text: decodeEntities(line.replaceAll(MARK, '').replaceAll(MINOR, '')).replace(/\s+/g, ' ').trim(), heading, ...(minor ? { minor } : {}) };
    })
    .filter((item) => item.text);
  // titulo menor so' abre capitulo colado em outro titulo; sozinho antes de um paragrafo e' texto
  return items.map((item, i) => (item.minor && !items[i + 1]?.heading ? { text: item.text, heading: false } : item));
}

/** Cabecalho e licenca que o Project Gutenberg cola em todo livro: nao e' texto da obra. */
const PG_START = /\*\*\*\s*START OF (?:THE|THIS) PROJECT GUTENBERG|\*END\*?\s*THE SMALL PRINT/i;
const PG_END = /\*\*\*\s*END OF (?:THE|THIS) PROJECT GUTENBERG|^End of (?:the )?Project Gutenberg/i;

export function stripGutenbergBoilerplate(items: TextItem[]): TextItem[] {
  // o marcador de inicio so' vale no comeco, e o de fim so' no final: citado no meio do livro nao corta nada
  const head = items.slice(0, 120).findLastIndex((i) => PG_START.test(i.text));
  const from = head + 1;
  const tailStart = Math.max(from, items.length - 400);
  const tail = items.slice(tailStart).findIndex((i) => PG_END.test(i.text));
  return items.slice(from, tail < 0 ? items.length : tailStart + tail);
}

/**
 * O livro inteiro como capitulos de paragrafos, cortado pelos TITULOS e nao
 * pelos arquivos do spine. EPUB gerado em lote (o do Gutenberg) parte o texto
 * por tamanho — 8 arquivos para 148 capitulos — ou em um arquivo por paragrafo;
 * nos dois casos a lista de arquivos nao e' a lista de capitulos.
 */
export async function epubToTextBook(path: string, info: EpubInfo, opts: { gutenberg?: boolean } = {}): Promise<TextBook> {
  const entries = await readZipIndex(path);
  let items: TextItem[] = [];
  for (const ref of info.spine) {
    const doc = await text(path, entries, ref.href).catch(() => '');
    items.push(...xhtmlToItems(doc));
  }
  if (opts.gutenberg) items = stripGutenbergBoilerplate(items);
  // edicao antiga sem marcacao: "CHAPTER I" e' so' um paragrafo curto
  if (!items.some((i) => i.heading)) items = items.map((i) => ({ ...i, heading: isHeading(i.text) }));
  return { title: info.title, author: info.author, lang: info.lang, description: info.description, chapters: buildChapters(items) };
}
