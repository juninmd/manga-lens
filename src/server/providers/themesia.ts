import { cached, defaultTtl } from '../cache.ts';
import { registerImageHost, registerSourceUserAgent } from '../config.ts';
import { fetchText } from '../http.ts';
import { all, chunks, first, stripTags } from '../scrape.ts';
import { absoluteUrl, attr, container, imageUrls, pathUrl } from './html.ts';
import type { MadaraSite } from './madara.ts';
import type { ChapterRef, Provider, SeriesCard } from './types.ts';

/** MangaThemesia: static catalog/chapter list and a JSON reader payload (never eval). */
export function createThemesiaProvider(site: MadaraSite): Provider {
  const referer = `${site.base}/`;
  registerImageHost(new URL(site.base).hostname);
  for (const host of site.imageHosts ?? []) registerImageHost(host);
  if (site.userAgent) registerSourceUserAgent(new URL(site.base).hostname, site.userAgent);
  const idOf = (href: string | undefined): string | undefined => {
    const url = absoluteUrl(href, referer);
    if (!url?.startsWith(referer)) return undefined;
    const id = url.slice(referer.length).replace(/\/$/, '');
    return id && !/[?#]/.test(id) ? id : undefined;
  };
  return {
    id: site.id, name: site.name, kind: 'online', contentType: site.contentType,
    languages: [site.lang], supports: ['q', 'page'],
    async search(f) {
      const params = new URLSearchParams({ s: f.q ?? '' });
      const url = `${site.base}${(f.page ?? 1) > 1 ? `/page/${f.page}` : '/'}?${params}`;
      const html = await cached(`${site.id}:search:v2:${url}`, defaultTtl(), () => fetchText(url, { referer, signal: f.signal }));
      const items = chunks(html, /<div\b[^>]*class=["'][^"']*\bbsx\b[^"']*["'][^>]*>/g).map((block): SeriesCard | null => {
        if (/class=["'][^"']*novelabel/.test(block)) return null;
        const link = first(block, /(<a\b[^>]*>)/i) ?? '';
        const id = idOf(attr(link, 'href'));
        const title = attr(link, 'title') || stripTags(container(block, ['tt']) ?? '');
        if (!id || !title) return null;
        return { id, provider: site.id, title, cover: imageUrls(block, referer)[0], coverReferer: referer,
          contentType: site.contentType, type: 'manga', url: pathUrl(site.base, id) };
      }).filter((item): item is SeriesCard => item !== null);
      return { items: [...new Map(items.map((item) => [item.id, item])).values()] };
    },
    async series(id) {
      const url = pathUrl(site.base, id);
      return cached(`${site.id}:series:v2:${id}`, 6 * 60 * 60 * 1000, async () => {
        const html = await fetchText(url, { referer });
        const list = container(html, ['eplister']) ?? '';
        const chapters = all(list, /<a\b[^>]*>([\s\S]*?)<\/a>/gi).map((m): ChapterRef | null => {
          const chapterId = idOf(attr(m[0].split('>')[0]!, 'href'));
          if (!chapterId) return null;
          const label = stripTags(first(m[1] ?? '', /<span[^>]*class=["']chapternum["'][^>]*>([\s\S]*?)<\/span>/i) ?? m[1] ?? '').replace(/\s+/g, ' ');
          return { id: chapterId, provider: site.id, seriesId: id, title: label, lang: site.lang,
            number: /(?:chapter|cap[ií]tulo|chapitre)\s*(\d+(?:\.\d+)?)/i.exec(label)?.[1] };
        }).filter((c): c is ChapterRef => c !== null).reverse();
        const summary = container(html, ['entry-content']) ?? '';
        return { id, provider: site.id, contentType: site.contentType, type: 'manga', url,
          title: stripTags(first(html, /<h1[^>]*class=["'][^"']*entry-title[^"']*["'][^>]*>([\s\S]*?)<\/h1>/i) ?? first(html, /<h1[^>]*>([\s\S]*?)<\/h1>/i) ?? id).replace(/\s+/g, ' '),
          cover: imageUrls(container(html, ['thumb']) ?? '', referer)[0], coverReferer: referer,
          description: stripTags(summary), chapters, availableLangs: [site.lang] };
      });
    },
    async pages(id) {
      const url = pathUrl(site.base, id);
      const html = await fetchText(url, { referer });
      const payload = first(html, /ts_reader\.run\(\s*(\{[\s\S]*?\})\s*\)\s*;?/);
      let urls: string[] = [];
      if (payload) {
        const data = JSON.parse(payload) as { sources?: { images?: string[] }[] };
        urls = data.sources?.find((s) => s.images?.length)?.images ?? [];
      } else urls = imageUrls(container(html, ['rdminimal', 'readerarea']) ?? '', url);
      const pages = urls.map((u) => absoluteUrl(u, url)).filter((u): u is string => Boolean(u)).map((image) => ({ url: image, referer: url }));
      if (!pages.length) throw new Error(`${site.name}: capitulo sem paginas`);
      return pages;
    },
  };
}
