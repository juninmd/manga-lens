import { Hono } from 'hono';
import { join, extname } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { config, getProviderConfig, hostAllowed, normalizeProvider, saveAiConfig, type AiProvider } from './config.ts';
import { signUrl, verifyUrl } from './sign.ts';
import { HttpError, httpFetch } from './http.ts';
import { enabledProviders, getProvider, searchAll } from './providers/index.ts';
import type { SearchFilters, SeriesCard } from './providers/types.ts';
import { assertInsideLibrary, localPagePaths } from './providers/local.ts';
import { readZipEntry, readZipIndex } from './zip.ts';
import { aiHealth, explainStream, getAvailableProviders, invalidateProvider, listModels, translateBlocks, visionTranslate } from './ai.ts';
import { engines, targets, translateWithEngine, type Engine } from './translators.ts';

const app = new Hono();

const list = (v: string | undefined): string[] =>
  (v ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

/** Toda URL externa sai daqui assinada; o cliente nunca fala direto com o provider. */
const proxied = (url: string | undefined, referer?: string): string | undefined => {
  if (!url) return undefined;
  if (url.startsWith('/')) return url;
  return signUrl(url, referer);
};

const cardOut = (c: SeriesCard): SeriesCard => ({ ...c, cover: proxied(c.cover, c.coverReferer) });

/**
 * No app desktop o front vem de tauri://localhost e a API de 127.0.0.1, entao
 * precisa de CORS. Sem `Access-Control-Allow-Origin` o canvas fica "tainted" e o
 * OCR nao consegue ler os pixels da pagina.
 */
const originAllowed = (origin: string): boolean =>
  /^tauri:\/\/localhost$/.test(origin) ||
  /^https?:\/\/tauri\.localhost$/.test(origin) ||
  /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin);

/**
 * O servidor so' escuta em loopback, mas isso nao impede um site qualquer aberto
 * no browser de falar com ele: `fetch('http://127.0.0.1:7788/...')` sai do
 * browser normalmente. Duas barreiras:
 *
 * - `Host` fora de loopback e' DNS rebinding — o atacante aponta o proprio
 *   dominio para 127.0.0.1 e a pagina dele passa a ser "mesma origem" que a
 *   API, lendo `/api/ai/providers` (que devolve a chave da IA) sem CORS.
 * - POST com `Origin` de fora e' CSRF — `Content-Type: text/plain` nao dispara
 *   preflight, e `POST /api/ai/config` trocaria o `baseUrl` do provider pelo do
 *   atacante; a proxima traducao entregaria o `Authorization: Bearer <chave>`.
 *
 * Sem `Origin` (curl, testes, requisicao de mesma origem em browser antigo)
 * passa: browser moderno sempre manda `Origin` em POST.
 */
const LOOPBACK_HOST = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i;
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

app.use('*', async (c, next) => {
  const host = c.req.header('Host') ?? '';
  if (host && !LOOPBACK_HOST.test(host)) return c.text('host invalido', 403);
  const origin = c.req.header('Origin') ?? '';
  if (!SAFE_METHODS.has(c.req.method) && origin && !originAllowed(origin)) {
    return c.text('origem nao permitida', 403);
  }
  if (c.req.method === 'OPTIONS' && originAllowed(origin)) {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': origin,
        'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Max-Age': '86400',
      },
    });
  }
  await next();
  if (origin && originAllowed(origin)) c.header('Access-Control-Allow-Origin', origin);
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('Referrer-Policy', 'no-referrer');
});

app.onError((err, c) => {
  console.error('[erro]', err.message);
  return c.json({ error: err.message }, 500);
});

app.get('/api/providers', (c) => {
  const contentType = c.req.query('contentType') as SearchFilters['contentType'];
  return c.json(
    enabledProviders(contentType).map((p) => ({
      id: p.id,
      name: p.name,
      kind: p.kind,
      contentType: p.contentType,
      supports: p.supports,
      languages: p.languages ?? [],
    })),
  );
});

app.get('/api/tags', async (c) => {
  const id = c.req.query('provider') ?? 'mangadex';
  const provider = getProvider(id);
  if (!provider.tags) return c.json([]);
  return c.json(await provider.tags());
});

app.get('/api/search', async (c) => {
  const q = c.req.query();
  const filters: SearchFilters = {
    q: q['q'],
    contentType: (q['contentType'] as SearchFilters['contentType']) || undefined,
    langs: list(q['langs']),
    origin: list(q['origin']),
    includeTags: list(q['includeTags']),
    excludeTags: list(q['excludeTags']),
    status: list(q['status']),
    demographic: list(q['demographic']),
    contentRating: list(q['contentRating']),
    type: list(q['type']),
    yearFrom: Number(q['yearFrom']) || undefined,
    yearTo: Number(q['yearTo']) || undefined,
    sort: (q['sort'] as SearchFilters['sort']) || undefined,
    order: q['order'] === 'asc' ? 'asc' : q['order'] === 'desc' ? 'desc' : undefined,
    page: Number(q['page']) || 1,
    limit: Number(q['limit']) || 24,
  };
  const res = await searchAll(list(q['providers']), filters);
  return c.json({ ...res, items: res.items.map(cardOut) });
});

app.get('/api/series', async (c) => {
  const provider = getProvider(c.req.query('provider') ?? '');
  const id = c.req.query('id');
  if (!id) return c.json({ error: 'id obrigatorio' }, 400);
  const detail = await provider.series(id);
  return c.json({ ...cardOut(detail), chapters: detail.chapters });
});

app.get('/api/pages', async (c) => {
  const provider = getProvider(c.req.query('provider') ?? '');
  const chapter = c.req.query('chapter');
  if (!chapter) return c.json({ error: 'chapter obrigatorio' }, 400);
  const pages = await provider.pages(chapter);
  return c.json({ pages: pages.map((p) => ({ ...p, url: proxied(p.url, p.referer) })) });
});

const MAX_IMAGE_HOPS = 4;

/**
 * Busca a imagem seguindo redirect um salto por vez: a allowlist vale para CADA
 * destino, nao so' para a URL assinada. Com `redirect: 'follow'` um CDN da
 * allowlist que responda 302 para um host interno (metadata da nuvem, outro
 * servico em loopback) seria seguido as cegas pelo proxy.
 */
async function fetchImage(url: string, referer?: string): Promise<Response> {
  let current = url;
  for (let hop = 0; hop < MAX_IMAGE_HOPS; hop++) {
    const parsed = new URL(current);
    if (parsed.protocol !== 'https:' || !hostAllowed(parsed.hostname)) {
      throw new HttpError(`host bloqueado: ${parsed.hostname}`, 403);
    }
    const res = await httpFetch(current, {
      referer,
      accept: 'image/avif,image/webp,image/*,*/*;q=0.8',
      timeoutMs: 30_000,
      redirect: 'manual',
    });
    const location = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && location) {
      current = new URL(location, current).href;
      continue;
    }
    return res;
  }
  throw new HttpError('redirects demais', 502);
}

app.get('/api/img', async (c) => {
  const { u = '', r = '', s = '' } = c.req.query();
  let target: { url: string; referer?: string };
  try {
    target = verifyUrl(u, r, s);
  } catch {
    return c.text('assinatura invalida', 403);
  }
  let res: Response;
  try {
    res = await fetchImage(target.url, target.referer);
  } catch (err) {
    // host bloqueado (403), upstream esgotado ou redirect sem fim (502): o status
    // ja' vem certo do HttpError — subir para o onError viraria 500 generico
    if (err instanceof HttpError) return new Response(err.message, { status: err.status });
    throw err;
  }
  if (!res.ok || !res.body) return c.text(`upstream ${res.status}`, 502);
  return new Response(res.body, {
    headers: {
      'Content-Type': res.headers.get('content-type') ?? 'image/jpeg',
      'Cache-Control': 'public, max-age=86400',
      // liberado para o canvas do OCR conseguir ler os pixels no app desktop
      'Cross-Origin-Resource-Policy': 'cross-origin',
      'Access-Control-Allow-Origin': '*',
    },
  });
});

const MIME: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
};

app.get('/api/local/page', async (c) => {
  const chapterToken = c.req.query('c') ?? '';
  const index = Number(c.req.query('i') ?? '0');
  let located: Awaited<ReturnType<typeof localPagePaths>>;
  try {
    located = await localPagePaths(chapterToken);
  } catch (err) {
    // caminho fora da LOCAL_LIBRARY e' recusa, nao erro do servidor
    return c.text(`acesso negado: ${(err as Error).message}`, 403);
  }
  const { kind, base, names } = located;
  const name = names[index];
  if (!name) return c.text('pagina inexistente', 404);
  const type = MIME[extname(name).toLowerCase()] ?? 'application/octet-stream';

  // sem `Access-Control-Allow-Origin: *`: o token e' so' o caminho em base64,
  // e um site qualquer no browser adivinharia `D:\Manga\...` e leria a
  // biblioteca. O middleware ja' libera a origem do app (o <img> do leitor
  // carrega com `crossorigin=anonymous`, entao manda `Origin`).
  const imageHeaders = {
    'Content-Type': type,
    'Cache-Control': 'public, max-age=3600',
    'Cross-Origin-Resource-Policy': 'cross-origin',
  };

  if (kind === 'dir') {
    const file = Bun.file(assertInsideLibrary(join(base, name)));
    return new Response(file, { headers: imageHeaders });
  }
  // `base` ja' passou por assertInsideLibrary; decodificar o token de novo aqui
  // seria reabrir o caminho cru vindo da query
  const entries = await readZipIndex(base);
  const entry = entries.find((e) => e.name === name);
  if (!entry) return c.text('pagina inexistente no CBZ', 404);
  const buf = await readZipEntry(base, entry);
  return new Response(new Uint8Array(buf), { headers: imageHeaders });
});

/** Modelos do Tesseract proxiados e cacheados em disco: primeira pagina paga, o resto e' local. */
app.get('/api/tessdata/:file', async (c) => {
  const file = c.req.param('file');
  if (!/^[a-z_]{3,24}\.traineddata(\.gz)?$/.test(file)) return c.text('modelo invalido', 400);
  const dir = join(config.cacheDir, 'tessdata');
  await mkdir(dir, { recursive: true });
  const path = join(dir, file);
  const cachedFile = Bun.file(path);
  if (await cachedFile.exists()) {
    return new Response(cachedFile, { headers: { 'Content-Type': 'application/octet-stream' } });
  }
  const res = await httpFetch(`https://tessdata.projectnaptha.com/4.0.0/${file}`, { timeoutMs: 120_000 });
  if (!res.ok) return c.text(`upstream ${res.status}`, 502);
  const buf = new Uint8Array(await res.arrayBuffer());
  await Bun.write(path, buf);
  return new Response(buf, { headers: { 'Content-Type': 'application/octet-stream' } });
});

app.get('/api/ai/health', async (c) => {
  const prov = c.req.query('provider');
  return c.json(await aiHealth(prov ? normalizeProvider(prov) : undefined));
});

app.get('/api/ai/providers', (c) => c.json(getAvailableProviders()));

app.get('/api/ai/models', async (c) => {
  const prov = c.req.query('provider');
  const provider = prov ? normalizeProvider(prov) : config.ai.provider;
  try {
    const models = await listModels(provider);
    return c.json({ ok: models.length > 0, provider, models });
  } catch (err) {
    return c.json({ ok: false, provider, models: [], error: (err as Error).message }, 502);
  }
});

app.post('/api/ai/config', async (c) => {
  const body = (await c.req.json()) as {
    active?: AiProvider;
    provider?: AiProvider;
    baseUrl?: string;
    apiKey?: string;
    model?: string;
    visionModel?: string;
  };
  if (body.active) {
    config.ai.provider = normalizeProvider(body.active);
  }
  const target = body.provider ? normalizeProvider(body.provider) : undefined;
  if (target) {
    const patch: Record<string, string> = {};
    if (typeof body.baseUrl === 'string') patch.baseUrl = body.baseUrl.trim().replace(/\/+$/, '');
    if (typeof body.apiKey === 'string') patch.apiKey = body.apiKey.trim();
    if (typeof body.model === 'string') patch.model = body.model.trim();
    if (typeof body.visionModel === 'string') patch.visionModel = body.visionModel.trim();

    if (target === 'openrouter') Object.assign(config.ai.openrouter, patch);
    else if (target === 'openaicompatible') Object.assign(config.ai.openaiCompatible, patch);
    else if (target === 'ollama') Object.assign(config.ai.ollama, patch);

    invalidateProvider(target);
  } else {
    invalidateProvider();
  }
  saveAiConfig();
  return c.json(getAvailableProviders());
});

app.get('/api/translate/engines', (c) => c.json(engines));

app.get('/api/translate/targets', (c) => c.json(targets));

/** Ordem do modo automatico: os gratuitos primeiro, a IA so' como ultimo recurso. */
const AUTO_ORDER = ['google', 'mymemory', 'llm'] as const;

type TranslateBody = Parameters<typeof translateBlocks>[0] & { engine?: Engine };

const runEngine = (engine: Exclude<Engine, 'auto'>, body: TranslateBody): Promise<{ id: number; pt: string }[]> =>
  engine === 'llm'
    ? translateBlocks(body)
    : translateWithEngine(engine, body.blocks, body.sourceLang, body.target);

app.post('/api/ai/translate', async (c) => {
  const body = (await c.req.json()) as TranslateBody;
  if (!Array.isArray(body?.blocks) || !body.blocks.length) return c.json({ error: 'blocks vazio' }, 400);
  const chosen: Engine = body.engine ?? 'auto';
  if (chosen !== 'auto') {
    try {
      return c.json({ translations: await runEngine(chosen, body), engine: chosen });
    } catch (err) {
      // Motor fixado que cai quase sempre e' limite do provider (429 do Google),
      // nao defeito daqui. Sem este corte a excecao subia para o onError e virava
      // 500: o cliente nao tinha como separar "o tradutor esta' me limitando" de
      // "o servidor quebrou", e o caminho `auto` ja' devolve 502 no mesmo caso.
      return c.json({ error: (err as Error).message }, 502);
    }
  }

  // sem IA sempre que der: so' desce a lista quando o motor de cima cai inteiro
  const problems: string[] = [];
  for (const engine of AUTO_ORDER) {
    try {
      return c.json({ translations: await runEngine(engine, body), engine });
    } catch (err) {
      problems.push(`${engine}: ${(err as Error).message}`);
    }
  }
  return c.json({ error: `nenhum tradutor respondeu — ${problems.join(' | ')}` }, 502);
});

app.post('/api/ai/vision', async (c) => {
  const body = (await c.req.json()) as Parameters<typeof visionTranslate>[0];
  if (!body?.imageDataUrl?.startsWith('data:image/')) return c.json({ error: 'imageDataUrl invalido' }, 400);
  return c.json({ balloons: await visionTranslate(body) });
});

app.post('/api/ai/explain', async (c) => {
  const body = (await c.req.json()) as Parameters<typeof explainStream>[0];
  const stream = await explainStream(body);
  return new Response(stream, {
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no' },
  });
});

/** Worker e core do Tesseract servidos do node_modules — nada de CDN em runtime. */
app.get('/vendor/tesseract/:file', async (c) => {
  const file = c.req.param('file');
  if (!/^[\w.-]+\.(js|wasm)$/.test(file) || file.includes('..')) return c.text('nao encontrado', 404);
  const path = file.startsWith('worker')
    ? join('node_modules', 'tesseract.js', 'dist', file)
    : join('node_modules', 'tesseract.js-core', file);
  const bun = Bun.file(path);
  if (!(await bun.exists())) return c.text('nao encontrado', 404);
  return new Response(bun, {
    headers: {
      'Content-Type': file.endsWith('.wasm') ? 'application/wasm' : 'text/javascript',
      'Cache-Control': 'public, max-age=86400',
    },
  });
});

const STATIC_MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.map': 'application/json',
  '.wasm': 'application/wasm',
  '.woff2': 'font/woff2',
};

app.get('*', async (c) => {
  const pathname = new URL(c.req.url).pathname;
  const safe = pathname.replace(/\.\.+/g, '').replace(/^\/+/, '');
  const candidate = safe === '' ? 'index.html' : safe;
  const file = Bun.file(join('public', candidate));
  if (await file.exists()) {
    return new Response(file, {
      headers: { 'Content-Type': STATIC_MIME[extname(candidate).toLowerCase()] ?? 'application/octet-stream' },
    });
  }
  return new Response(Bun.file(join('public', 'index.html')), {
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
});

/**
 * Rede de seguranca do modo desktop: se a janela do Tauri for morta a seco, o
 * evento de saida nao roda e o servidor ficaria orfao segurando a porta.
 */
const parentPid = Number(process.env['PARENT_PID'] ?? 0);
if (parentPid > 0) {
  setInterval(() => {
    try {
      process.kill(parentPid, 0);
    } catch {
      console.error('[sidecar] processo pai sumiu, encerrando');
      process.exit(0);
    }
  }, 5000).unref?.();
}

/**
 * `hostname` explicito: sem ele o Bun sobe so' em `::` (IPv6) e o app desktop,
 * que monta a URL como `http://127.0.0.1:<porta>`, nao acha ninguem — o catalogo
 * morria com "Failed to fetch" apenas no Tauri. Loopback tambem e' o alcance
 * certo: este processo faz proxy de imagem e nao deve atender a rede.
 */
export default { hostname: '127.0.0.1', port: config.port, fetch: app.fetch, idleTimeout: 60 };

console.log(`manga-lens em http://localhost:${config.port}`);
const activeProv = getProviderConfig(config.ai.provider);
console.log(`LLM: [${config.ai.provider}] ${activeProv.baseUrl} (${activeProv.model})`);
console.log(
  config.localRoots.length
    ? `biblioteca local: ${config.localRoots.join(', ')}`
    : 'biblioteca local desativada (defina LOCAL_LIBRARY)',
);
