import { cached, defaultTtl } from '../cache.ts';
import { registerImageHost } from '../config.ts';
import { fetchText } from '../http.ts';
import { all, chunks, first, stripTags } from '../scrape.ts';
import type { ChapterRef, PageRef, Provider, SeriesCard, SeriesDetail } from './types.ts';

const BASE = 'https://komiku.org';
const REFERER = `${BASE}/`;
registerImageHost('komiku.org');
registerImageHost('thumbnail.komiku.to');
for (const n of [1, 2, 3, 4, 5]) registerImageHost(`image${n}.komiku.to`);

/** Listagem pública do Komiku: cards de séries com capa e título. */
const card = (block: string): SeriesCard | null => {
  const href = first(block, /<h3><a href="\/manga\/([^"/]+)\/"/);
  const title = stripTags(first(block, /<h3><a[^>]*>([\s\S]*?)<\/a><\/h3>/) ?? '');
  if (!href || !title) return null;
  return {
    id: href,
    provider: 'komiku',
    title,
    cover: first(block, /data-src="(https:\/\/thumbnail\.komiku\.to\/[^"]+)"/),
    coverReferer: REFERER,
    contentType: 'manga',
    type: 'manga',
    origin: 'ja',
    url: `${BASE}/manga/${href}/`,
  };
};

export const komiku: Provider = {
  id: 'komiku',
  name: 'Komiku',
  kind: 'online',
  contentType: 'manga',
  languages: ['id'],
  // o Komiku nao expoe busca no HTML: a busca filtra a listagem inicial pelo titulo
  supports: ['q'],

  async search(f) {
    const html = await cached('komiku:home', defaultTtl(), () => fetchText(REFERER, { referer: REFERER, signal: f.signal }));
    const q = f.q?.trim().toLowerCase() ?? '';
    const items = chunks(html, /<article class="ls2">/g)
      .map(card)
      .filter((c): c is SeriesCard => c !== null)
      .filter((c) => !q || c.title.toLowerCase().includes(q));
    return { items };
  },

  async series(id) {
    if (!/^[a-z0-9-]+$/.test(id)) throw new Error('Komiku: id de obra invalido');
    return cached(`komiku:series:${id}`, defaultTtl(), async () => {
      const url = `${BASE}/manga/${id}/`;
      const html = await fetchText(url, { referer: REFERER });
      const seen = new Set<string>();
      const chapters: ChapterRef[] = all(html, new RegExp(`href="/(${id}-chapter-([\\d.]+)(?:-\\d+)?)/"`, 'g'))
        .filter((m) => !seen.has(m[1]!) && seen.add(m[1]!))
        .map((m) => ({ id: m[1]!, provider: 'komiku', seriesId: id, number: m[2], lang: 'id' }) satisfies ChapterRef)
        .reverse();
      const names = all(html, /itemprop="name">([^<]+)</g).map((m) => stripTags(m[1] ?? ''));
      const detail: SeriesDetail = {
        id,
        provider: 'komiku',
        title: names[1] ?? id,
        cover: first(html, /data-src="(https:\/\/thumbnail\.komiku\.to\/[^"]+)"/),
        coverReferer: REFERER,
        contentType: 'manga',
        type: 'manga',
        origin: 'ja',
        url,
        chapters,
        availableLangs: ['id'],
      };
      return detail;
    });
  },

  async pages(chapterId) {
    if (!/^[a-z0-9-]+$/.test(chapterId)) throw new Error('Komiku: id de capitulo invalido');
    const html = await fetchText(`${BASE}/${chapterId}/`, { referer: REFERER });
    const urls = all(html, /src="(https:\/\/image\d*\.komiku\.to\/upload[^"]+\.(?:webp|jpe?g|png))"/g).map((m) => m[1] ?? '');
    const unique = [...new Set(urls)];
    if (!unique.length) throw new Error('Komiku: capitulo sem paginas');
    return unique.map((url): PageRef => ({ url, referer: REFERER }));
  },
};
