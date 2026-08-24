/**
 * Homologacao real: sobe nada, so bate no servidor que ja' esta' rodando.
 * Uso: bun run smoke  (com o servidor no ar em PORT)
 */
export {};

const base = `http://127.0.0.1:${process.env['PORT'] ?? 7788}`;
let failures = 0;

/**
 * 403/429 de provider externo e' limite do site, nao defeito nosso: vira aviso
 * ruidoso em vez de falha, para o vermelho continuar significando bug daqui.
 */
const throttled = (message: string): boolean => /upstream (403|429)/.test(message);

async function check(name: string, fn: () => Promise<string>): Promise<void> {
  const started = Date.now();
  try {
    const detail = await fn();
    console.log(`OK   ${name} (${Date.now() - started}ms) ${detail}`);
  } catch (err) {
    const message = (err as Error).message;
    if (throttled(message)) {
      console.warn(`AVISO ${name}: provider limitou o acesso — ${message}`);
      return;
    }
    failures++;
    console.error(`FALHA ${name}: ${message}`);
  }
}

const get = async (path: string): Promise<any> => {
  const res = await fetch(base + path);
  if (!res.ok) throw new Error(`HTTP ${res.status} em ${path}`);
  return res.json();
};

await check('GET /api/providers', async () => {
  const list = await get('/api/providers');
  if (!Array.isArray(list) || list.length < 3) throw new Error('esperava 3+ providers');
  return list.map((p: { id: string }) => p.id).join(',');
});

await check('GET /api/tags (mangadex)', async () => {
  const tags = await get('/api/tags?provider=mangadex');
  if (tags.length < 20) throw new Error(`so ${tags.length} tags`);
  return `${tags.length} tags`;
});

let first: { provider: string; id: string } | undefined;
await check('GET /api/search agregada', async () => {
  const res = await get('/api/search?q=naruto&limit=6');
  if (!res.items?.length) throw new Error(`sem itens; erros: ${JSON.stringify(res.errors)}`);
  first = res.items[0];
  const cover = res.items.find((i: { cover?: string }) => i.cover)?.cover;
  if (cover && !cover.startsWith('/api/img?')) throw new Error('capa nao saiu proxiada/assinada');
  return `${res.items.length} itens — ${JSON.stringify(res.perProvider)}`;
});

await check('filtro completo (tags + status + ano + idioma)', async () => {
  const res = await get(
    '/api/search?providers=mangadex&includeTags=Romance&excludeTags=Ecchi&status=completed&langs=pt-br&yearFrom=2000&yearTo=2020&sort=rating&limit=6',
  );
  if (!res.items?.length) throw new Error(`filtro nao devolveu nada: ${JSON.stringify(res.errors)}`);
  return `${res.items.length} itens`;
});

await check('motores de traducao disponiveis', async () => {
  const list = (await get('/api/translate/engines')) as { id: string; needsAi: boolean }[];
  if (!list.some((e) => !e.needsAi)) throw new Error('nenhum motor sem IA');
  return list.map((e) => e.id).join(', ');
});

for (const engine of ['google', 'mymemory']) {
  await check(`traducao sem IA (${engine})`, async () => {
    const res = await fetch(`${base}/api/ai/translate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        engine,
        sourceLang: 'en',
        blocks: [
          { id: 0, text: "YOU DON'T HAVE WHAT IT TAKES" },
          { id: 1, text: '|| ~~ 4 @' },
        ],
      }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as { translations: { id: number; pt: string }[] };
    const first = data.translations.find((t) => t.id === 0)?.pt ?? '';
    if (!first) throw new Error('bloco util voltou vazio');
    if (data.translations.find((t) => t.id === 1)?.pt) throw new Error('bloco de ruido devia voltar vazio');
    return JSON.stringify(first);
  });
}

const translateReq = async (body: Record<string, unknown>): Promise<{ translations: { id: number; pt: string }[]; engine?: string }> => {
  const res = await fetch(`${base}/api/ai/translate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
};

await check('idiomas de destino disponiveis', async () => {
  const list = (await get('/api/translate/targets')) as { id: string; name: string }[];
  if (!list.some((t) => t.id === 'pt-BR')) throw new Error('pt-BR ausente da lista');
  if (list.length < 5) throw new Error(`so ${list.length} idiomas`);
  return list.map((t) => t.id).join(', ');
});

await check('modo automatico prefere motor sem IA', async () => {
  const data = await translateReq({
    sourceLang: 'en',
    blocks: [{ id: 0, text: 'THIS IS NOT THE END' }],
  });
  if (data.engine === 'llm') throw new Error('caiu na IA com os motores livres no ar');
  if (!data.translations[0]?.pt) throw new Error('traducao vazia');
  return `${data.engine}: ${JSON.stringify(data.translations[0]?.pt)}`;
});

await check('idioma de destino muda a saida', async () => {
  const source = [{ id: 0, text: 'THE SKY IS FALLING' }];
  const pt = await translateReq({ engine: 'google', sourceLang: 'en', target: 'pt-BR', blocks: source });
  const es = await translateReq({ engine: 'google', sourceLang: 'en', target: 'es', blocks: source });
  const a = pt.translations[0]?.pt ?? '';
  const b = es.translations[0]?.pt ?? '';
  if (!a || !b) throw new Error('algum destino voltou vazio');
  if (a === b) throw new Error(`pt-BR e es devolveram o mesmo texto: ${a}`);
  return `${JSON.stringify(a)} / ${JSON.stringify(b)}`;
});

for (const provider of ['mangadex', 'weebcentral', 'mangapill', 'mangaread']) {
  await check(`ciclo completo ${provider}`, async () => {
    const search = await get(`/api/search?providers=${provider}&q=naruto&limit=5`);
    if (!search.items?.length) throw new Error(`busca vazia: ${JSON.stringify(search.errors)}`);
    // a primeira entrada pode ser um registro sem capitulo lido'; procura uma que abra
    let detail: any;
    for (const item of search.items) {
      const d = await get(`/api/series?provider=${provider}&id=${encodeURIComponent(item.id)}`);
      if (d.chapters?.length) {
        detail = d;
        break;
      }
    }
    if (!detail) throw new Error('nenhuma serie da busca tinha capitulos');
    const chapter = detail.chapters.find((c: { lang?: string }) => c.lang === 'en') ?? detail.chapters[0];
    const pages = await get(`/api/pages?provider=${provider}&chapter=${encodeURIComponent(chapter.id)}`);
    if (!pages.pages?.length) throw new Error('capitulo sem paginas');
    const img = await fetch(base + pages.pages[0].url);
    if (!img.ok) throw new Error(`imagem proxiada HTTP ${img.status}`);
    const type = img.headers.get('content-type') ?? '';
    if (!type.startsWith('image/')) throw new Error(`proxy devolveu ${type}`);
    return `${detail.title}: ${detail.chapters.length} caps, ${pages.pages.length} paginas, capa ${type}`;
  });
}

await check('ciclo completo archive (HQ)', async () => {
  const search = await get('/api/search?providers=archive&q=mystery&limit=4');
  if (!search.items?.length) throw new Error(`busca vazia: ${JSON.stringify(search.errors)}`);
  const comic = search.items[0];
  if (comic.type !== 'comic') throw new Error(`esperava type=comic, veio ${comic.type}`);
  const detail = await get(`/api/series?provider=archive&id=${encodeURIComponent(comic.id)}`);
  if (!detail.chapters?.length) throw new Error('HQ sem capitulo');
  const pages = await get(`/api/pages?provider=archive&chapter=${encodeURIComponent(detail.chapters[0].id)}`);
  if (pages.pages.length < 5) throw new Error(`so ${pages.pages.length} paginas`);
  const img = await fetch(base + pages.pages[2].url);
  if (!img.ok) throw new Error(`imagem proxiada HTTP ${img.status}`);
  const type = img.headers.get('content-type') ?? '';
  if (!type.startsWith('image/')) throw new Error(`proxy devolveu ${type}`);
  return `${detail.title}: ${pages.pages.length} paginas, ${type}`;
});

await check('archive so devolve serie de dominio publico', async () => {
  // o recorte do provider e' uma lista de series livres; nome de franquia viva
  // nao pode voltar nada, nem quando cruza com serie da Golden Age ("Black Cat"
  // e' Harvey nos anos 40 e Marvel hoje)
  for (const q of ['spider-man', 'batman', 'superman', 'x-men', 'black cat']) {
    const res = await get(`/api/search?providers=archive&q=${encodeURIComponent(q)}&limit=5`);
    if (res.items?.length) {
      throw new Error(`"${q}" devolveu ${res.items.length}: ${res.items[0].title}`);
    }
  }
  const ok = await get('/api/search?providers=archive&q=plastic&limit=5');
  if (!ok.items?.length) throw new Error('serie livre (Plastic Man) sumiu junto');
  return `franquias vivas barradas, ${ok.items.length} edicoes livres em "plastic"`;
});

await check('proxy recusa URL nao assinada', async () => {
  const res = await fetch(`${base}/api/img?u=${Buffer.from('https://example.com/x.jpg').toString('base64url')}&r=&s=falsa`);
  if (res.status !== 403) throw new Error(`esperava 403, veio ${res.status}`);
  return '403';
});

await check('biblioteca local recusa caminho de fora', async () => {
  const providers = (await get('/api/providers')) as { id: string }[];
  if (!providers.some((p) => p.id === 'local')) return 'provider local desligado (sem LOCAL_LIBRARY)';
  const evil = Buffer.from('C:\\Windows\\win.ini', 'utf8').toString('base64url');
  const res = await fetch(`${base}/api/local/page?c=${evil}&i=0`);
  if (res.status !== 403) throw new Error(`esperava 403, veio ${res.status}`);
  return '403';
});

await check('tessdata do OCR', async () => {
  const res = await fetch(`${base}/api/tessdata/eng.traineddata.gz`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const size = (await res.arrayBuffer()).byteLength;
  if (size < 100_000) throw new Error(`modelo pequeno demais: ${size} bytes`);
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
});

await check('worker do tesseract servido localmente', async () => {
  const res = await fetch(`${base}/vendor/tesseract/worker.min.js`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return `${((await res.text()).length / 1024).toFixed(0)} KB`;
});

await check('GET /api/ai/health', async () => {
  const h = await get('/api/ai/health');
  return h.ok ? `${h.baseUrl} — ${h.models?.length ?? 0} modelos` : `offline (${h.error}) — esperado sem LLM no ar`;
});

console.log(failures ? `\n${failures} verificacao(oes) falharam` : '\ntudo verde');
process.exit(failures ? 1 : 0);
