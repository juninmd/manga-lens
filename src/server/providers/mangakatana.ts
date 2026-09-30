import { cached, defaultTtl } from '../cache.ts';
import { registerImageHost } from '../config.ts';
import { fetchText } from '../http.ts';
import { all, chunks, first, stripTags } from '../scrape.ts';
import { absoluteUrl, attr, container, imageUrls, pathUrl } from './html.ts';
import type { ChapterRef, Provider, SeriesCard } from './types.ts';

const BASE = 'https://mangakatana.com';
registerImageHost('mangakatana.com');
registerImageHost('i1.mangakatana.com');
registerImageHost('i2.mangakatana.com');
registerImageHost('i3.mangakatana.com');
const idOf = (href: string | undefined): string | undefined => {
  const url = absoluteUrl(href, `${BASE}/`);
  return url?.startsWith(`${BASE}/manga/`) ? url.slice(`${BASE}/manga/`.length) : undefined;
};

export function katanaImages(html: string): string[] {
  const name = first(html, /data-src['"],\s*(\w+)/);
  if (!name) return [];
  const body = first(html, new RegExp(`var\\s+${name}\\s*=\\s*\\[([^\\]]*)\\]`)) ?? '';
  return all(body, /'([^']+)'|"([^"]+)"/g).map((m) => absoluteUrl(m[1] ?? m[2], `${BASE}/`)).filter((u): u is string => Boolean(u));
}

export const mangakatana: Provider = {
  id: 'mangakatana', name: 'MangaKatana', kind: 'online', contentType: 'manga', languages: ['en'], supports: ['q', 'page'],
  async search(f) {
    const params = new URLSearchParams({ search: f.q ?? '', search_by: 'book_name' });
    const url = f.q?.trim() ? `${BASE}/page/${f.page ?? 1}?${params}` : `${BASE}/manga/page/${f.page ?? 1}`;
    const html = await cached(`katana:search:${url}`, defaultTtl(), () => fetchText(url, { referer: `${BASE}/`, signal: f.signal }));
    const items = chunks(container(html, [], 'book_list') ?? '', /<div\b[^>]*class=["']item["'][^>]*>/g).map((block): SeriesCard | null => {
      const heading = first(block, /<h3[^>]*>([\s\S]*?)<\/h3>/i) ?? '';
      const link = first(heading, /(<a\b[^>]*>)/i) ?? '';
      const id = idOf(attr(link, 'href'));
      const title = stripTags(first(heading, /<a[^>]*>([\s\S]*?)<\/a>/i) ?? '');
      if (!id || id.includes('/') || !title) return null;
      return { id, provider: 'mangakatana', title, cover: imageUrls(block, `${BASE}/`)[0], coverReferer: `${BASE}/`,
        contentType: 'manga', type: 'manga', url: `${BASE}/manga/${id}` };
    }).filter((c): c is SeriesCard => c !== null);
    return { items };
  },
  async series(id) {
    const url = pathUrl(`${BASE}/manga`, id);
    return cached(`katana:series:${id}`, defaultTtl(), async () => {
      const html = await fetchText(url, { referer: `${BASE}/` });
      const list = container(html, ['chapters']) ?? '';
      const chapters = all(list, /<a\b[^>]*>([\s\S]*?)<\/a>/gi).map((m): ChapterRef | null => {
        const chapter = idOf(attr(m[0].split('>')[0]!, 'href'));
        if (!chapter?.startsWith(`${id}/c`) || /[?#]/.test(chapter)) return null;
        return { id: chapter, provider: 'mangakatana', seriesId: id, title: stripTags(m[1] ?? ''), lang: 'en', number: /\/c(\d+(?:\.\d+)?)/.exec(chapter)?.[1] };
      }).filter((c): c is ChapterRef => c !== null).reverse();
      return { id, provider: 'mangakatana', title: stripTags(first(html, /<h1[^>]*>([\s\S]*?)<\/h1>/i) ?? id),
        cover: imageUrls(container(html, ['cover']) ?? '', `${BASE}/`)[0], coverReferer: `${BASE}/`,
        description: stripTags(container(html, ['summary']) ?? ''), contentType: 'manga' as const, type: 'manga', url, chapters, availableLangs: ['en'] };
    });
  },
  async pages(id) {
    const url = pathUrl(`${BASE}/manga`, id);
    const html = await fetchText(url, { referer: `${BASE}/` });
    const pages = katanaImages(html).map((image) => ({ url: image, referer: url }));
    if (!pages.length) throw new Error('MangaKatana: capitulo sem paginas');
    return pages;
  },
};
