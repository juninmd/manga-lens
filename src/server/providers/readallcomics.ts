import { fetchText } from '../http.ts';
import { registerImageHost } from '../config.ts';
import { cached, defaultTtl } from '../cache.ts';
import { first, stripTags } from '../scrape.ts';
import type { ChapterRef, PageRef, Provider, SearchFilters, SeriesCard, SeriesDetail } from './types.ts';

const BASE = 'https://readallcomics.com';
const REFERER = `${BASE}/`;

registerImageHost('readallcomics.com');

function extractIssueNumber(title: string): string | undefined {
  const match = /(?:#|issue\s+|no\.\s*|part\s*|tp\s*)?(\d+(?:\.\d+)?)/i.exec(title);
  return match ? match[1] : undefined;
}

export const readallcomics: Provider = {
  id: 'readallcomics',
  name: 'ReadAllComics',
  kind: 'online',
  contentType: 'hq',
  supports: ['q'],
  languages: ['en'],

  async search(filters: SearchFilters): Promise<{ items: SeriesCard[]; total?: number }> {
    const q = filters.q?.trim();
    const url = q ? `${BASE}/?story=${encodeURIComponent(q)}&s=type=comic` : BASE;
    const ttl = defaultTtl();

    const html = await cached(`search:readallcomics:${q || 'home'}`, ttl, () =>
      fetchText(url, { referer: REFERER, timeoutMs: 15_000, retries: 3 }),
    );

    const matches = Array.from(html.matchAll(/<li>\s*<a href="([^"]+)">([^<]+)<\/a>/gi));
    const seriesMap = new Map<string, SeriesCard>();

    for (const [, link, rawTitle] of matches) {
      if (!link || !rawTitle) continue;
      const cleanTitle = stripTags(rawTitle).trim();
      const path = link.replace(BASE, '').replace(/^\/+|\/+$/g, '');
      if (!path) continue;

      if (!seriesMap.has(path)) {
        seriesMap.set(path, {
          id: path,
          provider: 'readallcomics',
          title: cleanTitle,
          coverReferer: REFERER,
          contentType: 'hq',
          origin: 'en',
          url: link,
        });
      }
    }

    const items = Array.from(seriesMap.values());
    return { items, total: items.length };
  },

  async series(id: string): Promise<SeriesDetail> {
    const isCategory = id.startsWith('category/');
    const url = `${BASE}/${id}/`;
    const ttl = defaultTtl();
    const html = await cached(`series:readallcomics:${id}`, ttl, () =>
      fetchText(url, { referer: REFERER, timeoutMs: 15_000, retries: 3 }),
    );

    let title = first(html, /<h1[^>]*>([^<]+)<\/h1>/i) || first(html, /<title>([^<]+)<\/title>/i) || id;
    title = stripTags(title).replace(/\s*-\s*Read All Comics.*$/i, '').trim();

    const chapters: ChapterRef[] = [];

    if (isCategory) {
      const issueMatches = Array.from(html.matchAll(/<li>\s*<a href="([^"]+)">([^<]+)<\/a>/gi));
      for (const [, issueUrl, issueTitleRaw] of issueMatches) {
        if (!issueUrl || !issueTitleRaw) continue;
        const issueTitle = stripTags(issueTitleRaw).trim();
        const issueId = issueUrl.replace(BASE, '').replace(/^\/+|\/+$/g, '');
        if (!issueId) continue;
        chapters.push({
          id: issueId,
          provider: 'readallcomics',
          seriesId: id,
          title: issueTitle,
          number: extractIssueNumber(issueTitle),
          lang: 'en',
        });
      }
    } else {
      const categoryLink = first(html, /<a href="(https:\/\/readallcomics\.com\/category\/[^"]+)"[^>]*>([^<]+)<\/a>/i);
      if (categoryLink) {
        const catPath = categoryLink.replace(BASE, '').replace(/^\/+|\/+$/g, '');
        if (catPath) {
          try {
            const catHtml = await cached(`series:readallcomics:${catPath}`, ttl, () =>
              fetchText(categoryLink, { referer: REFERER, timeoutMs: 15_000, retries: 3 }),
            );
            const issueMatches = Array.from(catHtml.matchAll(/<li>\s*<a href="([^"]+)">([^<]+)<\/a>/gi));
            for (const [, issueUrl, issueTitleRaw] of issueMatches) {
              if (!issueUrl || !issueTitleRaw) continue;
              const issueTitle = stripTags(issueTitleRaw).trim();
              const issueId = issueUrl.replace(BASE, '').replace(/^\/+|\/+$/g, '');
              if (!issueId) continue;
              chapters.push({
                id: issueId,
                provider: 'readallcomics',
                seriesId: id,
                title: issueTitle,
                number: extractIssueNumber(issueTitle),
                lang: 'en',
              });
            }
          } catch {
            // falha ao carregar categoria: segue para fallback
          }
        }
      }

      if (chapters.length === 0) {
        chapters.push({
          id,
          provider: 'readallcomics',
          seriesId: id,
          title,
          number: extractIssueNumber(title) ?? '1',
          lang: 'en',
        });
      }
    }

    const cover =
      first(html, /<div class="description">[\s\S]*?<img[^>]+src="([^"]+)"/i) ||
      first(html, /<img[^>]+src="(https:\/\/readallcomics\.com\/wp-content\/uploads\/[^"]+)"/i);

    return {
      id,
      provider: 'readallcomics',
      title,
      cover,
      coverReferer: REFERER,
      contentType: 'hq',
      origin: 'en',
      url,
      chapters,
      availableLangs: ['en'],
    };
  },

  async pages(chapterId: string): Promise<PageRef[]> {
    const url = `${BASE}/${chapterId}/`;
    const ttl = defaultTtl();
    const html = await cached(`pages:readallcomics:${chapterId}`, ttl, () =>
      fetchText(url, { referer: REFERER, timeoutMs: 15_000, retries: 3 }),
    );

    const imgMatches = Array.from(html.matchAll(/<img[^>]+src="([^"]+)"/gi))
      .map((m) => m[1]?.trim() ?? '')
      .filter(
        (u) =>
          u.startsWith('http') &&
          /wp-content\/uploads/i.test(u) &&
          !/logo|banner|advert|avatar|favicon/i.test(u) &&
          !u.endsWith('.svg'),
      );

    const distinctUrls = [...new Set(imgMatches)];
    return distinctUrls.map((pageUrl) => ({
      url: pageUrl,
      referer: REFERER,
    }));
  },
};
