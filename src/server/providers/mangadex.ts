import { fetchJson } from '../http.ts';
import { cached, defaultTtl } from '../cache.ts';
import type {
  ChapterRef,
  PageRef,
  Provider,
  SearchFilters,
  SeriesCard,
  SeriesDetail,
  TagInfo,
} from './types.ts';

const API = 'https://api.mangadex.org';
const COVERS = 'https://uploads.mangadex.org/covers';

interface MdRel {
  id: string;
  type: string;
  attributes?: Record<string, unknown>;
}
interface MdManga {
  id: string;
  attributes: {
    title: Record<string, string>;
    altTitles: Record<string, string>[];
    description: Record<string, string>;
    originalLanguage: string;
    status: string;
    year: number | null;
    publicationDemographic: string | null;
    contentRating: string;
    availableTranslatedLanguages: string[];
    tags: { id: string; attributes: { name: Record<string, string>; group: string } }[];
  };
  relationships: MdRel[];
}
interface MdList<T> {
  data: T[];
  total?: number;
}

const pick = (m: Record<string, string> | undefined): string | undefined => {
  if (!m) return undefined;
  return m['pt-br'] ?? m['pt'] ?? m['en'] ?? m['ja-ro'] ?? m['ja'] ?? Object.values(m)[0];
};

const typeFromLang = (lang: string): string =>
  lang === 'ko' ? 'manhwa' : lang === 'zh' || lang === 'zh-hk' ? 'manhua' : 'manga';

function toCard(m: MdManga): SeriesCard {
  const cover = m.relationships.find((r) => r.type === 'cover_art');
  const fileName = cover?.attributes?.['fileName'] as string | undefined;
  const a = m.attributes;
  return {
    id: m.id,
    provider: 'mangadex',
    title: pick(a.title) ?? '(sem titulo)',
    altTitles: a.altTitles.map((t) => Object.values(t)[0]).filter(Boolean) as string[],
    cover: fileName ? `${COVERS}/${m.id}/${fileName}.512.jpg` : undefined,
    year: a.year ?? undefined,
    status: a.status,
    origin: a.originalLanguage,
    type: typeFromLang(a.originalLanguage),
    demographic: a.publicationDemographic ?? undefined,
    contentRating: a.contentRating,
    tags: a.tags.map((t) => pick(t.attributes.name) ?? '').filter(Boolean),
    description: pick(a.description),
    url: `https://mangadex.org/title/${m.id}`,
  };
}

const ORDER_KEY: Record<NonNullable<SearchFilters['sort']>, string> = {
  relevance: 'relevance',
  latest: 'latestUploadedChapter',
  rating: 'rating',
  follows: 'followedCount',
  title: 'title',
  year: 'year',
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A UI manda nome de tag (linguagem comum entre providers); aqui vira UUID. */
async function resolveTags(names: string[] | undefined): Promise<string[]> {
  if (!names?.length) return [];
  const known = await mangadex.tags!();
  const byName = new Map(known.map((t) => [t.name.toLowerCase(), t.id]));
  return names
    .map((n) => (UUID_RE.test(n) ? n : byName.get(n.toLowerCase())))
    .filter((v): v is string => Boolean(v));
}

function buildQuery(f: SearchFilters): URLSearchParams {
  const limit = Math.min(Math.max(f.limit ?? 24, 1), 100);
  const p = new URLSearchParams();
  p.set('limit', String(limit));
  p.set('offset', String(((f.page ?? 1) - 1) * limit));
  p.append('includes[]', 'cover_art');
  p.append('includes[]', 'author');
  if (f.q) p.set('title', f.q);
  for (const l of f.langs ?? []) p.append('availableTranslatedLanguage[]', l);
  for (const l of f.origin ?? []) p.append('originalLanguage[]', l);
  for (const t of f.includeTags ?? []) p.append('includedTags[]', t);
  for (const t of f.excludeTags ?? []) p.append('excludedTags[]', t);
  for (const s of f.status ?? []) p.append('status[]', s);
  for (const d of f.demographic ?? []) p.append('publicationDemographic[]', d);
  const ratings = f.contentRating?.length ? f.contentRating : ['safe', 'suggestive', 'erotica'];
  for (const r of ratings) p.append('contentRating[]', r);
  if (f.yearFrom && f.yearFrom === f.yearTo) p.set('year', String(f.yearFrom));
  const sort = f.sort ?? (f.q ? 'relevance' : 'follows');
  p.set(`order[${ORDER_KEY[sort]}]`, f.order ?? (sort === 'title' || sort === 'year' ? 'asc' : 'desc'));
  return p;
}

/** Ratings vivem em outro endpoint; uma chamada em lote evita N+1 por card. */
async function attachStats(cards: SeriesCard[]): Promise<void> {
  if (!cards.length) return;
  const p = new URLSearchParams();
  for (const c of cards) p.append('manga[]', c.id);
  try {
    const res = await fetchJson<{
      statistics: Record<string, { rating?: { bayesian?: number }; follows?: number }>;
    }>(`${API}/statistics/manga?${p}`);
    for (const c of cards) {
      const s = res.statistics[c.id];
      if (s?.rating?.bayesian) c.rating = Math.round(s.rating.bayesian * 10) / 10;
      if (s?.follows) c.follows = s.follows;
    }
  } catch {
    /* estatistica e' enfeite: falha nao derruba a busca */
  }
}

export const mangadex: Provider = {
  id: 'mangadex',
  name: 'MangaDex',
  kind: 'online',
  contentType: 'manga',
  supports: [
    'q',
    'langs',
    'origin',
    'includeTags',
    'excludeTags',
    'status',
    'demographic',
    'contentRating',
    'yearFrom',
    'sort',
    'order',
    'page',
  ],

  async tags(): Promise<TagInfo[]> {
    return cached('mangadex:tags', 24 * 60 * 60 * 1000, async () => {
      const res = await fetchJson<MdList<{ id: string; attributes: { name: Record<string, string>; group: string } }>>(
        `${API}/manga/tag`,
      );
      return res.data
        .map((t) => ({ id: t.id, name: pick(t.attributes.name) ?? t.id, group: t.attributes.group }))
        .sort((a, b) => a.name.localeCompare(b.name));
    });
  },

  async search(f) {
    const [includeTags, excludeTags] = await Promise.all([resolveTags(f.includeTags), resolveTags(f.excludeTags)]);
    const query = buildQuery({ ...f, includeTags, excludeTags });
    const key = `mangadex:search:${query}`;
    const res = await cached(key, defaultTtl(), () => fetchJson<MdList<MdManga>>(`${API}/manga?${query}`));
    let items = res.data.map(toCard);
    // MangaDex so filtra ano exato; faixa e' aplicada aqui.
    if (f.yearFrom || f.yearTo) {
      items = items.filter((i) => {
        if (!i.year) return false;
        if (f.yearFrom && i.year < f.yearFrom) return false;
        if (f.yearTo && i.year > f.yearTo) return false;
        return true;
      });
    }
    if (f.type?.length) items = items.filter((i) => f.type!.includes(i.type ?? ''));
    await attachStats(items);
    return { items, total: res.total };
  },

  async series(id) {
    return cached(`mangadex:series:${id}`, defaultTtl(), async () => {
      const detail = await fetchJson<{ data: MdManga }>(
        `${API}/manga/${id}?includes[]=cover_art&includes[]=author&includes[]=artist`,
      );
      const card = toCard(detail.data);
      const authors = detail.data.relationships
        .filter((r) => r.type === 'author' || r.type === 'artist')
        .map((r) => r.attributes?.['name'] as string)
        .filter(Boolean);

      const chapters: ChapterRef[] = [];
      const seen = new Set<string>();
      for (let offset = 0; offset < 2000; offset += 500) {
        const p = new URLSearchParams({ limit: '500', offset: String(offset), 'order[chapter]': 'asc' });
        p.append('includes[]', 'scanlation_group');
        for (const r of ['safe', 'suggestive', 'erotica', 'pornographic']) p.append('contentRating[]', r);
        const feed = await fetchJson<
          MdList<{
            id: string;
            attributes: {
              chapter: string | null;
              volume: string | null;
              title: string | null;
              translatedLanguage: string;
              pages: number;
              publishAt: string;
              externalUrl: string | null;
            };
            relationships: MdRel[];
          }>
        >(`${API}/manga/${id}/feed?${p}`);
        for (const c of feed.data) {
          // pages === 0 e' capitulo so' com link externo: abre vazio no leitor
          if (c.attributes.externalUrl || c.attributes.pages === 0 || seen.has(c.id)) continue;
          seen.add(c.id);
          chapters.push({
            id: c.id,
            provider: 'mangadex',
            seriesId: id,
            number: c.attributes.chapter ?? undefined,
            volume: c.attributes.volume ?? undefined,
            title: c.attributes.title ?? undefined,
            lang: c.attributes.translatedLanguage,
            group: c.relationships.find((r) => r.type === 'scanlation_group')?.attributes?.['name'] as string,
            pages: c.attributes.pages,
            publishedAt: c.attributes.publishAt,
          });
        }
        if (feed.data.length < 500) break;
      }

      const result: SeriesDetail = {
        ...card,
        authors,
        chapters,
        availableLangs: [...new Set(chapters.map((c) => c.lang).filter(Boolean) as string[])].sort(),
      };
      return result;
    });
  },

  async pages(chapterId) {
    const at = await fetchJson<{
      baseUrl: string;
      chapter: { hash: string; data: string[]; dataSaver: string[] };
    }>(`${API}/at-home/server/${chapterId}`);
    const files = at.chapter.data.length ? at.chapter.data : at.chapter.dataSaver;
    const kind = at.chapter.data.length ? 'data' : 'data-saver';
    const out: PageRef[] = files.map((f) => ({
      url: `${at.baseUrl}/${kind}/${at.chapter.hash}/${f}`,
      referer: 'https://mangadex.org/',
    }));
    return out;
  },
};
