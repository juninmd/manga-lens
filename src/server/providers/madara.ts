import { fetchText, httpFetch } from '../http.ts';
import { registerImageHost, registerSourceUserAgent } from '../config.ts';
import { cached, defaultTtl } from '../cache.ts';
import { all, chunks, first, stripTags } from '../scrape.ts';
import type { ChapterRef, ContentType, PageRef, Provider, SeriesCard, SeriesDetail, TagInfo } from './types.ts';
import { absoluteUrl, attr, container, imageUrls, pathUrl } from './html.ts';
import { builtinMadaraSites } from './sites.ts';

export interface MadaraSite {
  id: string;
  name: string;
  base: string;
  /** idioma dos scans publicados no site */
  lang: string;
  /** tipo de conteudo do site (mangá por padrão; alguns Madara servem HQ) */
  contentType: ContentType;
  seriesPath?: string;
  imageHosts?: string[];
  userAgent?: string;
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

/**
 * O Madara publica a nota no card (`<span class="... total_votes">3.3</span>`),
 * mas numa escala de 0 a 5 — o MangaDex usa 0 a 10. Mostrar os dois crus na
 * mesma estrela faria uma obra bem avaliada aqui (4.1) parecer pior que uma
 * mediana de la'; por isso sobe para a mesma escala. Nota 0 e' "ninguem votou",
 * nao "pessima": vira ausencia de nota.
 */
export function ratingOf(block: string): number | undefined {
  const raw = first(block, /class="[^"]*total_votes[^"]*">\s*([\d.]+)\s*</);
  const score = Number(raw);
  if (!Number.isFinite(score) || score <= 0) return undefined;
  return Math.round(Math.min(score, 5) * 2 * 10) / 10;
}

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
  const root = `${site.base}/${site.seriesPath ?? 'manga'}/`;
  const seriesUrl = (id: string): string => `${pathUrl(root, id)}/`;
  // as paginas sao servidas pelo proprio dominio do site (wp-content/uploads)
  registerImageHost(new URL(site.base).hostname);
  for (const host of site.imageHosts ?? []) registerImageHost(host);
  if (site.userAgent) for (const host of [new URL(site.base).hostname, ...site.imageHosts ?? []]) registerSourceUserAgent(host, site.userAgent);

  const parseCards = (html: string): SeriesCard[] =>
    chunks(html, /<div\b[^>]*class=["'][^"']*\b(?:c-tabs-item__content|page-item-detail)\b[^"']*["'][^>]*>/g)
      .map((block): SeriesCard | null => {
        const link = all(block, /<a\b[^>]*>([\s\S]*?)<\/a>/gi).find((m) => absoluteUrl(attr(m[0], 'href'), referer)?.startsWith(root));
        const href = link ? absoluteUrl(attr(link[0], 'href'), referer) : undefined;
        const title = link ? attr(link[0].split('>')[0]!, 'title') || stripTags(link[1] ?? '') || attr(first(block, /(<img\b[^>]*>)/i) ?? '', 'alt') : undefined;
        if (!href || !title) return null;
        if (/\((?:novela?|light novel|web novel)\)/i.test(title)) return null;
        const id = href.slice(root.length).replace(/\/$/, '');
        if (!id || id.includes('/') || id === 'feed') return null;
        const status = (field(block, 'Status') ?? '').toLowerCase();
        const year = field(block, 'Release');
        return {
          id,
          provider: site.id,
          title: stripTags(title),
          altTitles: (field(block, 'Alternative') ?? '')
            .split(/[,;|]/)
            .map((t) => t.trim())
            .filter(Boolean),
          cover: imageUrls(block, referer)[0],
          coverReferer: referer,
          year: year && /^\d{4}$/.test(year) ? Number(year) : undefined,
          rating: ratingOf(block),
          status: STATUS_OUT[status],
          type: site.contentType === 'hq' ? 'comic' : 'manga',
          contentType: site.contentType,
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

      const html = await cached(`${site.id}:search:v2:${page}:${p}`, defaultTtl(), () => fetchText(url, { referer, signal: f.signal }));
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
        const url = seriesUrl(id);
        const page = await fetchText(url, { referer });

        // A lista completa vem por AJAX; a pagina so' traz as ultimas.
        let listHtml = page;
        const ajax = await httpFetch(`${url}ajax/chapters/`, {
          method: 'POST',
          body: '',
          referer: url,
          headers: { 'X-Requested-With': 'XMLHttpRequest', 'Content-Type': 'application/x-www-form-urlencoded' },
          timeoutMs: 12_000,
          retries: 0,
        }).catch(() => null);
        if (ajax?.ok) {
          const body = await ajax.text();
          if (/<li\b[^>]*class=["'][^"']*wp-manga-chapter/.test(body)) listHtml = body;
        }

        const mangaId = first(page, /id=["']manga-chapters-holder["'][^>]*data-id=["'](\d+)["']/) ?? first(page, /data-(?:id|post-id)=["'](\d+)["']/);
        if (mangaId && listHtml === page) {
          const legacy = await httpFetch(`${site.base}/wp-admin/admin-ajax.php`, {
            method: 'POST', body: new URLSearchParams({ action: 'manga_get_chapters', manga: mangaId }).toString(),
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, referer: url, retries: 0,
          }).catch(() => null);
          if (legacy?.ok) { const body = await legacy.text(); if (body.includes('wp-manga-chapter')) listHtml = body; }
        }

        const chapters: ChapterRef[] = all(listHtml, /<a\b[^>]*>([\s\S]*?)<\/a>/gi)
          .map((m) => {
            const href = absoluteUrl(attr(m[0].split('>')[0]!, 'href'), referer) ?? '';
            const label = stripTags(m[1] ?? '');
            const slug = href.startsWith(url) ? href.slice(url.length).replace(/\/$/, '') : '';
            return { label, slug };
          })
          .filter((c) => c.slug && !/[?#]/.test(c.slug) && !c.slug.startsWith('ajax'))
          .map(
            (c): ChapterRef => ({
              id: `${id}/${c.slug}`,
              provider: site.id,
              seriesId: id,
              number: /(?:chapter|cap[ií]tulo|chapitre|#)\s*[-:]?\s*(\d+(?:[.-]\d+)?)/i.exec(c.label)?.[1]?.replace('-', '.'),
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
          title: stripTags(first(container(page, ['post-title']) ?? page, /<h1\b[^>]*>([\s\S]*?)<\/h1>/i) ?? id).replace(/\s+/g, ' '),
          altTitles: (field(page, 'Alternative') ?? '')
            .split(/[,;|]/)
            .map((t) => t.trim())
            .filter(Boolean),
          cover: imageUrls(container(page, ['summary_image']) ?? '', referer)[0],
          coverReferer: referer,
          description: stripTags(
            first(page, /<div class="description-summary">([\s\S]*?)<\/div>\s*<\/div>/) ??
              first(page, /<div class="summary__content[^"]*">([\s\S]*?)<\/div>/) ??
              '',
          ),
          status: STATUS_OUT[status],
          year: year && /^\d{4}$/.test(year) ? Number(year) : undefined,
          rating: ratingOf(page),
          contentType: site.contentType,
          type: site.contentType === 'hq' ? 'comic' : 'manga',
          tags: (field(page, 'Genre') ?? '')
            .split(',')
            .map((t) => t.trim())
            .filter(Boolean),
          authors: (field(page, 'Author') ?? '')
            .split(',')
            .map((t) => t.trim())
            .filter(Boolean),
          url,
          chapters,
          availableLangs: [site.lang],
        };
        return detail;
      });
    },

    async pages(chapterId) {
      const url = seriesUrl(chapterId);
      const html = await fetchText(url, { referer });
      const body = container(html, ['reading-content', 'read-container']);
      if (body === undefined) throw new Error(`${site.name}: leitor de paginas nao encontrado`);
      const out: PageRef[] = imageUrls(body, url).map((image) => ({ url: image, referer: url }));
      if (!out.length) throw new Error(`${site.name}: capitulo sem paginas`);
      return out;
    },
  };
}

/** Sites embutidos + os que o usuario declarar em MADARA_SITES. */
export function madaraSites(): MadaraSite[] {
  const builtin = builtinMadaraSites;
  const extra = (process.env['MADARA_SITES'] ?? '')
    .split(';')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry): MadaraSite | null => {
      // formato: id|Nome|https://site|lang|tipo (tipo e' opcional, default 'manga')
      const [id, name, base, lang, type, seriesPath, hosts] = entry.split('|').map((s) => s.trim());
      if (!id || !base) return null;
      try { if (new URL(base).protocol !== 'https:') return null; } catch { return null; }
      const contentType: ContentType = type === 'hq' || type === 'livro' ? type : 'manga';
      return { id, name: name || id, base: base.replace(/\/+$/, ''), lang: lang || 'en', contentType,
        seriesPath: seriesPath || 'manga', imageHosts: hosts?.split(',').filter(Boolean) };
    })
    .filter((s): s is MadaraSite => s !== null);

  return [...new Map([...builtin, ...extra].map((s) => [s.id, s])).values()];
}
