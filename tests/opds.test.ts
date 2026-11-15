import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config } from '../src/server/config.ts';
import { acquisitionOf, createOpdsProvider, navigationOf, opdsCatalogs, parseFeed } from '../src/server/providers/opds.ts';
import { enabledProviders, providers } from '../src/server/providers/index.ts';
import server from '../src/server/index.ts';

const dir = await mkdtemp(join(tmpdir(), 'manga-lens-opds-'));
const savedCache = config.cacheDir;
config.cacheDir = dir;
afterAll(async () => {
  config.cacheDir = savedCache;
  await rm(dir, { recursive: true, force: true });
});

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const CBR = await Bun.file(join(import.meta.dir, 'fixtures', 'comic.cbr')).bytes();
const EPUB = await Bun.file(join(import.meta.dir, 'fixtures', 'livro.epub')).bytes();
const ROOT = 'http://komga.lan:25600/opds/v1.2/catalog';
const AUTH = `Basic ${Buffer.from('leitor:segredo').toString('base64')}`;
const atom = 'application/atom+xml;profile=opds-catalog';

const feed = (title: string, body: string, extra = '') =>
  `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><title>${title}</title>
  <link rel="search" type="application/opensearchdescription+xml" href="/opds/v1.2/search"/>${extra}${body}</feed>`;
const series = `<entry><title>Plastic &amp; Co</title><id>s1</id><author><name>Jack Cole</name></author>
  <summary>&lt;p&gt;HQ da &lt;b&gt;Golden Age&lt;/b&gt;&lt;/p&gt;</summary>
  <link rel="http://opds-spec.org/image/thumbnail" type="image/jpeg" href="/opds/v1.2/covers/s1"/>
  <link rel="subsection" type="${atom};kind=acquisition" href="series/s1"/></entry>`;
const issue = (n: number) => `<entry><title>Plastic #${n}</title><id>i${n}</id>
  <link rel="http://opds-spec.org/acquisition" type="application/x-cbr" href="/opds/v1.2/books/${n}/file"/></entry>`;
const novel = `<entry><title>O Livro de Teste</title><id>n1</id><author><name>Maria Autora</name></author><dc:language>EN</dc:language>
  <category term="ficcao" label="Ficção"/>
  <link rel="http://opds-spec.org/acquisition/open-access" type="application/pdf" href="/opds/v1.2/books/n1/pdf"/>
  <link rel="http://opds-spec.org/acquisition/open-access" type="application/epub+zip" href="/opds/v1.2/books/n1/epub"/></entry>`;

interface Server {
  urls: string[];
  auth: (string | null)[];
}

/** Komga falso: exige Basic auth, busca por OpenSearch, serie com 2 paginas de feed. */
function fakeKomga(overrides: Record<string, () => Response> = {}): Server {
  const seen: Server = { urls: [], auth: [] };
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    seen.urls.push(url.href);
    const headers = new Headers(init?.headers);
    seen.auth.push(headers.get('authorization'));
    const custom = overrides[url.pathname];
    if (custom) return Promise.resolve(custom());
    if (headers.get('authorization') !== AUTH) return Promise.resolve(new Response('', { status: 401 }));
    const xml = (body: string) => Promise.resolve(new Response(body, { headers: { 'Content-Type': atom } }));
    switch (url.pathname) {
      case '/opds/v1.2/catalog':
        return xml(feed('Raiz', `<entry><title>Latest series</title><id>l</id><link rel="http://opds-spec.org/sort/new" type="${atom}" href="/opds/v1.2/series/latest"/></entry>`));
      case '/opds/v1.2/series/latest':
        return xml(feed('Latest', series + novel, '<link rel="next" type="application/atom+xml" href="/opds/v1.2/series/latest?page=1"/>'));
      case '/opds/v1.2/search':
        return Promise.resolve(new Response(`<OpenSearchDescription><Url type="text/html" template="/web?q={searchTerms}"/><Url type="${atom}" template="/opds/v1.2/find?q={searchTerms}&amp;p={startPage?}"/></OpenSearchDescription>`));
      case '/opds/v1.2/find':
        return xml(feed('Busca', url.searchParams.get('q') === 'plastic' ? series : ''));
      case '/opds/v1.2/series/s1':
        // pagina 2 repete a #2 de proposito: servidor que reenvia item na virada de pagina nao duplica capitulo
        return xml(url.search ? feed('Plastic Man', issue(2) + issue(2)) : feed('Plastic Man', issue(1), '<link rel="next" type="application/atom+xml" href="/opds/v1.2/series/s1?page=2"/>'));
      case '/opds/v1.2/books/1/file':
      case '/opds/v1.2/books/2/file':
        return Promise.resolve(new Response(CBR));
      case '/opds/v1.2/books/n1/epub':
        return Promise.resolve(new Response(EPUB));
      case '/opds/v1.2/covers/s1':
        return Promise.resolve(new Response('img', { headers: { 'Content-Type': 'image/jpeg' } }));
      default:
        return Promise.resolve(new Response('nao achei', { status: 404 }));
    }
  }) as typeof fetch;
  return seen;
}

const catalog = { id: 'casa', name: 'Casa', url: ROOT, auth: 'leitor:segredo', contentType: 'hq' as const, lang: 'en' };

describe('configuracao', () => {
  test('OPDS_CATALOGS: credencial e tipo opcionais; esquema e id invalidos ficam de fora', () => {
    expect(opdsCatalogs('komga|Minha Komga|http://192.168.0.10:25600/opds/v1.2/catalog|eu:senha|hq;calibre||https://livros.test/opds')).toEqual([
      // HQ sem idioma declarado: ingles, para o OCR nao cair no modelo japones
      { id: 'komga', name: 'Minha Komga', url: 'http://192.168.0.10:25600/opds/v1.2/catalog', auth: 'eu:senha', contentType: 'hq', lang: 'en' },
      { id: 'calibre', name: 'calibre', url: 'https://livros.test/opds', contentType: 'manga' },
    ]);
    expect(opdsCatalogs('m|M|https://m.test/opds||manga|ja')[0]).toMatchObject({ contentType: 'manga', lang: 'ja' });
    expect(opdsCatalogs('m|M|https://m.test/opds||manga|<script>')[0]!.lang).toBeUndefined();
    expect(opdsCatalogs('x|X|file:///etc/passwd;../y|Y|https://a.test;z|Z|nao e url')).toEqual([]);
  });

  test('o catalogo aparece em toda aba: cada obra decide a sua', () => {
    const p = createOpdsProvider(catalog);
    expect(p.mixed).toBe(true);
    // a biblioteca local continua mista do mesmo jeito
    expect(enabledProviders('livro').some((x) => x.id === 'local') || config.localRoots.length === 0).toBe(true);
  });
});

describe('leitura do feed', () => {
  test('entrada de navegacao, aquisicao, autor, resumo sem HTML e idioma', () => {
    const parsed = parseFeed(feed('F', series + novel));
    const [s, n] = parsed.entries;
    expect(s).toMatchObject({ title: 'Plastic & Co', authors: ['Jack Cole'], summary: 'HQ da Golden Age' });
    expect(navigationOf(s!)).toBe('series/s1');
    expect(acquisitionOf(s!)).toBeNull();
    // EPUB vence PDF: e' o formato que o leitor de livro abre melhor
    expect(acquisitionOf(n!)).toEqual({ href: '/opds/v1.2/books/n1/epub', kind: 'epub' });
    expect(n).toMatchObject({ lang: 'en', tags: ['Ficção'] });
    expect(parsed.links.find((l) => l.rel === 'search')?.href).toBe('/opds/v1.2/search');
  });
});

describe('catalogo OPDS', () => {
  test('sem busca abre a estante "recentes", com a credencial em toda requisicao', async () => {
    const seen = fakeKomga();
    const { items } = await createOpdsProvider(catalog).search({});
    expect(items.map((i) => [i.title, i.contentType])).toEqual([
      ['Plastic & Co', 'hq'],
      ['O Livro de Teste', 'livro'],
    ]);
    expect(items[0]!.cover).toStartWith('/api/opds/cover?p=opds-casa&u=');
    expect(seen.auth.every((a) => a === AUTH)).toBe(true);
  });

  test('busca pelo template do OpenSearch (o do Atom, nao o HTML); filtro de aba vale', async () => {
    const seen = fakeKomga();
    const p = createOpdsProvider(catalog);
    expect((await p.search({ q: 'plastic' })).items.map((i) => i.title)).toEqual(['Plastic & Co']);
    expect(seen.urls.at(-1)).toBe('http://komga.lan:25600/opds/v1.2/find?q=plastic&p=');
    expect((await p.search({ contentType: 'livro' })).items.map((i) => i.title)).toEqual(['O Livro de Teste']);
  });

  test('serie: todas as paginas do feed viram capitulos; paginas saem do arquivo baixado', async () => {
    fakeKomga();
    const p = createOpdsProvider(catalog);
    const card = (await p.search({ q: 'plastic' })).items[0]!;
    const detail = await p.series(card.id);
    expect(detail.title).toBe('Plastic Man');
    expect(detail.chapters.map((c) => c.title)).toEqual(['Plastic #1', 'Plastic #2']);
    // o idioma do scan vai no capitulo: e' o que escolhe o modelo do OCR
    expect(detail.chapters.every((c) => c.lang === 'en')).toBe(true);
    // o painel filtra capitulos pelos idiomas disponiveis: os dois tem de bater, senao a lista some
    expect(detail.availableLangs).toEqual(['en']);
    const pages = await p.pages(detail.chapters[0]!.id);
    expect(pages).toHaveLength(3);
    expect(pages[0]!.url).toStartWith('/api/opds/page?p=opds-casa&c=a.');
    const { kind, names } = await p.archive(detail.chapters[0]!.id);
    expect(kind).toBe('cbr');
    expect(names).toHaveLength(3);
  });

  test('livro avulso: os capitulos do proprio EPUB, em paragrafos', async () => {
    fakeKomga();
    const p = createOpdsProvider(catalog);
    const card = (await p.search({ contentType: 'livro' })).items[0]!;
    const detail = await p.series(card.id);
    expect(detail.authors).toEqual(['Maria Autora']);
    expect(detail.chapters.every((c) => c.text)).toBe(true);
    const blocks = await p.book!(detail.chapters[0]!.id);
    expect(blocks.map((b) => b.text)).toContain('Café & jornal <velho>.');
  });

  test('credencial errada vira mensagem que diz o que conferir', async () => {
    fakeKomga();
    await expect(createOpdsProvider({ ...catalog, auth: 'leitor:errada' }).search({})).rejects.toThrow('confira usuario e senha');
  });

  test('href para outro servidor nao e seguido, e a credencial nao vaza', async () => {
    const seen = fakeKomga({
      '/opds/v1.2/series/latest': () => new Response(feed('L', `<entry><title>X</title><link rel="subsection" type="${atom}" href="http://169.254.169.254/latest"/></entry>`)),
    });
    const p = createOpdsProvider(catalog);
    // a entrada com href de fora some do feed em vez de virar um card que levaria a credencial embora
    expect((await p.search({})).items).toEqual([]);
    await expect(p.series(`n.${Buffer.from(JSON.stringify({ h: 'http://169.254.169.254/latest' })).toString('base64url')}`)).rejects.toThrow('fora do proprio servidor');
    await expect(p.series(`n.${Buffer.from('{}').toString('base64url')}`)).rejects.toThrow('invalida');
    expect(seen.urls.some((u) => u.includes('169.254'))).toBe(false);
  });

  test('redirect para outra origem e recusado antes de seguir', async () => {
    const seen = fakeKomga({
      '/opds/v1.2/catalog': () => new Response(null, { status: 302, headers: { location: 'https://outro.test/roubo' } }),
    });
    await expect(createOpdsProvider(catalog).search({})).rejects.toThrow('fora do proprio servidor');
    expect(seen.urls.some((u) => u.includes('outro.test'))).toBe(false);
  });

  test('pagina de login com status 200 nao entra no cache como CBR', async () => {
    fakeKomga({ '/opds/v1.2/books/1/file': () => new Response('<html>login</html>') });
    const p = createOpdsProvider({ ...catalog, id: 'login' });
    const detail = await p.series((await p.search({ q: 'plastic' })).items[0]!.id);
    await expect(p.pages(detail.chapters[0]!.id)).rejects.toThrow('CBR valido');
  });

  test('id de capitulo forjado e recusado', async () => {
    fakeKomga();
    const p = createOpdsProvider(catalog);
    const forged = `a.${Buffer.from(JSON.stringify({ a: 'http://outro.test/x.cbz', k: 'cbz' })).toString('base64url')}`;
    await expect(p.pages(forged)).rejects.toThrow('fora do proprio servidor');
    await expect(p.pages(`a.${Buffer.from(JSON.stringify({ a: '/x', k: 'exe' })).toString('base64url')}`)).rejects.toThrow('invalido');
    await expect(p.book!('x.y')).rejects.toThrow('invalido');
  });

  test('capa: buscada com a credencial; resposta que nao e imagem e recusada', async () => {
    fakeKomga({ '/opds/v1.2/covers/html': () => new Response('<html>', { headers: { 'Content-Type': 'text/html' } }) });
    const p = createOpdsProvider(catalog);
    expect((await p.cover('/opds/v1.2/covers/s1')).headers.get('content-type')).toBe('image/jpeg');
    await expect(p.cover('/opds/v1.2/covers/html')).rejects.toThrow('nao e uma imagem');
  });
});

describe('rotas do catalogo', () => {
  const route = (path: string): Promise<Response> => Promise.resolve(server.fetch(new Request(`http://127.0.0.1${path}`)));

  test('pagina sai do arquivo no cache; capa vem com a credencial; provider de outro tipo e recusado', async () => {
    fakeKomga();
    const p = createOpdsProvider({ ...catalog, id: 'rota' });
    providers.push(p);
    try {
      const detail = await p.series((await p.search({ q: 'plastic' })).items[0]!.id);
      const [page] = await p.pages(detail.chapters[0]!.id);
      const res = await route(page!.url);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('image/png');
      // sem ACAO "*": o token aponta para o servidor do usuario
      expect(res.headers.get('access-control-allow-origin')).toBeNull();
      expect((await route(page!.url.replace(/i=\d+$/, 'i=99'))).status).toBe(404);

      const cover = await route(detail.cover!);
      expect(cover.status).toBe(200);
      expect(await cover.text()).toBe('img');

      expect((await route('/api/opds/page?p=mangadex&c=x&i=0')).status).toBe(404);
      expect((await route('/api/opds/page?p=opds-rota&c=lixo&i=0')).status).toBe(422);
    } finally {
      providers.splice(providers.indexOf(p), 1);
    }
  });
});
