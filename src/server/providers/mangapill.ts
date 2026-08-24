import { fetchText } from '../http.ts';
import { cached, defaultTtl } from '../cache.ts';
import { all, chunks, first, stripTags } from '../scrape.ts';
import type { ChapterRef, PageRef, Provider, SeriesCard, SeriesDetail, TagInfo } from './types.ts';

const BASE = 'https://mangapill.com';
const REFERER = `${BASE}/`;

const STATUS_MAP: Record<string, string> = {
  publishing: 'ongoing',
  finished: 'completed',
  'on hiatus': 'hiatus',
  discontinued: 'cancelled',
  'not yet published': 'upcoming',
};

const badges = (block: string): string[] =>
  all(block, /<div class="text-xs leading-5 (?:bg-[\w-]+ text-black|bg-card) rounded px-1\.?5?">([^<]+)<\/div>/g).map(
    (m) => stripTags(m[1] ?? ''),
  );

function parseCards(html: string): SeriesCard[] {
  return chunks(html, /<a href="\/manga\/\d+\/[^"]*" class="relative block">/g)
    .map((block): SeriesCard | null => {
      const href = first(block, /<a href="(\/manga\/\d+\/[^"]*)"/);
      const title = first(block, /line-clamp-2">([^<]*)<\/div>/);
      if (!href || !title) return null;
      const tags = badges(block);
      const year = tags.find((t) => /^(19|20)\d\d$/.test(t));
      const status = tags.find((t) => t in STATUS_MAP);
      const type = tags.find((t) => ['manga', 'manhua', 'novel', 'one-shot', 'doujinshi', 'oel'].includes(t));
      return {
        id: href.replace(/^\/manga\//, ''),
        provider: 'mangapill',
        title: stripTags(title),
        cover: first(block, /<img data-src="([^"]+)"/),
        coverReferer: REFERER,
        year: year ? Number(year) : undefined,
        status: status ? STATUS_MAP[status] : undefined,
        type: type ?? 'manga',
        // mangapill so publica scan em ingles — e' exatamente o caso de uso do OCR+traducao
        origin: 'ja',
        tags: tags.filter((t) => t !== year && t !== status && t !== type),
        url: `${BASE}${href}`,
      };
    })
    .filter((c): c is SeriesCard => c !== null);
}

export const mangapill: Provider = {
  id: 'mangapill',
  name: 'MangaPill',
  kind: 'online',
  contentType: 'manga',
  supports: ['q', 'includeTags', 'status', 'type', 'page'],
  languages: ['en'],

  async tags(): Promise<TagInfo[]> {
    return cached('mangapill:tags', 24 * 60 * 60 * 1000, async () => {
      const html = await fetchText(`${BASE}/search?q=a`, { referer: REFERER });
      const names = all(html, /name="genre"\s+value="([^"]+)"/g).map((m) => m[1] ?? '');
      return [...new Set(names)].filter(Boolean).map((n) => ({ id: n, name: n, group: 'genre' }));
    });
  },

  async search(f) {
    const p = new URLSearchParams();
    p.set('q', f.q ?? '');
    if (f.page && f.page > 1) p.set('page', String(f.page));
    const status = f.status?.[0];
    const upstreamStatus = Object.entries(STATUS_MAP).find(([, v]) => v === status)?.[0];
    if (upstreamStatus) p.set('status', upstreamStatus);
    if (f.type?.[0]) p.set('type', f.type[0]);
    for (const g of f.includeTags ?? []) p.append('genre', g);

    const key = `mangapill:search:${p}`;
    const html = await cached(key, defaultTtl(), () => fetchText(`${BASE}/search?${p}`, { referer: REFERER }));
    let items = parseCards(html);
    if (f.yearFrom || f.yearTo) {
      items = items.filter(
        (i) => i.year && (!f.yearFrom || i.year >= f.yearFrom) && (!f.yearTo || i.year <= f.yearTo),
      );
    }
    for (const ex of f.excludeTags ?? []) items = items.filter((i) => !i.tags?.includes(ex));
    return { items };
  },

  async series(id) {
    return cached(`mangapill:series:${id}`, defaultTtl(), async () => {
      const html = await fetchText(`${BASE}/manga/${id}`, { referer: REFERER });
      const tags = badges(html);
      const chapters: ChapterRef[] = all(html, /href="(\/chapters\/[^"]+)"[^>]*>\s*([^<]*)</g)
        .map((m) => {
          const href = m[1] ?? '';
          const label = stripTags(m[2] ?? '');
          return {
            id: href.replace(/^\/chapters\//, ''),
            provider: 'mangapill',
            seriesId: id,
            number: /chapter\s*([\d.]+)/i.exec(label)?.[1] ?? /-chapter-([\d.]+)$/.exec(href)?.[1],
            title: label || undefined,
            lang: 'en',
          } satisfies ChapterRef;
        })
        .filter((c, i, arr) => arr.findIndex((o) => o.id === c.id) === i)
        .reverse();

      const status = tags.find((t) => t in STATUS_MAP);
      const year = tags.find((t) => /^(19|20)\d\d$/.test(t));
      const detail: SeriesDetail = {
        id,
        provider: 'mangapill',
        title: stripTags(first(html, /<h1 class="font-bold text-lg md:text-2xl">([^<]*)<\/h1>/) ?? id),
        cover: first(html, /<img[^>]+(?:data-)?src="(https:\/\/cdn\.[^"]+\/i\/[^"]+)"/),
        coverReferer: REFERER,
        description: stripTags(first(html, /<p class="text-sm text--secondary">([\s\S]*?)<\/p>/) ?? ''),
        status: status ? STATUS_MAP[status] : undefined,
        year: year ? Number(year) : undefined,
        origin: 'ja',
        type: 'manga',
        tags: tags.filter((t) => t !== status && t !== year),
        url: `${BASE}/manga/${id}`,
        chapters,
        availableLangs: ['en'],
      };
      return detail;
    });
  },

  async pages(chapterId) {
    const html = await fetchText(`${BASE}/chapters/${chapterId}`, { referer: REFERER });
    const urls = all(html, /<img[^>]+data-src="(https:\/\/[^"]+)"/g)
      .map((m) => m[1] ?? '')
      .filter((u) => /\/file\/mangap\//.test(u));
    const out: PageRef[] = urls.map((url) => ({ url, referer: REFERER }));
    return out;
  },
};
