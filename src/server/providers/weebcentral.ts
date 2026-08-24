import { fetchText } from '../http.ts';
import { cached, defaultTtl } from '../cache.ts';
import { all, chunks, first, stripTags } from '../scrape.ts';
import type { ChapterRef, PageRef, Provider, SeriesCard, SeriesDetail, TagInfo } from './types.ts';

const BASE = 'https://weebcentral.com';
const REFERER = `${BASE}/`;

const STATUS_IN: Record<string, string> = {
  ongoing: 'Ongoing',
  completed: 'Complete',
  hiatus: 'Hiatus',
  cancelled: 'Canceled',
};
const STATUS_OUT: Record<string, string> = {
  Ongoing: 'ongoing',
  Complete: 'completed',
  Hiatus: 'hiatus',
  Canceled: 'cancelled',
};
const TYPE_IN: Record<string, string> = { manga: 'Manga', manhwa: 'Manhwa', manhua: 'Manhua', comic: 'OEL' };
const ORIGIN_BY_TYPE: Record<string, string> = { Manga: 'ja', Manhwa: 'ko', Manhua: 'zh', OEL: 'en' };

const SORT_IN: Record<string, string> = {
  relevance: 'Best Match',
  title: 'Alphabet',
  rating: 'Popularity',
  follows: 'Subscribers',
  year: 'Recently Added',
  latest: 'Latest Updates',
};

const field = (block: string, label: string): string | undefined => {
  const re = new RegExp(`<strong[^>]*>${label}[^<]*</strong>\\s*([\\s\\S]*?)</div>`, 'i');
  const raw = re.exec(block)?.[1];
  return raw ? stripTags(raw).replace(/\s+/g, ' ').trim() || undefined : undefined;
};

function parseCards(html: string): SeriesCard[] {
  return chunks(html, /<article class="bg-base-300 flex gap-4 p-4">/g)
    .map((block): SeriesCard | null => {
      const link = first(block, /href="(https:\/\/weebcentral\.com\/series\/[A-Z0-9]+\/[^"]*)"/);
      if (!link) return null;
      const id = /\/series\/([A-Z0-9]+)/.exec(link)?.[1];
      if (!id) return null;
      const type = field(block, 'Type');
      const year = field(block, 'Year');
      const tags = (field(block, 'Tag\\(s\\)') ?? '')
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean);
      return {
        id,
        provider: 'weebcentral',
        title: stripTags(first(block, /class="line-clamp-1 link link-hover">([^<]*)</) ?? ''),
        cover: `https://temp.compsci88.com/cover/normal/${id}.webp`,
        coverReferer: REFERER,
        year: year && /^\d{4}$/.test(year) ? Number(year) : undefined,
        status: STATUS_OUT[field(block, 'Status') ?? ''] ?? undefined,
        type: type?.toLowerCase(),
        origin: ORIGIN_BY_TYPE[type ?? 'Manga'] ?? 'ja',
        tags,
        url: link,
      };
    })
    .filter((c): c is SeriesCard => c !== null && c.title !== '');
}

export const weebcentral: Provider = {
  id: 'weebcentral',
  name: 'Weeb Central',
  kind: 'online',
  supports: ['q', 'includeTags', 'excludeTags', 'status', 'type', 'sort', 'order', 'page'],
  languages: ['en'],

  async tags(): Promise<TagInfo[]> {
    return cached('weebcentral:tags', 24 * 60 * 60 * 1000, async () => {
      const html = await fetchText(`${BASE}/search`, { referer: REFERER });
      const names = all(html, /id="tag-[^"]+-value"\s+value="([^"]+)"/g).map((m) => m[1] ?? '');
      return [...new Set(names)].filter(Boolean).map((n) => ({ id: n, name: n, group: 'genre' }));
    });
  },

  async search(f) {
    const limit = Math.min(Math.max(f.limit ?? 24, 1), 32);
    const p = new URLSearchParams({
      author: '',
      text: f.q ?? '',
      sort: SORT_IN[f.sort ?? (f.q ? 'relevance' : 'follows')] ?? 'Best Match',
      order: f.order === 'asc' ? 'Ascending' : 'Descending',
      official: 'Any',
      anime: 'Any',
      adult: f.contentRating?.includes('pornographic') ? 'Any' : 'False',
      display_mode: 'Full Display',
      limit: String(limit),
      offset: String(((f.page ?? 1) - 1) * limit),
    });
    for (const s of f.status ?? []) if (STATUS_IN[s]) p.append('included_status', STATUS_IN[s]!);
    for (const t of f.type ?? []) if (TYPE_IN[t]) p.append('included_type', TYPE_IN[t]!);
    for (const t of f.includeTags ?? []) p.append('included_tag', t);
    for (const t of f.excludeTags ?? []) p.append('excluded_tag', t);

    const key = `weebcentral:search:${p}`;
    const html = await cached(key, defaultTtl(), () => fetchText(`${BASE}/search/data?${p}`, { referer: REFERER }));
    let items = parseCards(html);
    if (f.yearFrom || f.yearTo) {
      items = items.filter(
        (i) => i.year && (!f.yearFrom || i.year >= f.yearFrom) && (!f.yearTo || i.year <= f.yearTo),
      );
    }
    if (f.origin?.length) items = items.filter((i) => f.origin!.includes(i.origin ?? ''));
    return { items };
  },

  async series(id) {
    return cached(`weebcentral:series:${id}`, defaultTtl(), async () => {
      const [page, list] = await Promise.all([
        fetchText(`${BASE}/series/${id}`, { referer: REFERER }),
        fetchText(`${BASE}/series/${id}/full-chapter-list`, { referer: REFERER }),
      ]);

      const chapters: ChapterRef[] = chunks(list, /<a href="\/chapters\/[A-Z0-9]+"/g)
        .map((block): ChapterRef | null => {
          const cid = first(block, /href="\/chapters\/([A-Z0-9]+)"/);
          if (!cid) return null;
          const label = stripTags(first(block, /<span class="">([^<]*)<\/span>/) ?? '');
          return {
            id: cid,
            provider: 'weebcentral',
            seriesId: id,
            number: /([\d.]+)\s*$/.exec(label)?.[1],
            title: label || undefined,
            lang: 'en',
            publishedAt: first(block, /checkNewChapter\('([^']+)'\)/),
          };
        })
        .filter((c): c is ChapterRef => c !== null)
        .reverse();

      const type = field(page, 'Type');
      const detail: SeriesDetail = {
        id,
        provider: 'weebcentral',
        title: stripTags(first(page, /<h1[^>]*>([^<]*)<\/h1>/) ?? id),
        cover: `https://temp.compsci88.com/cover/normal/${id}.webp`,
        coverReferer: REFERER,
        description: stripTags(first(page, /<p class="whitespace-pre-wrap break-words">([\s\S]*?)<\/p>/) ?? ''),
        status: STATUS_OUT[field(page, 'Status') ?? ''] ?? undefined,
        year: Number(field(page, 'Released') ?? field(page, 'Year') ?? '') || undefined,
        type: type?.toLowerCase(),
        origin: ORIGIN_BY_TYPE[type ?? 'Manga'] ?? 'ja',
        tags: (field(page, 'Tags?\\(s\\)') ?? field(page, 'Tag\\(s\\)') ?? '')
          .split(',')
          .map((t) => t.trim())
          .filter(Boolean),
        authors: (field(page, 'Author\\(s\\)') ?? '')
          .split(',')
          .map((t) => t.trim())
          .filter(Boolean),
        url: `${BASE}/series/${id}`,
        chapters,
        availableLangs: ['en'],
      };
      return detail;
    });
  },

  async pages(chapterId) {
    const html = await fetchText(
      `${BASE}/chapters/${chapterId}/images?is_prev=False&current_page=1&reading_style=long_strip`,
      { referer: `${BASE}/chapters/${chapterId}` },
    );
    const out: PageRef[] = all(html, /<img[^>]+src="(https:\/\/[^"]+)"/g)
      .map((m) => m[1] ?? '')
      .filter((u) => !u.includes('/static/'))
      .map((url) => ({ url, referer: REFERER }));
    return out;
  },
};
