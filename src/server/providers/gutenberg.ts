import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { cached, defaultTtl } from '../cache.ts';
import { config, registerImageHost } from '../config.ts';
import { epubToTextBook, readEpub, type TextBlock } from '../epub.ts';
import { chapterBlocks, type TextBook } from '../text-book.ts';
import { httpFetch } from '../http.ts';
import type { ChapterRef, Provider, SearchFilters, SeriesCard, SeriesDetail } from './types.ts';

const BASE = 'https://archive.org';
/**
 * O espelho do Project Gutenberg no Internet Archive. Diferente da colecao
 * `comics` (deposito aberto, que exige a lista curada do archive.ts), esta e'
 * fechada: so' entra o que o proprio Gutenberg publicou, e o Gutenberg so'
 * publica obra em dominio publico nos EUA. `format:EPUB` porque e' o EPUB que
 * o leitor de livro abre — ~37 mil dos ~56 mil titulos tem.
 */
const SCOPE = 'collection:gutenberg AND mediatype:texts AND format:EPUB';

/**
 * O acervo tem literatura erotica vitoriana, e ela lidera o ranking de downloads
 * do espelho: sem este corte, a estante inicial abria com ela. So' aparece para
 * quem marca a classificacao adulta no filtro, como nas fontes de manga.
 */
const ADULT_SUBJECTS = 'subject:(erotic* OR pornograph*)';
const ADULT_RE = /erotic|pornograph/i;
const ADULT_RATINGS = ['erotica', 'pornographic'];
/** Sem busca, a estante mostra literatura; manual de torno e catalogo de pecas so' aparecem se procurados. */
const SHELF = 'subject:(fiction OR stories OR tales OR poetry OR drama OR novela OR romance)';

/** O campo `language` do Archive nao e' normalizado: o mesmo idioma aparece como "por", "pt" e "Portuguese". */
const LANGUAGE_ALIASES: Record<string, string[]> = {
  en: ['eng', 'en', 'English'],
  pt: ['por', 'pt', 'Portuguese'],
  es: ['spa', 'es', 'Spanish'],
  fr: ['fre', 'fra', 'fr', 'French'],
  de: ['ger', 'deu', 'de', 'German'],
  it: ['ita', 'it', 'Italian'],
  nl: ['dut', 'nld', 'nl', 'Dutch'],
  fi: ['fin', 'fi', 'Finnish'],
  ja: ['jpn', 'ja', 'Japanese'],
  zh: ['chi', 'zho', 'zh', 'Chinese'],
  la: ['lat', 'la', 'Latin'],
};

/** "pt-br" e "pt" sao o mesmo acervo aqui: o Gutenberg nao separa variante. */
const baseLang = (code: string): string => code.trim().toLowerCase().split('-')[0] ?? '';

export function normalizeLanguage(raw: string | undefined): string {
  const value = (raw ?? '').trim().toLowerCase();
  if (!value) return 'unknown';
  for (const [code, aliases] of Object.entries(LANGUAGE_ALIASES)) {
    if (aliases.some((a) => a.toLowerCase() === value)) return code;
  }
  return value.length === 2 ? value : 'unknown';
}

interface SearchDoc {
  identifier: string;
  title?: string | string[];
  creator?: string | string[];
  language?: string | string[];
  subject?: string | string[];
}

const one = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : (v ?? undefined));
const listOf = (v: string | string[] | undefined): string[] => (Array.isArray(v) ? v : v ? [v] : []);

/** "Stoker, Bram, 1847-1912" -> "Bram Stoker": o catalogo do Gutenberg guarda sobrenome primeiro e as datas. */
export function authorName(raw: string): string {
  const clean = raw.replace(/\[[^\]]*\]/g, '').replace(/,?\s*\d{3,4}\??\s*-\s*(?:\d{3,4}\??)?\s*$/, '').replace(/\s*\(.*?\)\s*/g, ' ').trim();
  const [last, ...rest] = clean.split(',').map((p) => p.trim()).filter(Boolean);
  return rest.length ? `${rest.join(' ')} ${last}` : (last ?? '');
}

/** O Archive indexa por palavra solta; aspas viram busca de frase e derrubam o recall. */
const escapeQuery = (q: string): string => q.replace(/[:"()[\]{}~^\\/!*?+&|-]/g, ' ').replace(/\s+/g, ' ').trim();

const cardOf = (doc: SearchDoc): SeriesCard => {
  const authors = listOf(doc.creator).map(authorName).filter(Boolean);
  return {
    id: doc.identifier,
    provider: 'gutenberg',
    title: one(doc.title) ?? doc.identifier,
    // sem capa na busca: a miniatura do Archive para quase todo item daqui e' o logotipo
    // generico do site. O card desenha uma capa tipografica; a capa real entra no detalhe.
    authors,
    contentType: 'livro',
    type: 'book',
    origin: normalizeLanguage(one(doc.language)),
    status: 'completed',
    contentRating: listOf(doc.subject).some((s) => ADULT_RE.test(s)) ? 'erotica' : 'safe',
    // classe da Library of Congress ("PR", "PQ") nao diz nada para quem le
    tags: listOf(doc.subject).filter((s) => s.length > 2).slice(0, 8),
    description: authors.length ? `De ${authors.join(', ')}. Dominio publico — Project Gutenberg.` : 'Dominio publico — Project Gutenberg.',
    url: `${BASE}/details/${doc.identifier}`,
  };
};

async function getJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const res = await httpFetch(url, { accept: 'application/json', timeoutMs: 20_000, retries: 2, signal });
  if (!res.ok) throw new Error(`upstream ${res.status} em archive.org`);
  return (await res.json()) as T;
}

export function searchQuery(f: SearchFilters): string {
  const parts = [SCOPE];
  // prefixo em cada palavra: o indice guarda "alice's" inteiro, e buscar "alice" sem o `*` perdia o proprio Alice's Adventures
  // minusculas: AND/OR/NOT em caixa alta sao operadores da busca do Archive
  const term = escapeQuery(f.q ?? '')
    .toLowerCase()
    .split(' ')
    .filter(Boolean)
    .map((w) => (w.length >= 3 ? `${w}*` : w))
    .join(' ');
  if (term) parts.push(`(title:(${term}) OR creator:(${term}))`);
  // no catalogo de livros o idioma publicado E o original sao o mesmo campo
  const wanted = [...new Set([...(f.langs ?? []), ...(f.origin ?? [])].map(baseLang))].flatMap((l) => LANGUAGE_ALIASES[l] ?? []);
  if (wanted.length) parts.push(`language:(${wanted.join(' OR ')})`);
  if (!term) parts.push(SHELF);
  if (!f.contentRating?.some((r) => ADULT_RATINGS.includes(r))) parts.push(`NOT ${ADULT_SUBJECTS}`);
  return parts.join(' AND ');
}

async function search(f: SearchFilters): Promise<{ items: SeriesCard[]; total?: number }> {
  const limit = Math.min(f.limit ?? 24, 100);
  const page = Math.max(f.page ?? 1, 1);
  const sort = f.sort === 'title' ? 'titleSorter' : 'downloads';
  const order = f.sort === 'title' && f.order !== 'desc' ? 'asc' : f.order === 'asc' ? 'asc' : 'desc';
  const url =
    `${BASE}/advancedsearch.php?q=${encodeURIComponent(searchQuery(f))}` +
    ['identifier', 'title', 'creator', 'language', 'subject'].map((k) => `&fl[]=${k}`).join('') +
    `&rows=${limit}&page=${page}&output=json&sort[]=${sort}+${order}`;
  const data = await getJson<{ response?: { numFound?: number; docs?: SearchDoc[] } }>(url, f.signal);
  return { items: (data.response?.docs ?? []).map(cardOf), total: data.response?.numFound };
}

interface Metadata {
  metadata?: { title?: string | string[]; creator?: string | string[]; language?: string | string[]; subject?: string | string[]; collection?: string | string[] };
  files?: { name: string; format?: string; size?: string }[];
}

/** Identificador do Archive: so' isto vira nome de arquivo no cache e trecho de URL. */
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const MAX_EPUB_BYTES = 60_000_000;

const metadataOf = (id: string): Promise<Metadata> =>
  cached(`gutenberg:meta:${id}`, defaultTtl(), () => getJson<Metadata>(`${BASE}/metadata/${encodeURIComponent(id)}`));

/** Downloads do mesmo livro em andamento: abrir a obra e o capitulo juntos baixava o EPUB duas vezes. */
const inflight = new Map<string, Promise<string>>();

/**
 * O EPUB do livro, baixado uma vez para o cache. Livro em dominio publico nao
 * muda, entao o arquivo nunca expira; apagar `.cache/books` so' custa baixar de novo.
 */
export function epubPath(id: string): Promise<string> {
  if (!ID_RE.test(id)) return Promise.reject(new Error('identificador de livro invalido'));
  const running = inflight.get(id);
  if (running) return running;
  const job = download(id).finally(() => inflight.delete(id));
  inflight.set(id, job);
  return job;
}

const isArchiveHost = (host: string): boolean => /(^|\.)archive\.org$/i.test(host);

/**
 * /download/ responde 302 para o no' que guarda o item. Um salto por vez, como o
 * proxy de imagem: cada destino tem de continuar no Archive, senao um redirect
 * malicioso levaria o servidor a buscar um host interno.
 */
async function fetchFromArchive(url: string): Promise<Response> {
  let current = url;
  for (let hop = 0; hop < 4; hop++) {
    const parsed = new URL(current);
    if (parsed.protocol !== 'https:' || !isArchiveHost(parsed.hostname)) throw new Error('download redirecionado para fora do acervo');
    const res = await httpFetch(current, { timeoutMs: 60_000, bodyTimeoutMs: 60_000, retries: 2, redirect: 'manual' });
    const location = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && location) {
      await res.body?.cancel().catch(() => undefined);
      current = new URL(location, current).href;
      continue;
    }
    return res;
  }
  throw new Error('redirects demais ao baixar o livro');
}

async function download(id: string): Promise<string> {
  const dir = join(config.cacheDir, 'books');
  const path = join(dir, `${id}.epub`);
  if (await stat(path).then((s) => s.size > 0, () => false)) return path;

  const meta = await metadataOf(id);
  // sem esta conferencia o id serviria para puxar qualquer EPUB enviado ao Archive por um usuario
  if (!listOf(meta.metadata?.collection).includes('gutenberg')) throw new Error('este item nao pertence ao acervo do Project Gutenberg');
  const epubs = (meta.files ?? []).filter((f) => /\.epub$/i.test(f.name));
  // a versao "-images" traz as ilustracoes, que o leitor de texto nao mostra: a enxuta baixa mais rapido
  const file = epubs.find((f) => !/-images/i.test(f.name)) ?? epubs[0];
  if (!file) throw new Error('este titulo nao tem EPUB no acervo');
  if (Number(file.size) > MAX_EPUB_BYTES) throw new Error('EPUB grande demais para baixar');

  const res = await fetchFromArchive(`${BASE}/download/${encodeURIComponent(id)}/${encodeURIComponent(file.name)}`);
  if (!res.ok) throw new Error(`o acervo respondeu ${res.status} ao baixar o livro`);
  const data = new Uint8Array(await res.arrayBuffer());
  if (data.length > MAX_EPUB_BYTES) throw new Error('EPUB grande demais para baixar');
  // "PK": pagina de erro em HTML com status 200 nao pode virar um EPUB corrompido no cache
  if (data[0] !== 0x50 || data[1] !== 0x4b) throw new Error('o acervo nao devolveu um EPUB valido');

  await mkdir(dir, { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  await Bun.write(tmp, data);
  await rename(tmp, path).catch(async (err) => {
    await rm(tmp, { force: true });
    throw err;
  });
  return path;
}

const b64 = (s: string): string => Buffer.from(s, 'utf8').toString('base64url');
const unb64 = (s: string): string => Buffer.from(s, 'base64url').toString('utf8');

/** `<id>.<indice>` em base64url, como o capitulo de livro local: o ponto nunca aparece dentro de nenhum dos dois. */
const chapterId = (id: string, index: number): string => `${b64(id)}.${b64(String(index))}`;

/** Livros ja' abertos: a lista de capitulos e cada capitulo releem o mesmo EPUB. */
const opened = new Map<string, TextBook>();
const MAX_OPEN = 4;

async function openBook(id: string): Promise<TextBook> {
  const hit = opened.get(id);
  if (hit) return hit;
  const path = await epubPath(id);
  const book = await epubToTextBook(path, await readEpub(path), { gutenberg: true });
  opened.set(id, book);
  while (opened.size > MAX_OPEN) opened.delete(opened.keys().next().value as string);
  return book;
}

async function series(id: string): Promise<SeriesDetail> {
  if (!ID_RE.test(id)) throw new Error('identificador de livro invalido');
  const meta = await metadataOf(id);
  if (!meta.metadata) throw new Error(`o livro ${id} nao existe no acervo`);
  const card = cardOf({ identifier: id, ...meta.metadata } as SearchDoc);
  const book = await openBook(id);
  const origin = card.origin === 'unknown' ? (book.lang?.split('-')[0] ?? 'unknown') : (card.origin ?? 'unknown');
  const lang = origin === 'unknown' ? 'en' : origin;
  const chapters: ChapterRef[] = book.chapters.map((c, i) => ({
    id: chapterId(id, i),
    provider: 'gutenberg',
    seriesId: id,
    number: String(i + 1),
    title: c.title,
    lang,
    text: true,
  }));
  // a capa que o proprio Gutenberg gerou, quando o item tem: a busca nao sabe disso, o detalhe sabe
  const coverFile = (meta.files ?? []).find((f) => /^pg\d+\.cover\.medium\.jpg$/i.test(f.name));
  return {
    ...card,
    ...(coverFile ? { cover: `${BASE}/download/${encodeURIComponent(id)}/${encodeURIComponent(coverFile.name)}` } : {}),
    title: book.title || card.title,
    origin,
    authors: listOf(meta.metadata.creator).map(authorName).filter(Boolean),
    chapters,
    availableLangs: [lang],
  };
}

async function book(chapter: string): Promise<TextBlock[]> {
  const [rawId = '', rawIndex = ''] = chapter.split('.');
  const index = Number(unb64(rawIndex));
  if (!rawIndex || !Number.isInteger(index) || index < 0) throw new Error('capitulo invalido');
  const blocks = chapterBlocks((await openBook(unb64(rawId))).chapters[index]);
  if (!blocks.length) throw new Error('capitulo inexistente neste livro');
  return blocks;
}

registerImageHost('archive.org');
registerImageHost('.archive.org');

export const gutenberg: Provider = {
  id: 'gutenberg',
  name: 'Project Gutenberg (livros em dominio publico)',
  kind: 'online',
  contentType: 'livro',
  supports: ['q', 'langs', 'origin', 'contentRating', 'page', 'limit', 'sort', 'order'],
  languages: ['en', 'pt-br', 'es', 'fr', 'de', 'it', 'nl', 'fi', 'ja', 'zh', 'la'],
  search,
  series,
  // livro de texto nao tem pagina de imagem; o leitor de livro pede os paragrafos por `book`
  pages: async () => [],
  book,
};
