import { decodeEntities } from './entities.ts';
import type { TextBlock } from './epub.ts';

export interface TextChapter {
  title: string;
  paragraphs: string[];
}

export interface TextBook {
  title?: string;
  author?: string;
  lang?: string;
  description?: string;
  chapters: TextChapter[];
}

/** Livro sem divisao nenhuma vira partes deste tamanho: um capitulo de 4 mil paragrafos travava o leitor. */
export const PART_SIZE = 80;
const MAX_TITLE = 120;

/**
 * "Capitulo 3", "CHAPTER IV", "Parte II", "Livro Primeiro"... O numero e'
 * obrigatorio (algarismo, romano ou ordinal por extenso): sem ele, qualquer
 * frase que comece com "Parte" virava titulo.
 */
const KIND = 'cap[ií]tulo|chapter|chapitre|kapitel|cap[ií]tolo|parte|part|partie|teil|livro|book|livre|buch|canto|ato|act';
const ROMAN = '[ivxlcdm]+';
const WORD = 'primeir[oa]|segund[oa]|terceir[oa]|quart[oa]|quint[oa]|first|second|third|one|two|three|four|five|six|seven|eight|nine|ten';
/** depois do numero: fim da linha, ou um separador e o titulo ("CHAPTER I. Down the Rabbit-Hole") */
const TAIL = '\\s*(?:[.:—–-]\\s*.{0,80})?';
const NUMBERED_RE = new RegExp(`^(?:${KIND})\\s+(?:(?:${ROMAN}|${WORD})(?![\\p{L}\\d])${TAIL}|\\d+(?![\\p{L}\\d])(?:${TAIL}|\\s+.{1,60}))$`, 'iu');
const LONE_RE = /^(?:pr[oó]logo|prologue|ep[ií]logo|epilogue|pref[aá]cio|preface|introdu[cç][aã]o|introduction)\s*\.?$/iu;

export const isHeading = (line: string): boolean => line.length <= MAX_TITLE && (NUMBERED_RE.test(line) || LONE_RE.test(line));

/** UTF-8 quando decodifica limpo; senao Latin-1, que e' o que TXT antigo (Gutenberg "-8.txt") usa. */
export function decodeText(buf: Uint8Array): string {
  const utf8 = new TextDecoder('utf-8').decode(buf);
  const text = utf8.includes('�') ? new TextDecoder('windows-1252').decode(buf) : utf8;
  return text.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
}

/** Sem divisao reconhecivel: fatias de tamanho fixo, para o leitor e a traducao andarem por partes. */
function inParts(paragraphs: string[]): TextChapter[] {
  if (paragraphs.length <= PART_SIZE) return paragraphs.length ? [{ title: 'Texto completo', paragraphs }] : [];
  const out: TextChapter[] = [];
  for (let i = 0; i < paragraphs.length; i += PART_SIZE) {
    out.push({ title: `Parte ${out.length + 1}`, paragraphs: paragraphs.slice(i, i + PART_SIZE) });
  }
  return out;
}

/** Paragrafo = bloco entre linhas em branco; a quebra dura no meio dele e' so' a largura da coluna. */
const paragraphsOf = (text: string): string[] =>
  text
    .split(/\n\s*\n/)
    .map((p) => p.replace(/\s*\n\s*/g, ' ').replace(/\s+/g, ' ').trim())
    .filter(Boolean);

export interface TextItem {
  text: string;
  heading: boolean;
  /** titulo de nivel baixo (`<h5>`, `<h6>`): so' vale como titulo se vier colado em outro */
  minor?: boolean;
}

/**
 * Corta a sequencia de paragrafos em capitulos a cada titulo. Titulos seguidos
 * sao um so': vale o par final ("I" + "Do titulo."), porque o que vem antes
 * dele numa fila de titulos e' folha de rosto (obra, autor, editora, ano).
 */
export function buildChapters(items: TextItem[]): TextChapter[] {
  const chapters: TextChapter[] = [];
  let chain: string[] = [];
  let paragraphs: string[] = [];
  let titled = 0;
  const flush = (): void => {
    if (!paragraphs.length) return;
    const pair = chain.slice(-2);
    const joined = pair.join(' — ');
    if (chain.length) titled++;
    chapters.push({ title: (joined.length <= 90 ? joined : (pair.at(-1) ?? '')).slice(0, MAX_TITLE) || 'Inicio', paragraphs });
    chain = [];
    paragraphs = [];
  };
  for (const item of items) {
    if (item.heading) {
      flush();
      chain.push(item.text);
    } else {
      paragraphs.push(item.text);
    }
  }
  flush();
  // um titulo solto nao e' divisao: livro com "Parte I" numa frase do prefacio nao pode virar 2 capitulos tortos
  return titled >= 2 ? chapters : inParts(chapters.flatMap((c) => c.paragraphs));
}

function splitByHeadings(paragraphs: string[], heading: (p: string) => string | null): TextChapter[] {
  return buildChapters(
    paragraphs.map((p) => {
      const title = heading(p);
      return title ? { text: title, heading: true } : { text: p, heading: false };
    }),
  );
}

export function parseTxt(raw: string): TextBook {
  return { chapters: splitByHeadings(paragraphsOf(raw), (p) => (isHeading(p) ? p : null)) };
}

const stripInline = (s: string): string =>
  s
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__|\*|_|`|~~)/g, '')
    .replace(/^\s*(?:>|[-*+]\s|\d+\.\s)\s*/gm, '')
    .trim();

/** Markdown: `#`/`##` dividem em capitulos; o resto da marcacao some, porque so' o texto vai ao tradutor. */
export function parseMarkdown(raw: string): TextBook {
  // cabecalho colado no paragrafo seguinte (sem linha em branco) ainda e' cabecalho
  const spaced = raw.replace(/^(#{1,6}\s.*)$/gm, '\n$1\n');
  let title: string | undefined;
  const paragraphs = paragraphsOf(spaced);
  // com `##` no arquivo, o primeiro `#` e' o titulo do LIVRO, nao um capitulo: colado no
  // primeiro `##`, ele virava parte do nome do capitulo ("Caderno — Primeira nota")
  const hasSections = paragraphs.some((p) => /^##\s/.test(p));
  const chapters = splitByHeadings(paragraphs, (p) => {
    const m = /^(#{1,2})\s+(.+?)\s*#*$/.exec(p);
    if (!m) return null;
    const text = stripInline(m[2] ?? '');
    if (m[1] === '#' && !title) {
      title = text;
      if (hasSections) return null;
    }
    return text || null;
  }).map((c) => ({
    title: stripInline(c.title.replace(/^#{1,6}\s+/, '')),
    // o `#` que virou titulo do livro nao e' paragrafo do primeiro capitulo
    paragraphs: c.paragraphs.filter((p) => !(hasSections && /^#\s/.test(p) && stripInline(p.replace(/^#\s+/, '')) === title)).map((p) => stripInline(p.replace(/^#{1,6}\s+/, ''))).filter(Boolean),
  }));
  return { title, chapters: chapters.filter((c) => c.paragraphs.length) };
}

const plain = (xml: string): string => decodeEntities(xml.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();

const tag = (xml: string, name: string): string | undefined => {
  const m = new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}>`, 'i').exec(xml);
  return m?.[1];
};

/**
 * FictionBook 2: XML com `<section>` por capitulo, o formato dos acervos russos
 * e do leste europeu. Lido com regex, como o OPF e o ComicInfo — so' meia duzia
 * de campos interessam. Secao aninhada vira capitulo proprio com o titulo dela.
 */
export function parseFb2(raw: string): TextBook {
  const info = tag(raw, 'title-info') ?? '';
  const author = tag(info, 'author');
  const name = author
    ? [tag(author, 'first-name'), tag(author, 'middle-name'), tag(author, 'last-name')].map((p) => (p ? plain(p) : '')).filter(Boolean).join(' ')
    : '';
  const annotation = tag(info, 'annotation');
  // o primeiro <body> e' o texto; os seguintes (name="notes") sao notas de rodape
  const body = /<body\b(?![^>]*\bname\s*=)[^>]*>([\s\S]*?)<\/body>/i.exec(raw)?.[1] ?? tag(raw, 'body') ?? '';

  const chapters: TextChapter[] = [];
  let current: TextChapter | null = null;
  const TOKEN = /<section\b[^>]*>|<\/section>|<title\b[^>]*>([\s\S]*?)<\/title>|<(p|subtitle|v)\b[^>]*>([\s\S]*?)<\/\2>/gi;
  for (const m of body.matchAll(TOKEN)) {
    const token = m[0];
    if (/^<section/i.test(token)) {
      current = null;
    } else if (/^<title/i.test(token)) {
      current = { title: plain(m[1] ?? '').slice(0, MAX_TITLE) || `Capitulo ${chapters.length + 1}`, paragraphs: [] };
      chapters.push(current);
    } else if (m[3] !== undefined) {
      const text = plain(m[3]);
      if (!text) continue;
      if (!current) {
        current = { title: `Capitulo ${chapters.length + 1}`, paragraphs: [] };
        chapters.push(current);
      }
      current.paragraphs.push(text);
    }
  }
  const filled = chapters.filter((c) => c.paragraphs.length);
  const title = tag(info, 'book-title');
  const lang = tag(info, 'lang');
  return {
    title: title ? plain(title) || undefined : undefined,
    author: name || undefined,
    lang: lang ? plain(lang).toLowerCase() || undefined : undefined,
    description: annotation ? plain(annotation).slice(0, 900) || undefined : undefined,
    chapters: filled.length === 1 && filled[0]!.paragraphs.length > PART_SIZE ? inParts(filled[0]!.paragraphs) : filled,
  };
}

export type TextFormat = 'txt' | 'md' | 'fb2';

export const textFormatOf = (path: string): TextFormat | null => {
  const ext = /\.([a-z0-9]+)$/i.exec(path)?.[1]?.toLowerCase();
  if (ext === 'txt') return 'txt';
  if (ext === 'md' || ext === 'markdown') return 'md';
  if (ext === 'fb2') return 'fb2';
  return null;
};

/** Livro de texto ja' aberto, carimbado por mtime+tamanho: a lista de capitulos e cada capitulo releem o mesmo arquivo. */
const opened = new Map<string, { stamp: string; book: TextBook }>();
const MAX_OPEN = 4;
/** Texto puro acima disto nao e' livro, e' despejo de log: ler inteiro para a memoria derrubaria o sidecar. */
export const MAX_TEXT_BYTES = 40_000_000;

export async function readTextBook(path: string): Promise<TextBook> {
  const format = textFormatOf(path);
  if (!format) throw new Error('formato de texto nao suportado');
  const file = Bun.file(path);
  if (file.size > MAX_TEXT_BYTES) throw new Error('arquivo de texto grande demais para abrir como livro');
  const stamp = `${file.size}:${file.lastModified}`;
  const hit = opened.get(path);
  if (hit?.stamp === stamp) return hit.book;
  const raw = decodeText(new Uint8Array(await file.arrayBuffer()));
  const book = format === 'fb2' ? parseFb2(raw) : format === 'md' ? parseMarkdown(raw) : parseTxt(raw);
  opened.delete(path);
  opened.set(path, { stamp, book });
  while (opened.size > MAX_OPEN) opened.delete(opened.keys().next().value as string);
  return book;
}

export const chapterBlocks = (chapter: TextChapter | undefined): TextBlock[] =>
  (chapter?.paragraphs ?? []).map((text, id) => ({ id, text }));

/**
 * Paragrafos a partir das linhas de uma pagina de PDF. O PDF so' guarda linhas
 * posicionadas: paragrafo novo e' a linha que comeca depois de uma que terminou
 * frase E ficou curta (nao encheu a coluna). Hifen de fim de linha e' desfeito.
 */
export function linesToParagraphs(lines: string[]): string[] {
  const clean = lines.map((l) => l.replace(/\s+/g, ' ').trim());
  const widest = Math.max(0, ...clean.map((l) => l.length));
  const out: string[] = [];
  let current = '';
  for (const line of clean) {
    if (!line) {
      if (current) out.push(current);
      current = '';
      continue;
    }
    const opens = !current;
    current = current ? (/\p{L}-$/u.test(current) ? current.slice(0, -1) + line : `${current} ${line}`) : line;
    // fecha em fim de frase numa linha que nao encheu a coluna; linha curta que ABRE um
    // paragrafo e nao termina em virgula e' titulo ("Parte 1"), e fica sozinha
    const endsSentence = /[.!?…:"”»)]$/.test(line) && line.length < widest * 0.85;
    const heading = opens && line.length < widest * 0.5 && !/[,;]$/.test(line);
    if (endsSentence || heading) {
      out.push(current);
      current = '';
    }
  }
  if (current) out.push(current);
  return out;
}

export interface PdfSection {
  title: string;
  /** primeira pagina (base 0) */
  first: number;
  /** pagina seguinte a ultima (exclusivo) */
  end: number;
}

/**
 * Capitulos de um PDF de texto. Com sumario de verdade (2+ marcadores), cada
 * marcador vai ate' o seguinte; o que vem antes do primeiro vira "Inicio", e
 * secao maior que `maxPages` e' fatiada (um capitulo de 200 paginas travava o
 * leitor e mandava tudo de uma vez ao tradutor). Sem sumario, blocos de `chunk` paginas.
 */
export function pdfSections(outline: { title: string; page: number }[], total: number, chunk = 10, maxPages = 30): PdfSection[] {
  const seen = new Set<number>();
  const marks = outline
    .filter((o) => Number.isInteger(o.page) && o.page >= 0 && o.page < total && o.title.trim())
    .sort((a, b) => a.page - b.page)
    // dois marcadores na mesma pagina: vale o primeiro, senao um dos dois seria capitulo vazio
    .filter((o) => !seen.has(o.page) && seen.add(o.page));
  const blocks = (title: (first: number, end: number) => string, first: number, end: number, size: number): PdfSection[] => {
    const out: PdfSection[] = [];
    for (let at = first; at < end; at += size) out.push({ title: title(at, Math.min(end, at + size)), first: at, end: Math.min(end, at + size) });
    return out;
  };
  const pages = (first: number, end: number): string => (end - first > 1 ? `Paginas ${first + 1}–${end}` : `Pagina ${first + 1}`);
  if (marks.length < 2) return blocks(pages, 0, total, chunk);

  const out: PdfSection[] = [];
  if (marks[0]!.page > 0) out.push({ title: 'Inicio', first: 0, end: marks[0]!.page });
  marks.forEach((mark, i) => {
    const end = marks[i + 1]?.page ?? total;
    const title = mark.title.slice(0, MAX_TITLE);
    if (end - mark.page <= maxPages) {
      out.push({ title, first: mark.page, end });
      return;
    }
    const parts = Math.ceil((end - mark.page) / maxPages);
    let n = 0;
    out.push(...blocks(() => `${title} (${++n}/${parts})`, mark.page, end, maxPages));
  });
  return out;
}

/** `first-end` no id do capitulo; o formato antigo (so' a pagina inicial) continua valendo, com `chunk` paginas. */
export function parsePdfRange(token: string, total: number, chunk = 10): { first: number; end: number } | null {
  const m = /^(\d{1,6})(?:-(\d{1,6}))?$/.exec(token);
  if (!m) return null;
  const first = Number(m[1]);
  const end = m[2] === undefined ? first + chunk : Number(m[2]);
  // teto: id forjado com "0-999999" nao pode mandar extrair o PDF inteiro de uma vez
  if (first >= total || end <= first || end - first > 60) return null;
  return { first, end: Math.min(end, total) };
}
