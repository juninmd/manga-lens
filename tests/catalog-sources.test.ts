import { afterEach, describe, expect, test } from 'bun:test';
import { absoluteUrl, attr, container, imageUrls, pathUrl } from '../src/server/providers/html.ts';
import { createMadaraProvider, madaraSites } from '../src/server/providers/madara.ts';
import { createThemesiaProvider } from '../src/server/providers/themesia.ts';
import { katanaImages } from '../src/server/providers/mangakatana.ts';
import { normalizeProviderImage } from '../src/server/provider-image.ts';
import { builtinMadaraSites, builtinThemesiaSites } from '../src/server/providers/sites.ts';
import { config, hostAllowed } from '../src/server/config.ts';
import { httpFetch } from '../src/server/http.ts';
import { hqnow } from '../src/server/providers/hqnow.ts';

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

describe('HTML das novas fontes', () => {
  test('atributos reordenados, aspas simples, entidades e lazy load', () => {
    expect(attr("<a title='A &amp; B' href='/manga/a'>", 'title')).toBe('A & B');
    expect(imageUrls(`<img src="/placeholder.gif" data-src="//cdn.example.org/page.jpg">`, 'https://example.org/')).toEqual(['https://cdn.example.org/page.jpg']);
    expect(absoluteUrl('javascript:alert(1)', 'https://example.org')).toBeUndefined();
  });
  test('container inclui todos os divs internos e exclui propaganda posterior', () => {
    const html = `<div class='reading-content'><div><img src='/1.jpg'></div><div><img src='/2.jpg'></div></div><div><img src='/ad.jpg'></div>`;
    expect(imageUrls(container(html, ['reading-content'])!, 'https://example.org')).toEqual(['https://example.org/1.jpg', 'https://example.org/2.jpg']);
    expect(container('<div class="other"></div>', ['reading-content'])).toBeUndefined();
  });
  test('IDs de serie/capitulo nao podem sair da origem ou atravessar diretorios', () => {
    for (const id of ['https://evil.test/x', '//evil.test', '../x', '%2e%2e/x', '%252e%252e/x', 'foo%2fbar', 'x?y=1', 'foo\\bar']) {
      expect(() => pathUrl('https://example.org/manga', id)).toThrow();
    }
    expect(pathUrl('https://example.org/manga', 'title/season-1/chapter-2')).toBe('https://example.org/manga/title/season-1/chapter-2');
  });
  test('MangaKatana escolhe a matriz que o leitor usa sem executar JavaScript', () => {
    const html = `var advert=['https://ads.test/x']; var pages=['https://i1.mangakatana.com/1.jpg','https://i1.mangakatana.com/2.jpg',]; obj.attr('data-src', pages[i]);`;
    expect(katanaImages(html)).toEqual(['https://i1.mangakatana.com/1.jpg', 'https://i1.mangakatana.com/2.jpg']);
    expect(katanaImages('alert(1)')).toEqual([]);
  });
});

test('Madara: HQ em caminho customizado, AJAX POST, temporada e leitor sem anuncios', async () => {
  const unique = crypto.randomUUID();
  const base = 'https://fixture-hq.test';
  const calls: { url: string; method?: string }[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, method: init?.method });
    if (url.includes('?')) return new Response(`<div class='row c-tabs-item__content'><a title='HQ &amp; A' href='${base}/comic/story/'><img src='/placeholder.gif' data-src='/cover.jpg'></a></div>`);
    if (url.endsWith('ajax/chapters/')) return new Response(`<li class='wp-manga-chapter'><a href='${base}/comic/story/season-1/chapter-2/'>Chapter 2</a></li><li class='wp-manga-chapter'><a href='${base}/comic/story/season-1/chapter-1/'>Chapter 1</a></li>`);
    if (url.endsWith('chapter-1/')) return new Response(`<div class='reading-content'><div><img src='/1.jpg'></div><div><img src='/2.jpg'></div></div><img src='/advert.jpg'>`);
    return new Response(`<div class='post-title'><h1>HQ &amp; A</h1></div>`);
  }) as unknown as typeof fetch;
  const p = createMadaraProvider({ id: unique, name: 'HQ Fixture', base, lang: 'es', contentType: 'hq', seriesPath: 'comic' });
  const search = await p.search({});
  expect(search.items[0]).toMatchObject({ id: 'story', contentType: 'hq', type: 'comic', cover: `${base}/cover.jpg` });
  const detail = await p.series('story');
  expect(detail.chapters.map((c) => c.number)).toEqual(['1', '2']);
  expect(calls.find((c) => c.url.endsWith('ajax/chapters/'))?.method).toBe('POST');
  expect((await p.pages(detail.chapters[0]!.id)).map((p) => p.url)).toEqual([`${base}/1.jpg`, `${base}/2.jpg`]);
});

test('MangaThemesia: ignora novels e interpreta o JSON do leitor', async () => {
  const base = 'https://fixture-themesia.test';
  const id = crypto.randomUUID();
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes('?')) return new Response(`<div class="bsx"><a href="${base}/manga/book" title="Novel"><span class="novelabel">Novel</span></a></div><div class="bsx"><a title="Mangá" href="${base}/manga/story"><img src="/cover.jpg"></a></div>`);
    if (url.endsWith('/chapter-1')) return new Response(`<script>ts_reader.run({"sources":[{"images":["${base}/1.jpg","${base}/2.jpg"]}]});</script>`);
    return new Response(`<h1>Bad ad heading</h1><h1 class="entry-title">Mangá</h1><div class="eplister"><li><a href="${base}/chapter-1"><span class="chapternum">Chapter 1</span></a></li></div>`);
  }) as unknown as typeof fetch;
  const p = createThemesiaProvider({ id, name: 'Fixture', base, lang: 'en', contentType: 'manga' });
  expect((await p.search({})).items.map((c) => c.id)).toEqual(['manga/story']);
  const detail = await p.series('manga/story');
  expect(detail.title).toBe('Mangá');
  expect((await p.pages(detail.chapters[0]!.id))).toHaveLength(2);
});

test('MangaKatana: octet-stream exige assinatura de imagem e origem exata', async () => {
  const response = () => new Response(Uint8Array.from([255, 216, 255, 1, 2, 3]), { headers: { 'Content-Type': 'application/octet-stream' } });
  expect((await normalizeProviderImage(response(), 'i1.mangakatana.com')).headers.get('content-type')).toBe('image/jpeg');
  expect((await normalizeProviderImage(response(), 'evil.test')).headers.get('content-type')).toBe('application/octet-stream');
  await expect(normalizeProviderImage(new Response('<html>', { headers: { 'Content-Type': 'application/octet-stream' } }), 'i1.mangakatana.com')).rejects.toThrow('conteudo de imagem invalido');
});

test('HQ Now usa variaveis GraphQL, ordena edicoes e promove somente o CDN conhecido para HTTPS', async () => {
  const id = String(Math.floor(Math.random() * 100_000_000) + 1);
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    if (body.query.includes('getHqsById')) {
      expect(body.variables.id).toBe(Number(id));
      return Response.json({ data: { getHqsById: [{ id: Number(id), name: 'HQ', hqCover: 'http://static.hq-now.com/cover.jpg',
        capitulos: [{ id: 2, name: 'Segunda', number: 2 }, { id: 1, name: 'Primeira', number: 1 }] }] } });
    }
    return Response.json({ data: { getChapterById: { pictures: [{ pictureUrl: 'http://static.hq-now.com/page.jpg' }] } } });
  }) as unknown as typeof fetch;
  const detail = await hqnow.series(id);
  expect(detail.cover).toBe('https://static.hq-now.com/cover.jpg');
  expect(detail.chapters.map((c) => c.number)).toEqual(['1', '2']);
  expect((await hqnow.pages('1'))[0]!.url).toBe('https://static.hq-now.com/page.jpg');
  await expect(hqnow.series('1) { exploit }')).rejects.toThrow('id de HQ invalido');
});

test('catalogo embutido tem IDs e origens unicos, CDNs explicitos', () => {
  const sites = [...builtinMadaraSites, ...builtinThemesiaSites];
  expect(new Set(sites.map((s) => s.id)).size).toBe(sites.length);
  expect(new Set(sites.map((s) => s.base)).size).toBe(sites.length);
  for (const site of sites) {
    createMadaraProvider(site);
    expect(new URL(site.base).protocol).toBe('https:');
    for (const host of site.imageHosts ?? []) expect(hostAllowed(host)).toBe(true);
  }
  const previous = process.env['MADARA_SITES'];
  try {
    process.env['MADARA_SITES'] = 'mangaread|Override|https://override.test|pt-br|hq|comic|cdn.override.test';
    const configured = madaraSites().filter((s) => s.id === 'mangaread');
    expect(configured).toHaveLength(1);
    expect(configured[0]).toMatchObject({ contentType: 'hq', seriesPath: 'comic', imageHosts: ['cdn.override.test'] });
  } finally { if (previous === undefined) delete process.env['MADARA_SITES']; else process.env['MADARA_SITES'] = previous; }
});

test('mais de 16 requisicoes upstream sao enfileiradas; cancelamento nao inicia fetch', async () => {
  let active = 0;
  let peak = 0;
  globalThis.fetch = (async () => {
    active++;
    peak = Math.max(peak, active);
    await Bun.sleep(10);
    active--;
    return new Response('ok');
  }) as unknown as typeof fetch;
  await Promise.all(Array.from({ length: 24 }, (_, i) => httpFetch(`https://fixture.test/${i}`, { retries: 0 })));
  expect(peak).toBeLessThanOrEqual(16);
  const controller = new AbortController();
  controller.abort();
  await expect(httpFetch('https://fixture.test/cancel', { signal: controller.signal })).rejects.toThrow('cancelada');
  expect(active).toBe(0);
  expect(config.searchTimeoutMs).toBeGreaterThan(0);
});
