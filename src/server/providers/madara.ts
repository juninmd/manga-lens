import { fetchText, httpFetch } from '../http.ts';
import { registerImageHost } from '../config.ts';
import { cached, defaultTtl } from '../cache.ts';
import { all, chunks, first, stripTags } from '../scrape.ts';
import type { ChapterRef, ContentType, PageRef, Provider, SeriesCard, SeriesDetail, TagInfo } from './types.ts';

export interface MadaraSite {
  id: string;
  name: string;
  base: string;
  /** idioma dos scans publicados no site */
  lang: string;
  /** tipo de conteudo do site (mangá por padrão; alguns Madara servem HQ) */
  contentType: ContentType;
}

const STATUS_OUT: Record<string, string> = {
  ongoing: 'ongoing',
  completed: 'completed',
  'on hold': 'hiatus',
  canceled: 'cancelled',
  cancelled: 'cancelled',
};

const ORDER: Record<string, string> = {
  relevance: '',
  latest: 'latest',
  rating: 'rating',
  follows: 'trending',
  title: 'alphabet',
  year: 'new-manga',
};

const slugOf = (url: string): string => /\/manga\/([^/]+)/.exec(url)?.[1] ?? '';

const field = (block: string, label: string): string | undefined => {
  const re = new RegExp(
    `<div class="summary-heading">\\s*<h5>\\s*${label}[^<]*</h5>\\s*</div>\\s*<div class="summary-content">([\\s\\S]*?)</div>`,
    'i',
  );
  const raw = re.exec(block)?.[1];
  return raw ? stripTags(raw).replace(/\s+/g, ' ').trim() || undefined : undefined;
};

/**
 * Madara e' um tema WordPress usado por dezenas de sites de scan: um parser so'
 * atende todos eles. Cada instancia vira um provider proprio.
 */
export function createMadaraProvider(site: MadaraSite): Provider {
  const referer = `${site.base}/`;
  // as paginas sao servidas pelo proprio dominio do site (wp-content/uploads)
  registerImageHost(new URL(site.base).hostname);

  const parseCards = (html: string): SeriesCard[] =>
    chunks(html, /<div class="row c-tabs-item__content">/g)
      .map((block): SeriesCard | null => {
        const href = first(block, /<a href="([^"]*\/manga\/[^"]*)"/);
        const title = first(block, /<a href="[^"]*\/manga\/[^"]*"\s+title="([^"]*)"/);
        if (!href || !title) return null;
        const status = (field(block, 'Status') ?? '').toLowerCase();
        const year = field(block, 'Release');
        return {
          id: slugOf(href),
          provider: site.id,
          title: stripTags(title),
          altTitles: (field(block, 'Alternative') ?? '')
            .split(/[,;|]/)
            .map((t) => t.trim())
            .filter(Boolean),
          cover: first(block, /<img[^>]+src="([^"]+)"/),
          coverReferer: referer,
          year: year && /^\d{4}$/.test(year) ? Number(year) : undefined,
          status: STATUS_OUT[status],
          type: 'manga',
          origin: 'ja',
          tags: (field(block, 'Genre') ?? '')
            .split(',')
            .map((t) => t.trim())
            .filter(Boolean),
          url: href,
        };
      })
      .filter((c): c is SeriesCard => c !== null);

  return {
    id: site.id,
    name: site.name,
    kind: 'online',
    contentType: site.contentType,
    supports: ['q', 'includeTags', 'status', 'sort', 'page'],
    languages: [site.lang],

    async tags(): Promise<TagInfo[]> {
      return cached(`${site.id}:tags`, 24 * 60 * 60 * 1000, async () => {
        // Nem toda instalacao Madara expoe os generos na busca; a lista de tags
        // e' conveniencia da UI, entao falha aqui nao pode virar 500 na tela.
        const html = await fetchText(`${site.base}/?s=&post_type=wp-manga`, { referer }).catch(() => '');
        const names = all(html, /name="genre\[\]"[^>]*value="([^"]+)"/g).map((m) => m[1] ?? '');
        return [...new Set(names)].filter(Boolean).map((n) => ({ id: n, name: n, group: 'genre' }));
      });
    },

    async search(f) {
      const p = new URLSearchParams({ s: f.q ?? '', post_type: 'wp-manga' });
      const order = ORDER[f.sort ?? 'relevance'];
      if (order) p.set('m_orderby', order);
      for (const g of f.includeTags ?? []) p.append('genre[]', g.toLowerCase().replace(/\s+/g, '-'));
      for (const s of f.status ?? []) {
        const upstream = Object.entries(STATUS_OUT).find(([, v]) => v === s)?.[0];
        if (upstream) p.append('status[]', upstream.replace(/\s+/g, '-'));
      }
      const page = f.page ?? 1;
      const url = page > 1 ? `${site.base}/page/${page}/?${p}` : `${site.base}/?${p}`;

      const html = await cached(`${site.id}:search:${page}:${p}`, defaultTtl(), () => fetchText(url, { referer }));
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
      // Site Madara bloqueia por volume (403 depois de algumas dezenas de hits);
      // lista de capitulo muda devagar, entao vale cache longo.
      return cached(`${site.id}:series:${id}`, 6 * 60 * 60 * 1000, async () => {
        const page = await fetchText(`${site.base}/manga/${id}/`, { referer });

        // A lista completa vem por AJAX; a pagina so' traz as ultimas.
        let listHtml = page;
        const ajax = await httpFetch(`${site.base}/manga/${id}/ajax/chapters/`, {
          referer: `${site.base}/manga/${id}/`,
          headers: { 'X-Requested-With': 'XMLHttpRequest', 'Content-Length': '0' },
          timeoutMs: 25_000,
        }).catch(() => null);
        if (ajax?.ok) {
          const body = await ajax.text();
          if (body.includes('wp-manga-chapter') || body.includes('/manga/')) listHtml = body;
        }

        const chapters: ChapterRef[] = all(listHtml, /<a href="([^"]*\/manga\/[^"]*?\/[^"/]+\/)"[^>]*>([\s\S]*?)<\/a>/g)
          .map((m) => {
            const href = m[1] ?? '';
            const label = stripTags(m[2] ?? '');
            const slug = href.replace(`${site.base}/manga/${id}/`, '').replace(/\/$/, '');
            return { href, label, slug };
          })
          .filter((c) => c.slug && !c.slug.includes('/') && /chapter|cap/i.test(c.slug))
          .map(
            (c): ChapterRef => ({
              id: `${id}/${c.slug}`,
              provider: site.id,
              seriesId: id,
              number: /(\d+(?:[.-]\d+)?)/.exec(c.slug)?.[1]?.replace('-', '.'),
              title: c.label || c.slug,
              lang: site.lang,
            }),
          )
          .filter((c, i, arr) => arr.findIndex((o) => o.id === c.id) === i)
          .reverse();

        const status = (field(page, 'Status') ?? '').toLowerCase();
        const year = field(page, 'Release');
        const detail: SeriesDetail = {
          id,
          provider: site.id,
          title: stripTags(first(page, /<div class="post-title">\s*<h1[^>]*>([\s\S]*?)<\/h1>/) ?? id),
          altTitles: (field(page, 'Alternative') ?? '')
            .split(/[,;|]/)
            .map((t) => t.trim())
            .filter(Boolean),
          cover: first(page, /<div class="summary_image">[\s\S]*?<img[^>]+src="([^"]+)"/),
          coverReferer: referer,
          description: stripTags(
            first(page, /<div class="description-summary">([\s\S]*?)<\/div>\s*<\/div>/) ??
              first(page, /<div class="summary__content[^"]*">([\s\S]*?)<\/div>/) ??
              '',
          ),
          status: STATUS_OUT[status],
          year: year && /^\d{4}$/.test(year) ? Number(year) : undefined,
          origin: 'ja',
          type: 'manga',
          tags: (field(page, 'Genre') ?? '')
            .split(',')
            .map((t) => t.trim())
            .filter(Boolean),
          authors: (field(page, 'Author') ?? '')
            .split(',')
            .map((t) => t.trim())
            .filter(Boolean),
          url: `${site.base}/manga/${id}/`,
          chapters,
          availableLangs: [site.lang],
        };
        return detail;
      });
    },

    async pages(chapterId) {
      const html = await fetchText(`${site.base}/manga/${chapterId}/`, { referer });
      const body = /<div class="reading-content">([\s\S]*?)<\/div>\s*<\/div>/.exec(html)?.[1] ?? html;
      const urls = all(body, /<img[^>]+(?:data-src|src)="([^"]+)"/g)
        .map((m) => (m[1] ?? '').trim())
        .filter((u) => /^https?:/.test(u) && !/logo|icon|placeholder/i.test(u));
      const out: PageRef[] = [...new Set(urls)].map((url) => ({ url, referer }));
      return out;
    },
  };
}

/** Sites embutidos + os que o usuario declarar em MADARA_SITES. */
export function madaraSites(): MadaraSite[] {
  const builtin: MadaraSite[] = [
    { id: 'mangaread', name: 'MangaRead', base: 'https://www.mangaread.org', lang: 'en', contentType: 'manga' },
  ];
  const extra = (process.env['MADARA_SITES'] ?? '')
    .split(';')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry): MadaraSite | null => {
      // formato: id|Nome|https://site|lang|tipo (tipo e' opcional, default 'manga')
      const [id, name, base, lang, type] = entry.split('|').map((s) => s.trim());
      if (!id || !base) return null;
      const contentType: ContentType = type === 'hq' || type === 'livro' ? type : 'manga';
      return { id, name: name || id, base: base.replace(/\/+$/, ''), lang: lang || 'en', contentType };
    })
    .filter((s): s is MadaraSite => s !== null);

  return [...builtin, ...extra];
}
