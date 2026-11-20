import { createHash } from 'node:crypto';
import { mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from '../config.ts';
import { decodeEntities as decodeXmlEntities } from '../entities.ts';
import { epubToTextBook, readEpub, type TextBlock } from '../epub.ts';
import { httpFetch } from '../http.ts';
import { pdfPageCount } from '../pdf.ts';
import { readRarIndex } from '../rar.ts';
import { chapterBlocks, type TextBook } from '../text-book.ts';
import { readZipIndex } from '../zip.ts';
import type { ChapterRef, ContentType, PageRef, Provider, SearchFilters, SeriesCard, SeriesDetail } from './types.ts';

/**
 * Catalogo OPDS 1.x: o que Komga, Kavita, Calibre (servidor de conteudo e
 * Calibre-Web), Ubooquity e boa parte das bibliotecas digitais publicam. Um feed
 * Atom com entradas de dois tipos: NAVEGACAO (uma serie, uma estante — aponta
 * para outro feed) e AQUISICAO (um livro/edicao, com o link do arquivo).
 *
 * Tudo o que vem do feed e' dado de terceiro: todo href e' resolvido contra o
 * feed e TEM de ficar na mesma origem do catalogo configurado. Sem isso, um
 * servidor comprometido apontaria o app (com as credenciais do usuario no
 * cabecalho) para um host interno qualquer.
 */
export interface OpdsCatalog {
  id: string;
  name: string;
  /** URL do feed raiz */
  url: string;
  /** `usuario:senha` para Basic auth (Komga, Kavita e Calibre pedem) */
  auth?: string;
  /** aba de quem nao declara formato: series de navegacao e arquivos de HQ */
  contentType: ContentType;
  /**
   * Idioma dos scans, quando a entrada nao diz (o OPDS quase nunca diz): escolhe o
   * modelo do OCR. Sem ele, catalogo de HQ assume ingles; o resto, deteccao automatica.
   */
  lang?: string;
}

/** `OPDS_CATALOGS=id|Nome|https://host/opds|usuario:senha|tipo|idioma;...` — credencial, tipo e idioma opcionais. */
export function opdsCatalogs(raw = process.env['OPDS_CATALOGS'] ?? ''): OpdsCatalog[] {
  const out: OpdsCatalog[] = [];
  for (const entry of raw.split(';').map((e) => e.trim()).filter(Boolean)) {
    const [id = '', name = '', url = '', auth = '', type = '', lang = ''] = entry.split('|').map((s) => s.trim());
    if (!/^[a-z0-9][a-z0-9_-]{0,31}$/i.test(id)) continue;
    try {
      // servidor caseiro roda em http na rede local (Komga em 192.168...); outro esquema nao
      if (!['http:', 'https:'].includes(new URL(url).protocol)) continue;
    } catch {
      continue;
    }
    const contentType: ContentType = type === 'hq' || type === 'livro' ? type : 'manga';
    const scan = /^[a-z]{2}(?:-[a-z]{2})?$/i.test(lang) ? lang.toLowerCase() : contentType === 'hq' ? 'en' : undefined;
    if (!out.some((c) => c.id === id)) out.push({ id, name: name || id, url, ...(auth.includes(':') ? { auth } : {}), contentType, ...(scan ? { lang: scan } : {}) });
  }
  return out;
}

export interface OpdsLink {
  href: string;
  rel: string;
  type: string;
  /** OPDS-PSE: paginas do arquivo, quando o servidor declara */
  count?: number;
}

export interface OpdsEntry {
  title: string;
  id: string;
  authors: string[];
  summary?: string;
  tags: string[];
  lang?: string;
  links: OpdsLink[];
}

export interface OpdsFeed {
  title?: string;
  entries: OpdsEntry[];
  links: OpdsLink[];
}

const decodeEntities = (s: string): string => decodeXmlEntities(s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1'));

const text = (xml: string): string =>
  decodeEntities(decodeEntities(xml).replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();

const attr = (tag: string, name: string): string | undefined => {
  const m = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i').exec(tag);
  const v = m?.[1] ?? m?.[2];
  return v === undefined ? undefined : decodeEntities(v);
};

const child = (xml: string, tag: string): string | undefined =>
  new RegExp(`<(?:[a-z]+:)?${tag}\\b[^>]*>([\\s\\S]*?)</(?:[a-z]+:)?${tag}>`, 'i').exec(xml)?.[1];

function linksOf(xml: string): OpdsLink[] {
  return (xml.match(/<link\b[^>]*>/gi) ?? []).flatMap((tag) => {
    const href = attr(tag, 'href');
    if (!href) return [];
    const count = Number(attr(tag, 'pse:count') ?? Number.NaN);
    return [{ href, rel: attr(tag, 'rel') ?? '', type: (attr(tag, 'type') ?? '').toLowerCase(), ...(Number.isInteger(count) && count > 0 ? { count } : {}) }];
  });
}

/** Le o feed com regex, como o OPF e o ComicInfo: meia duzia de campos interessam. */
export function parseFeed(xml: string): OpdsFeed {
  const firstEntry = xml.search(/<entry\b/i);
  const head = firstEntry < 0 ? xml : xml.slice(0, firstEntry);
  const entries = [...xml.matchAll(/<entry\b[^>]*>([\s\S]*?)<\/entry>/gi)].map(([, body = '']): OpdsEntry => {
    const authors = [...body.matchAll(/<author\b[^>]*>([\s\S]*?)<\/author>/gi)].map(([, a = '']) => text(child(a, 'name') ?? a)).filter(Boolean);
    const summary = text(child(body, 'summary') ?? child(body, 'content') ?? '');
    const tags = (body.match(/<category\b[^>]*>/gi) ?? []).map((t) => attr(t, 'label') ?? attr(t, 'term') ?? '').filter(Boolean);
    const lang = text(child(body, 'language') ?? '');
    return {
      title: text(child(body, 'title') ?? '') || 'Sem titulo',
      id: text(child(body, 'id') ?? ''),
      authors,
      ...(summary ? { summary: summary.slice(0, 900) } : {}),
      tags: tags.slice(0, 8),
      ...(lang ? { lang: lang.toLowerCase() } : {}),
      links: linksOf(body),
    };
  });
  return { title: text(child(head, 'title') ?? '') || undefined, entries, links: linksOf(head) };
}

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : v === undefined || v === null ? [] : [v]);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
/** Campo de idioma do Readium (`{ "pt": "...", "en": "..." }`) ou texto puro. */
const langStr = (v: unknown): string => (isObj(v) ? str(Object.values(v)[0]) : str(v));

/** OPDS 2.0: `rel` pode ser texto ou lista; `templated` vira o `{searchTerms}` do 1.x. */
function jsonLinks(raw: unknown): OpdsLink[] {
  return arr(raw).flatMap((l): OpdsLink[] => {
    if (!isObj(l) || !str(l.href)) return [];
    const rels = arr(l.rel).map(str).filter(Boolean);
    let href = str(l.href);
    // RFC 6570: `{?query}` / `{?query,page}` → `?query={searchTerms}`
    if (l.templated === true) {
      href = href.replace(/\{\?([^}]+)\}/, (_m, vars: string) => {
        const names = vars.split(',').map((v) => v.trim());
        const q = names.find((n) => /^(query|q|search|title)$/i.test(n)) ?? names[0]!;
        return `?${q}={searchTerms}`;
      });
    }
    const props = isObj(l.properties) ? l.properties : {};
    const count = Number(props.numberOfItems);
    const base = { href, type: str(l.type).toLowerCase(), ...(Number.isInteger(count) && count > 0 ? { count } : {}) };
    return (rels.length ? rels : ['']).map((rel) => ({ ...base, rel }));
  });
}

function jsonPublication(pub: Json): OpdsEntry {
  const m = isObj(pub.metadata) ? pub.metadata : {};
  const authors = arr(m.author).map((a) => (isObj(a) ? langStr(a.name) : str(a))).filter(Boolean);
  const tags = arr(m.subject).map((t) => (isObj(t) ? langStr(t.name) : str(t))).filter(Boolean);
  const lang = str(arr(m.language)[0]);
  const summary = langStr(m.description).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  const images = jsonLinks(pub.images).map((l, i) => ({ ...l, rel: i === 0 ? 'http://opds-spec.org/image/thumbnail' : 'http://opds-spec.org/image' }));
  return {
    title: langStr(m.title) || 'Sem titulo',
    id: str(m.identifier),
    authors,
    ...(summary ? { summary: summary.slice(0, 900) } : {}),
    tags: tags.slice(0, 8),
    ...(lang ? { lang: lang.toLowerCase() } : {}),
    links: [...jsonLinks(pub.links), ...images],
  };
}

/** Entrada de navegacao do OPDS 2.0 vira o mesmo formato da entrada Atom que leva a outro feed. */
const jsonNavigation = (nav: Json): OpdsEntry => ({
  title: langStr(nav.title) || 'Sem titulo',
  id: str(nav.href),
  authors: [],
  tags: [],
  links: jsonLinks([{ type: 'application/opds+json', ...nav, rel: arr(nav.rel).length ? nav.rel : 'subsection' }]),
});

/**
 * Feed OPDS 2.0 (JSON, Readium Web Publication Manifest) no mesmo formato do
 * Atom: o resto do provider nao precisa saber qual versao o servidor fala.
 */
export function parseFeedJson(raw: unknown): OpdsFeed {
  if (!isObj(raw)) throw new Error('o catalogo nao devolveu um feed OPDS');
  const meta = isObj(raw.metadata) ? raw.metadata : {};
  const groups = arr(raw.groups).filter(isObj);
  const navs = [...arr(raw.navigation), ...groups.flatMap((g) => arr(g.navigation))].filter(isObj);
  const pubs = [...arr(raw.publications), ...groups.flatMap((g) => arr(g.publications))].filter(isObj);
  return {
    title: langStr(meta.title) || undefined,
    entries: [...navs.map(jsonNavigation), ...pubs.map(jsonPublication)],
    links: jsonLinks(raw.links),
  };
}

/** Formato do arquivo de aquisicao, pela ordem de preferencia de leitura. */
const FORMATS: { kind: 'epub' | 'cbz' | 'cbr' | 'pdf'; re: RegExp }[] = [
  { kind: 'epub', re: /epub/ },
  { kind: 'cbz', re: /cbz|comicbook\+zip|application\/zip|x-zip/ },
  { kind: 'cbr', re: /cbr|comicbook-rar|x-rar|vnd\.rar/ },
  { kind: 'pdf', re: /pdf/ },
];

export type ArchiveKind = (typeof FORMATS)[number]['kind'];

/** O melhor link de aquisicao da entrada, ou `null` (entrada de navegacao, ou formato que o app nao abre). */
export function acquisitionOf(entry: OpdsEntry): { href: string; kind: ArchiveKind } | null {
  // OPDS 2.0 tambem usa `self` com o tipo do arquivo para a publicacao em si
  const acquisitions = entry.links.filter(
    (l) => l.rel.startsWith('http://opds-spec.org/acquisition') || (l.rel === 'self' && FORMATS.some((f) => f.re.test(l.type))),
  );
  for (const f of FORMATS) {
    const hit = acquisitions.find((l) => f.re.test(l.type)) ?? acquisitions.find((l) => !l.type && new RegExp(`\\.${f.kind}(?:$|\\?)`, 'i').test(l.href));
    if (hit) return { href: hit.href, kind: f.kind };
  }
  return null;
}

const isFeedLink = (l: OpdsLink): boolean => /atom\+xml|opds\+json/.test(l.type) && !l.rel.startsWith('http://opds-spec.org/acquisition') && !/image|thumbnail|search|self|alternate/.test(l.rel);

/** Link do feed para onde a entrada de navegacao leva. */
export const navigationOf = (entry: OpdsEntry): string | undefined =>
  (entry.links.find((l) => isFeedLink(l) && (l.rel === 'subsection' || l.rel === '' || /opds-spec\.org\/sort|opds-spec\.org\/group/.test(l.rel))) ?? entry.links.find(isFeedLink))?.href;

const coverOf = (entry: OpdsEntry): string | undefined =>
  (entry.links.find((l) => l.rel === 'http://opds-spec.org/image/thumbnail') ??
    entry.links.find((l) => l.rel === 'http://opds-spec.org/image') ??
    entry.links.find((l) => /image|cover/.test(l.rel) && l.type.startsWith('image/')))?.href;

const b64 = (s: string): string => Buffer.from(s, 'utf8').toString('base64url');
const unb64 = (s: string): string => Buffer.from(s, 'base64url').toString('utf8');

/** Arquivo de aquisicao baixado vai para o cache; acima disto e' recusado. */
const MAX_DOWNLOAD = 500_000_000;
/** Arquivos guardados por vez: HQ inteira em CBZ pesa dezenas de MB cada. */
const MAX_CACHED = 30;
const MAX_FEED_PAGES = 20;

const MAGIC: Record<ArchiveKind, (b: Uint8Array) => boolean> = {
  epub: (b) => b[0] === 0x50 && b[1] === 0x4b,
  cbz: (b) => b[0] === 0x50 && b[1] === 0x4b,
  cbr: (b) => b[0] === 0x52 && b[1] === 0x61 && b[2] === 0x72 && b[3] === 0x21,
  pdf: (b) => b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46,
};

const IMAGE_RE = /\.(jpe?g|png|webp|gif|bmp|avif)$/i;
const collator = new Intl.Collator('pt-BR', { numeric: true, sensitivity: 'base' });

export interface OpdsProvider extends Provider {
  catalog: OpdsCatalog;
  /** arquivo da edicao no cache + nomes das paginas, na ordem de leitura */
  archive(chapterId: string): Promise<{ path: string; kind: ArchiveKind; names: string[] }>;
  /** imagem de capa da entrada, buscada com as credenciais do catalogo */
  cover(href: string): Promise<Response>;
}

export function createOpdsProvider(catalog: OpdsCatalog): OpdsProvider {
  const origin = new URL(catalog.url).origin;
  const providerId = `opds-${catalog.id}`;
  const headers = catalog.auth ? { Authorization: `Basic ${Buffer.from(catalog.auth, 'utf8').toString('base64')}` } : undefined;

  /** href do feed (relativo ou nao) -> URL absoluta na origem do catalogo, ou erro. */
  const resolve = (href: string, base = catalog.url): string => {
    const url = new URL(href, base);
    if (url.origin !== origin) throw new Error('o catalogo apontou para fora do proprio servidor');
    return url.href;
  };

  /** Um salto por vez: redirect para outra origem levaria junto a credencial. */
  async function get(href: string, accept: string, signal?: AbortSignal, timeoutMs = 20_000): Promise<Response> {
    let current = resolve(href);
    for (let hop = 0; hop < 4; hop++) {
      const res = await httpFetch(current, { accept, headers, signal, timeoutMs, bodyTimeoutMs: timeoutMs * 3, retries: 1, redirect: 'manual' });
      const location = res.headers.get('location');
      if (res.status >= 300 && res.status < 400 && location) {
        await res.body?.cancel().catch(() => undefined);
        current = resolve(location, current);
        continue;
      }
      if (res.status === 401 || res.status === 403) throw new Error(`o catalogo ${catalog.name} recusou o acesso (${res.status}) — confira usuario e senha em OPDS_CATALOGS`);
      if (!res.ok) throw new Error(`o catalogo ${catalog.name} respondeu ${res.status}`);
      return res;
    }
    throw new Error('redirects demais no catalogo');
  }

  async function feed(href: string, signal?: AbortSignal): Promise<{ url: string; feed: OpdsFeed }> {
    const url = resolve(href);
    const res = await get(url, 'application/atom+xml, application/opds+json;q=0.95, application/xml;q=0.9, application/json;q=0.8', signal);
    const body = await res.text();
    let parsed: OpdsFeed;
    if (/^\s*\{/.test(body)) {
      try {
        parsed = parseFeedJson(JSON.parse(body));
      } catch {
        throw new Error('o catalogo nao devolveu um feed OPDS');
      }
    } else {
      if (!/<feed\b/i.test(body)) throw new Error('o catalogo nao devolveu um feed OPDS');
      parsed = parseFeed(body);
    }
    // todo href do feed passa a ser absoluto aqui: o resto do codigo nao lida com relativo
    const fix = (links: OpdsLink[]): OpdsLink[] => links.flatMap((l) => {
      try {
        return [{ ...l, href: resolve(l.href, url) }];
      } catch {
        return [];
      }
    });
    return { url, feed: { ...parsed, links: fix(parsed.links), entries: parsed.entries.map((e) => ({ ...e, links: fix(e.links) })) } };
  }

  let searchTemplate: Promise<string | null> | undefined;
  /** Template de busca: direto no feed raiz ou dentro do descritor OpenSearch. */
  function findSearch(signal?: AbortSignal): Promise<string | null> {
    searchTemplate ??= (async () => {
      const root = (await feed(catalog.url, signal)).feed;
      const link = root.links.find((l) => l.rel === 'search' && l.href.includes('{searchTerms}')) ?? root.links.find((l) => l.rel === 'search');
      if (!link) return null;
      if (link.href.includes('{searchTerms}')) return link.href;
      const xml = await (await get(link.href, 'application/opensearchdescription+xml, application/xml', signal)).text();
      const urls = (xml.match(/<Url\b[^>]*>/gi) ?? []).map((t) => ({ type: (attr(t, 'type') ?? '').toLowerCase(), template: attr(t, 'template') ?? '' }));
      const tpl = (urls.find((u) => /atom/.test(u.type)) ?? urls[0])?.template;
      return tpl ? resolve(tpl, link.href) : null;
    })().catch((err) => {
      searchTemplate = undefined;
      throw err;
    });
    return searchTemplate;
  }

  /** Sem busca: a estante "recentes" do catalogo, se ele tiver; senao o feed raiz. */
  async function shelf(signal?: AbortSignal): Promise<string> {
    const root = (await feed(catalog.url, signal)).feed;
    const byRel = root.links.find((l) => l.rel === 'http://opds-spec.org/sort/new') ?? root.entries.flatMap((e) => e.links).find((l) => l.rel === 'http://opds-spec.org/sort/new');
    if (byRel) return byRel.href;
    const recent = root.entries.find((e) => /latest|recent|new|recentes|novidades|ultimos|últimos|adicionados/i.test(e.title) && navigationOf(e));
    return (recent && navigationOf(recent)) ?? catalog.url;
  }

  const kindType = (kind: ArchiveKind | undefined): ContentType => (kind === 'epub' ? 'livro' : catalog.contentType);

  /** Entrada de aquisicao vira obra com o arquivo no id (nao ha' feed proprio para reabrir). */
  const cardOf = (entry: OpdsEntry): SeriesCard | null => {
    const acq = acquisitionOf(entry);
    const nav = acq ? undefined : navigationOf(entry);
    if (!acq && !nav) return null;
    const cover = coverOf(entry);
    // a capa da serie mora na entrada de navegacao, nao no feed dela: vai junto no id
    const id = acq
      ? `b.${b64(JSON.stringify({ a: acq.href, k: acq.kind, t: entry.title, c: cover, w: entry.authors.slice(0, 3) }))}`
      : `n.${b64(JSON.stringify({ h: nav, c: cover }))}`;
    return {
      id,
      provider: providerId,
      title: entry.title,
      ...(cover ? { cover: coverUrl(cover) } : {}),
      contentType: kindType(acq?.kind),
      type: acq?.kind === 'epub' ? 'book' : catalog.contentType === 'hq' ? 'comic' : undefined,
      origin: (entry.lang ?? catalog.lang)?.split('-')[0] ?? 'unknown',
      tags: entry.tags,
      ...(entry.authors.length ? { authors: entry.authors } : {}),
      ...(entry.summary ? { description: entry.summary } : {}),
    };
  };

  const coverUrl = (href: string): string => `/api/opds/cover?p=${encodeURIComponent(providerId)}&u=${b64(href)}`;

  async function search(f: SearchFilters): Promise<{ items: SeriesCard[]; total?: number }> {
    let start: string;
    const q = (f.q ?? '').trim();
    if (q) {
      const tpl = await findSearch(f.signal);
      if (!tpl) throw new Error(`o catalogo ${catalog.name} nao oferece busca`);
      start = tpl.replace(/\{searchTerms\??\}/g, encodeURIComponent(q.slice(0, 120))).replace(/\{[a-zA-Z:]+\?\}/g, '');
    } else {
      start = await shelf(f.signal);
    }
    let page = await feed(start, f.signal);
    // paginacao do OPDS e' por link "next": a pagina N do app e' o N-esimo salto
    for (let n = 1; n < Math.min(f.page ?? 1, MAX_FEED_PAGES); n++) {
      const next = page.feed.links.find((l) => l.rel === 'next');
      if (!next) return { items: [] };
      page = await feed(next.href, f.signal);
    }
    const items = page.feed.entries.map(cardOf).filter((c): c is SeriesCard => c !== null);
    return { items: f.contentType ? items.filter((i) => i.contentType === f.contentType) : items };
  }

  interface BookRef {
    a: string;
    k: ArchiveKind;
    t?: string;
    c?: string;
    w?: string[];
  }

  const parseRef = (raw: string): BookRef => {
    const ref = JSON.parse(unb64(raw)) as BookRef;
    if (typeof ref?.a !== 'string' || !FORMATS.some((f) => f.kind === ref.k)) throw new Error('capitulo invalido');
    resolve(ref.a);
    return ref;
  };

  /** Capitulo de arquivo (HQ/PDF): o proprio arquivo de aquisicao. */
  const archiveChapter = (ref: BookRef, seriesId: string, i: number, title: string): ChapterRef => ({
    id: `a.${b64(JSON.stringify({ a: ref.a, k: ref.k }))}`,
    provider: providerId,
    seriesId,
    number: String(i + 1),
    title,
    // idioma do scan escolhe o modelo do OCR: 'local' cairia na deteccao japonesa
    lang: catalog.lang ?? 'local',
    // EPUB dentro de uma serie e' o volume inteiro no leitor de livro
    ...(ref.k === 'epub' ? { text: true } : {}),
  });

  async function series(id: string): Promise<SeriesDetail> {
    const [kind, raw = ''] = [id.slice(0, 1), id.slice(2)];
    if (kind === 'b') {
      const ref = parseRef(raw);
      const base: SeriesDetail = {
        id,
        provider: providerId,
        title: ref.t || 'Sem titulo',
        ...(ref.c ? { cover: coverUrl(ref.c) } : {}),
        contentType: kindType(ref.k),
        type: ref.k === 'epub' ? 'book' : catalog.contentType === 'hq' ? 'comic' : undefined,
        origin: catalog.lang?.split('-')[0] ?? 'unknown',
        tags: [],
        ...(ref.w?.length ? { authors: ref.w } : {}),
        chapters: [],
        availableLangs: [catalog.lang ?? 'local'],
      };
      if (ref.k !== 'epub') return { ...base, chapters: [archiveChapter(ref, id, 0, ref.t || 'Edicao completa')] };
      // livro avulso: os capitulos do proprio EPUB
      const book = await openEpub(ref.a);
      return {
        ...base,
        title: book.title || base.title,
        origin: book.lang?.split('-')[0] ?? 'unknown',
        ...(book.description ? { description: book.description } : {}),
        chapters: book.chapters.map((c, i) => ({ id: `e.${b64(ref.a)}.${i}`, provider: providerId, seriesId: id, number: String(i + 1), title: c.title, lang: catalog.lang ?? 'local', text: true })),
      };
    }
    if (kind !== 'n') throw new Error('obra invalida');
    const nav = JSON.parse(unb64(raw)) as { h?: unknown; c?: unknown };
    if (typeof nav?.h !== 'string') throw new Error('obra invalida');
    let page = await feed(nav.h);
    const title = page.feed.title ?? 'Serie';
    const entries: OpdsEntry[] = [...page.feed.entries];
    for (let n = 1; n < MAX_FEED_PAGES; n++) {
      const next = page.feed.links.find((l) => l.rel === 'next');
      if (!next) break;
      page = await feed(next.href);
      entries.push(...page.feed.entries);
    }
    const seen = new Set<string>();
    const books = entries.flatMap((e) => {
      const acq = acquisitionOf(e);
      // servidor que reenvia o mesmo item na virada de pagina nao pode duplicar capitulo
      if (!acq || seen.has(acq.href)) return [];
      seen.add(acq.href);
      return [{ entry: e, ref: { a: acq.href, k: acq.kind } as BookRef }];
    });
    const first = books[0];
    const cover = (typeof nav.c === 'string' ? nav.c : undefined) ?? entries.map(coverOf).find(Boolean);
    return {
      id,
      provider: providerId,
      title,
      ...(cover ? { cover: coverUrl(cover) } : {}),
      contentType: kindType(first?.ref.k),
      type: first?.ref.k === 'epub' ? 'book' : catalog.contentType === 'hq' ? 'comic' : undefined,
      origin: (first?.entry.lang ?? catalog.lang)?.split('-')[0] ?? 'unknown',
      tags: first?.entry.tags ?? [],
      ...(first?.entry.authors.length ? { authors: first.entry.authors } : {}),
      ...(first?.entry.summary ? { description: first.entry.summary } : {}),
      chapters: books.map(({ entry, ref }, i) => archiveChapter(ref, id, i, entry.title)),
      availableLangs: [catalog.lang ?? 'local'],
    };
  }

  const inflight = new Map<string, Promise<string>>();

  /** O arquivo de aquisicao no cache, baixado uma vez (e conferido pela assinatura do formato). */
  function download(href: string, kind: ArchiveKind): Promise<string> {
    const url = resolve(href);
    const dir = join(config.cacheDir, 'opds');
    const path = join(dir, `${createHash('sha1').update(`${catalog.id}\n${url}`).digest('hex')}.${kind}`);
    const running = inflight.get(path);
    if (running) return running;
    const job = (async () => {
      if (await stat(path).then((s) => s.size > 0, () => false)) return path;
      const res = await get(url, '*/*', undefined, 60_000);
      if (Number(res.headers.get('content-length') ?? 0) > MAX_DOWNLOAD) throw new Error('arquivo grande demais para baixar');
      await mkdir(dir, { recursive: true });
      const tmp = `${path}.${process.pid}.tmp`;
      try {
        const head = await streamToFile(res, tmp, MAX_DOWNLOAD);
        // pagina de login em HTML com status 200 nao pode virar um CBZ corrompido no cache
        if (!MAGIC[kind](head)) throw new Error(`o catalogo nao devolveu um arquivo ${kind.toUpperCase()} valido`);
        await rename(tmp, path);
      } finally {
        await rm(tmp, { force: true });
      }
      await prune(dir);
      return path;
    })().finally(() => inflight.delete(path));
    inflight.set(path, job);
    return job;
  }

  const books = new Map<string, TextBook>();
  async function openEpub(href: string): Promise<TextBook> {
    const hit = books.get(href);
    if (hit) return hit;
    const path = await download(href, 'epub');
    const book = await epubToTextBook(path, await readEpub(path));
    books.set(href, book);
    while (books.size > 4) books.delete(books.keys().next().value as string);
    return book;
  }

  async function archive(chapterId: string): Promise<{ path: string; kind: ArchiveKind; names: string[] }> {
    if (!chapterId.startsWith('a.')) throw new Error('capitulo invalido');
    const ref = parseRef(chapterId.slice(2));
    if (ref.k === 'epub') throw new Error('este capitulo e texto, nao paginas');
    const path = await download(ref.a, ref.k);
    if (ref.k === 'pdf') return { path, kind: 'pdf', names: Array.from({ length: await pdfPageCount(path) }, (_, i) => `${i + 1}.png`) };
    const names = ref.k === 'cbr' ? (await readRarIndex(path)).map((e) => e.name) : (await readZipIndex(path)).map((e) => e.name);
    return { path, kind: ref.k, names: names.filter((n) => IMAGE_RE.test(n) && !/(^|\/)__MACOSX\//.test(n)).sort(collator.compare) };
  }

  async function pages(chapterId: string): Promise<PageRef[]> {
    const { names } = await archive(chapterId);
    return names.map((_, i) => ({ url: `/api/opds/page?p=${encodeURIComponent(providerId)}&c=${encodeURIComponent(chapterId)}&i=${i}` }));
  }

  async function book(chapterId: string): Promise<TextBlock[]> {
    if (chapterId.startsWith('e.')) {
      const [, href = '', index = ''] = chapterId.split('.');
      const i = Number(index);
      if (!Number.isInteger(i) || i < 0) throw new Error('capitulo invalido');
      const blocks = chapterBlocks((await openEpub(resolve(unb64(href)))).chapters[i]);
      if (!blocks.length) throw new Error('capitulo inexistente neste livro');
      return blocks;
    }
    if (chapterId.startsWith('a.')) {
      // volume EPUB dentro de uma serie: o livro inteiro, com os titulos como paragrafos
      const ref = parseRef(chapterId.slice(2));
      if (ref.k !== 'epub') throw new Error('este capitulo e de paginas, nao texto');
      const whole = (await openEpub(ref.a)).chapters.flatMap((c) => [c.title, ...c.paragraphs]);
      return whole.map((t, id) => ({ id, text: t }));
    }
    throw new Error('capitulo invalido');
  }

  async function cover(href: string): Promise<Response> {
    const res = await get(href, 'image/*', undefined, 20_000);
    if (!(res.headers.get('content-type') ?? '').toLowerCase().startsWith('image/')) {
      await res.body?.cancel().catch(() => undefined);
      throw new Error('a capa do catalogo nao e uma imagem');
    }
    return res;
  }

  return {
    id: providerId,
    name: `${catalog.name} (OPDS)`,
    kind: 'online',
    // o catalogo e' misto (HQ, manga, livro): aparece em toda aba e cada obra decide a sua
    mixed: true,
    contentType: catalog.contentType,
    supports: ['q', 'page'],
    catalog,
    search,
    series,
    pages,
    book,
    archive,
    cover,
  };
}

/**
 * Grava o corpo da resposta no disco em blocos, parando no teto de tamanho, e
 * devolve os primeiros bytes (para conferir o formato). `Bun.write(caminho,
 * response)` travava para sempre no Bun do CI (1.3) com o corpo que o httpFetch
 * embrulha — o job inteiro morria no timeout de 10 minutos.
 */
export async function streamToFile(res: Response, path: string, max: number): Promise<Uint8Array> {
  const writer = Bun.file(path).writer();
  const head: number[] = [];
  let size = 0;
  const reader = res.body?.getReader();
  try {
    for (;;) {
      if (!reader) break;
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > max) throw new Error('arquivo grande demais para baixar');
      for (let i = 0; i < value.length && head.length < 8; i++) head.push(value[i]!);
      writer.write(value);
    }
  } catch (err) {
    await reader?.cancel().catch(() => undefined);
    throw err;
  } finally {
    await writer.end();
  }
  return Uint8Array.from(head);
}

/** Mantem o cache de arquivos baixados com no maximo `MAX_CACHED` itens, apagando os mais antigos. */
async function prune(dir: string): Promise<void> {
  const files = (await readdir(dir).catch(() => [] as string[])).filter((f) => !f.endsWith('.tmp'));
  if (files.length <= MAX_CACHED) return;
  const dated = await Promise.all(files.map(async (f) => ({ f, at: (await stat(join(dir, f)).catch(() => null))?.mtimeMs ?? 0 })));
  dated.sort((a, b) => a.at - b.at);
  await Promise.all(dated.slice(0, dated.length - MAX_CACHED).map(({ f }) => rm(join(dir, f), { force: true })));
}
