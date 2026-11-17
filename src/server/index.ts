import { Hono } from 'hono';
import { checkForUpdate } from './version.ts';
import { cancelUpdateDownload, getUpdateState, isDesktopApp, startUpdateDownload, UpdateError } from './updater.ts';
import { join, extname } from 'node:path';
import { mkdir, rename, unlink } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { config, getProviderConfig, hostAllowed, normalizeProvider, saveAiConfig } from './config.ts';
import { normalizeProviderImage } from './provider-image.ts';
import { signUrl, verifyUrl } from './sign.ts';
import { HttpError, httpFetch } from './http.ts';
import { enabledProviders, getProvider, providers, searchAll } from './providers/index.ts';
import type { OpdsProvider } from './providers/opds.ts';
import type { SearchFilters, SeriesCard } from './providers/types.ts';
import { assertInsideLibrary, localBookBlocks, localPagePaths } from './providers/local.ts';
import { readZipEntry, readZipIndex } from './zip.ts';
import { readSync, setSyncDir, SyncError, syncDir, writeSync } from './sync.ts';
import { AiConfigError, type AiConfigPatch, parseAiConfigBody } from './ai-config-body.ts';
import { buildStoredZip, imageExt, safeFileName, type ZipInput } from './zip-write.ts';
import { readRarEntry } from './rar.ts';
import { pdfPageImage } from './pdf.ts';
import {
  aiHealth,
  explainStream,
  getAvailableProviders,
  invalidateProvider,
  listModels,
  MAX_PAGE_IMAGE,
  PAGE_IMAGE_RE,
  translateBlocks,
  visionBlocks,
  visionTranslate,
} from './ai.ts';
import { MAX_PROSE_CHARS, sanitizeBlocks } from './page-text.ts';
import { parseStyle } from './translate-prompt.ts';
import { modelBytes } from './models.ts';
import { forget, memorySummary, removeTerm, setTerm } from './series-memory.ts';
import { engines, targets, translateWithEngine, type Engine } from './translators.ts';
import { applyTtsPatch, isTtsEngine, MAX_TTS_CHARS, speak, ttsEngines } from './tts.ts';

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
  // corpo que nao e' JSON e' erro de quem chamou: 400, nao "falha interna"
  if (err instanceof SyntaxError) return c.json({ error: 'JSON invalido no corpo da requisicao' }, 400);
  console.error('[erro]', err.message);
  // HttpError do provider (404 de serie removida, 429...) precisa manter o status:
  // virar 500 generico fazia o cliente dizer "fonte fora do ar" para titulo que sumiu
  const status = err instanceof HttpError && err.status >= 400 && err.status <= 599 ? err.status : 500;
  // mensagem interna crua chegava no toast sem contexto
  return c.json({ error: status === 500 ? `falha interna: ${err.message}` : err.message }, status as 500);
});

app.get('/api/version', async (c) => {
  const info = await checkForUpdate({ force: c.req.query('refresh') === '1', offline: c.req.query('local') === '1' });
  // instalar de dentro do app so' no desktop e so' quando a release publicou o hash do instalador
  return c.json({ ...info, canInstall: isDesktopApp() && Boolean(info.installerSha256) });
});

app.get('/api/update/state', (c) => c.json({ ...getUpdateState(), canInstall: isDesktopApp() }));

/**
 * Exige JSON: um formulario ou `fetch` simples de outra pagina nao manda esse
 * tipo sem preflight, e o preflight so' passa para a origem do proprio app.
 */
const jsonOnly = (c: { req: { header(n: string): string | undefined } }): boolean => (c.req.header('content-type') ?? '').includes('application/json');

app.post('/api/update/download', async (c) => {
  if (!jsonOnly(c)) return c.json({ error: 'content-type invalido' }, 415);
  if (!isDesktopApp()) return c.json({ error: 'a instalacao automatica so existe no app desktop' }, 400);
  try {
    return c.json(await startUpdateDownload(await checkForUpdate()), 202);
  } catch (err) {
    if (err instanceof UpdateError) return c.json({ error: err.message }, err.status);
    throw err;
  }
});

app.post('/api/update/cancel', async (c) => {
  if (!jsonOnly(c)) return c.json({ error: 'content-type invalido' }, 415);
  return c.json(await cancelUpdateDownload());
});

app.get('/api/providers', (c) => {
  const contentType = c.req.query('contentType') as SearchFilters['contentType'];
  return c.json(
    enabledProviders(contentType).map((p) => ({
      id: p.id,
      name: p.name,
      kind: p.kind,
      contentType: p.contentType,
      ...(p.mixed ? { mixed: true } : {}),
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

/** Inteiro dentro de [min, max]; ausente, invalido ou fracionario cai no padrao/limite. */
export function clampInt(raw: string | undefined, fallback: number, min: number, max: number): number {
  const n = Math.trunc(Number(raw));
  if (!raw || !Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

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
    page: clampInt(q['page'], 1, 1, 500),
    limit: clampInt(q['limit'], 24, 1, 100),
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
    let res = await httpFetch(current, {
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
    res = await normalizeProviderImage(res, parsed.hostname);
    const contentType = res.headers.get('content-type') ?? '';
    if (!contentType.toLowerCase().startsWith('image/')) {
      throw new HttpError(`conteudo suspeito ou nao suportado (${contentType})`, 415);
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

/**
 * Baixa um capitulo online inteiro como CBZ. Com `LOCAL_LIBRARY` configurada o
 * arquivo vai para `<biblioteca>/<obra>/<capitulo>.cbz` e passa a abrir
 * offline pela aba local; sem biblioteca, volta como download para o navegador.
 */
app.post('/api/download', async (c) => {
  const body = (await c.req.json().catch(() => null)) as { provider?: unknown; chapter?: unknown; series?: unknown; label?: unknown } | null;
  if (!body || typeof body.provider !== 'string' || typeof body.chapter !== 'string' || !body.chapter) {
    return c.json({ error: 'provider e chapter obrigatorios' }, 400);
  }
  if (body.provider === 'local' || opdsProvider(body.provider)) return c.json({ error: 'este capitulo ja esta no seu disco' }, 400);
  const provider = getProvider(body.provider);
  const pages = await provider.pages(body.chapter);
  if (!pages.length) return c.json({ error: 'capitulo sem paginas' }, 422);
  if (pages.length > 2000) return c.json({ error: 'capitulo com paginas demais' }, 422);

  const files: ZipInput[] = new Array(pages.length);
  let next = 0;
  const width = String(pages.length).length < 3 ? 3 : String(pages.length).length;
  const worker = async (): Promise<void> => {
    while (next < pages.length) {
      const i = next++;
      const page = pages[i]!;
      const res = await fetchImage(page.url, page.referer);
      if (!res.ok) throw new HttpError(`pagina ${i + 1}: upstream ${res.status}`, 502);
      const data = new Uint8Array(await res.arrayBuffer());
      files[i] = { name: `${String(i + 1).padStart(width, '0')}${imageExt(res.headers.get('content-type') ?? '')}`, data };
    }
  };
  // 3 por vez: rapido sem parecer ataque ao CDN da fonte
  await Promise.all(Array.from({ length: Math.min(3, pages.length) }, worker));
  const zip = buildStoredZip(files);

  const series = safeFileName(typeof body.series === 'string' ? body.series : '', 'obra');
  const label = safeFileName(typeof body.label === 'string' ? body.label : '', 'capitulo');
  const root = config.localRoots[0];
  if (root) {
    const dir = join(root, series);
    await mkdir(dir, { recursive: true });
    const path = join(dir, `${label}.cbz`);
    const tmp = `${path}.${process.pid}.tmp`;
    await Bun.write(tmp, zip);
    await rename(tmp, path);
    return c.json({ saved: path, pages: files.length, bytes: zip.length });
  }
  return new Response(zip, {
    headers: {
      'Content-Type': 'application/vnd.comicbook+zip',
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(`${series} - ${label}.cbz`)}`,
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

/**
 * Paragrafos de um capitulo de texto, de qualquer provider de livro (EPUB/TXT/FB2
 * locais, PDF de texto, acervo online). O leitor de livro pede daqui e manda ao tradutor.
 */
app.get('/api/book', async (c) => {
  const provider = getProvider(c.req.query('provider') ?? '');
  if (!provider.book) return c.json({ error: 'esta fonte nao tem livros de texto' }, 400);
  try {
    return c.json({ blocks: await provider.book(c.req.query('c') ?? '') });
  } catch (err) {
    const message = (err as Error).message;
    // fora da biblioteca e' recusa; entrada inexistente e' capitulo quebrado, nao erro do servidor
    return c.text(message, /fora da biblioteca/.test(message) ? 403 : 422);
  }
});

/** Paragrafos de um capitulo de livro (EPUB). Mantida para links e clientes antigos: `/api/book` cobre todas as fontes. */
app.get('/api/local/book', async (c) => {
  try {
    return c.json({ blocks: await localBookBlocks(c.req.query('c') ?? '') });
  } catch (err) {
    const message = (err as Error).message;
    // fora da biblioteca e' recusa; entrada inexistente no EPUB e' capitulo quebrado
    return c.text(message, /fora da biblioteca/.test(message) ? 403 : 422);
  }
});

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
  if (kind === 'pdf') {
    try {
      const png = await pdfPageImage(base, index);
      // PDF de texto nativo nao tem bitmap para extrair; rasterizar exigiria
      // canvas nativo, que custaria binario por plataforma no sidecar
      if (!png) return c.text('esta pagina do PDF e texto, nao imagem — o leitor ainda nao renderiza PDF de texto', 415);
      return new Response(png, { headers: imageHeaders });
    } catch (err) {
      return c.text(`pagina indisponivel no PDF: ${(err as Error).message}`, 422);
    }
  }
  if (kind === 'rar') {
    try {
      return new Response(await readRarEntry(base, name), { headers: imageHeaders });
    } catch (err) {
      // CBR com senha ou corrompido e' problema do arquivo, nao do servidor
      return c.text(`pagina indisponivel no CBR: ${(err as Error).message}`, 422);
    }
  }
  try {
    const entries = await readZipIndex(base);
    const entry = entries.find((e) => e.name === name);
    if (!entry) return c.text('pagina inexistente no CBZ', 404);
    const buf = await readZipEntry(base, entry);
    return new Response(new Uint8Array(buf), { headers: imageHeaders });
  } catch (err) {
    // zip bomb, ZIP64, senha ou arquivo truncado: problema do arquivo, nao do servidor
    return c.text(`pagina indisponivel no CBZ: ${(err as Error).message}`, 422);
  }
});

/** Provider OPDS pelo id: rota de pagina/capa nao aceita outro tipo de provider. */
function opdsProvider(id: string): OpdsProvider | null {
  const p = providers.find((x) => x.id === id) as OpdsProvider | undefined;
  return p && typeof p.archive === 'function' ? p : null;
}

/**
 * Pagina de uma edicao baixada de um catalogo OPDS. Sai do arquivo no cache, como
 * a biblioteca local — o proxy de imagem nao serve aqui: o servidor do catalogo
 * costuma estar em http na rede local e pede credencial em toda requisicao.
 */
app.get('/api/opds/page', async (c) => {
  const provider = opdsProvider(c.req.query('p') ?? '');
  if (!provider) return c.text('catalogo desconhecido', 404);
  const index = Number(c.req.query('i') ?? '0');
  let located: Awaited<ReturnType<OpdsProvider['archive']>>;
  try {
    located = await provider.archive(c.req.query('c') ?? '');
  } catch (err) {
    return c.text(`edicao indisponivel: ${(err as Error).message}`, 422);
  }
  const name = located.names[index];
  if (!Number.isInteger(index) || !name) return c.text('pagina inexistente', 404);
  const headers = { 'Content-Type': MIME[extname(name).toLowerCase()] ?? 'application/octet-stream', 'Cache-Control': 'public, max-age=3600', 'Cross-Origin-Resource-Policy': 'cross-origin' };
  try {
    if (located.kind === 'pdf') {
      const png = await pdfPageImage(located.path, index);
      return png ? new Response(png, { headers }) : c.text('esta pagina do PDF e texto, nao imagem', 415);
    }
    if (located.kind === 'cbr') return new Response(await readRarEntry(located.path, name), { headers });
    const entry = (await readZipIndex(located.path)).find((e) => e.name === name);
    if (!entry) return c.text('pagina inexistente', 404);
    return new Response(new Uint8Array(await readZipEntry(located.path, entry)), { headers });
  } catch (err) {
    return c.text(`pagina indisponivel: ${(err as Error).message}`, 422);
  }
});

/** Capa de uma obra do catalogo OPDS, buscada com a credencial dele (o <img> do app nao a tem). */
app.get('/api/opds/cover', async (c) => {
  const provider = opdsProvider(c.req.query('p') ?? '');
  if (!provider) return c.text('catalogo desconhecido', 404);
  try {
    const res = await provider.cover(Buffer.from(c.req.query('u') ?? '', 'base64url').toString('utf8'));
    return new Response(res.body, {
      headers: { 'Content-Type': res.headers.get('content-type') ?? 'image/jpeg', 'Cache-Control': 'public, max-age=86400', 'Cross-Origin-Resource-Policy': 'cross-origin' },
    });
  } catch (err) {
    return c.text((err as Error).message, 502);
  }
});

/** Modelos do Tesseract proxiados e cacheados em disco: primeira pagina paga, o resto e' local. */
/**
 * N workers do Tesseract pedem o mesmo modelo ao mesmo tempo no primeiro OCR:
 * sem isto o servidor baixava (e gravava) o arquivo N vezes.
 */
/** Modelo plausivel: tamanho minimo e, se `.gz`, cabecalho gzip integro. */
export function tessdataLooksValid(file: string, buf: Uint8Array): boolean {
  if (buf.length < 1024) return false;
  if (!file.endsWith('.gz')) return true;
  if (buf[0] !== 0x1f || buf[1] !== 0x8b) return false;
  try {
    // ISIZE do rodape confere com o descompactado: pega arquivo truncado
    const out = gunzipSync(buf);
    const isize = new DataView(buf.buffer, buf.byteOffset + buf.length - 4, 4).getUint32(0, true);
    return (out.length >>> 0) === isize;
  } catch {
    return false;
  }
}

const tessdataInflight = new Map<string, Promise<Uint8Array<ArrayBuffer>>>();

app.get('/api/tessdata/:file', async (c) => {
  const file = c.req.param('file');
  if (!/^[a-z_]{3,24}\.traineddata(\.gz)?$/.test(file)) return c.text('modelo invalido', 400);
  const dir = join(config.cacheDir, 'tessdata');
  await mkdir(dir, { recursive: true });
  const path = join(dir, file);
  const cachedFile = Bun.file(path);
  if (await cachedFile.exists()) {
    const buf = new Uint8Array(await cachedFile.arrayBuffer()) as Uint8Array<ArrayBuffer>;
    if (tessdataLooksValid(file, buf)) return new Response(buf, { headers: { 'Content-Type': 'application/octet-stream' } });
    // download antigo pela metade ficava no cache para sempre: apaga e baixa de novo
    await unlink(path).catch(() => undefined);
  }
  let pending = tessdataInflight.get(file);
  if (!pending) {
    pending = (async () => {
      const res = await httpFetch(`https://tessdata.projectnaptha.com/4.0.0/${file}`, { timeoutMs: 120_000 });
      if (!res.ok) throw new Error(`upstream ${res.status}`);
      const buf = new Uint8Array(await res.arrayBuffer()) as Uint8Array<ArrayBuffer>;
      const declared = Number(res.headers.get('content-length') ?? 0);
      if (declared && declared !== buf.length) throw new Error(`modelo truncado (${buf.length} de ${declared} bytes)`);
      if (!tessdataLooksValid(file, buf)) throw new Error('modelo baixado invalido');
      // temporario + rename: queda no meio nao deixa arquivo pela metade com o nome final
      const tmp = `${path}.${process.pid}.tmp`;
      await Bun.write(tmp, buf);
      await rename(tmp, path);
      return buf;
    })();
    tessdataInflight.set(file, pending);
    void pending.finally(() => tessdataInflight.delete(file)).catch(() => undefined);
  }
  try {
    const buf = await pending;
    return new Response(buf, { headers: { 'Content-Type': 'application/octet-stream' } });
  } catch (err) {
    return c.text((err as Error).message, 502);
  }
});

/** Modelos de visao local (detector de texto), baixados uma vez e conferidos por hash. */
app.get('/api/models/:name', async (c) => {
  const name = c.req.param('name').replace(/\.onnx$/, '');
  try {
    const bytes = await modelBytes(name);
    if (!bytes) return c.text('modelo desconhecido', 404);
    return new Response(bytes, { headers: { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'private, max-age=86400' } });
  } catch (err) {
    return c.text(`nao consegui baixar o modelo: ${(err as Error).message}`, 502);
  }
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
  let body: AiConfigPatch;
  try {
    body = parseAiConfigBody(await c.req.json().catch(() => null));
  } catch (err) {
    if (err instanceof AiConfigError) return c.json({ error: err.message }, 400);
    throw err;
  }
  if (body.active) config.ai.provider = body.active;
  const target = body.provider;
  if (target) {
    const current =
      target === 'openrouter' ? config.ai.openrouter : target === 'openaicompatible' ? config.ai.openaiCompatible : config.ai.ollama;
    const patch: Record<string, string> = {};
    if (body.baseUrl !== undefined) {
      const hostOf = (u: string) => {
        try {
          return new URL(u).host;
        } catch {
          return '';
        }
      };
      // chave salva para um host nao segue para outro sem o usuario mandar de novo
      if (hostOf(body.baseUrl) !== hostOf(current.baseUrl) && !body.apiKey && !body.keepKey) {
        patch.apiKey = target === 'ollama' ? 'ollama' : '';
      }
      patch.baseUrl = body.baseUrl;
    }
    if (body.clearKey) patch.apiKey = target === 'ollama' ? 'ollama' : '';
    else if (body.apiKey) patch.apiKey = body.apiKey;
    if (body.model !== undefined) patch.model = body.model;
    if (body.visionModel !== undefined) patch.visionModel = body.visionModel;
    Object.assign(current, patch);
    invalidateProvider(target);
  } else {
    invalidateProvider();
  }
  saveAiConfig();
  return c.json(getAvailableProviders());
});

app.get('/api/translate/engines', (c) => c.json(engines));

app.get('/api/translate/targets', (c) => c.json(targets));

/** Motores de leitura em voz alta (locais primeiro). A chave de API nunca sai daqui. */
app.get('/api/tts/engines', (c) => c.json(ttsEngines()));

app.post('/api/tts/config', async (c) => {
  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || !isTtsEngine(body.engine)) return c.json({ error: 'motor de voz desconhecido' }, 400);
  try {
    applyTtsPatch(body.engine, body);
  } catch (err) {
    return c.json({ error: (err as Error).message }, 400);
  }
  return c.json(ttsEngines());
});

/** Sintetiza um trecho e devolve o audio. O cliente fatia o capitulo em frases e pede uma de cada vez. */
app.post('/api/tts/speak', async (c) => {
  const body = (await c.req.json().catch(() => null)) as { engine?: unknown; text?: unknown; voice?: unknown; speed?: unknown } | null;
  if (!body || !isTtsEngine(body.engine)) return c.json({ error: 'motor de voz desconhecido' }, 400);
  const text = typeof body.text === 'string' ? body.text.replace(/[\p{Cc}]+/gu, ' ').trim() : '';
  if (!text) return c.json({ error: 'texto vazio' }, 400);
  if (text.length > MAX_TTS_CHARS) return c.json({ error: `trecho longo demais (max ${MAX_TTS_CHARS} letras)` }, 413);
  try {
    const { audio, type } = await speak({
      engine: body.engine,
      text,
      voice: typeof body.voice === 'string' ? body.voice : undefined,
      speed: typeof body.speed === 'number' ? body.speed : undefined,
    });
    return new Response(audio, { headers: { 'Content-Type': type, 'Cache-Control': 'no-store' } });
  } catch (err) {
    const message = (err as Error).message;
    const offline = /fetch failed|ECONNREFUSED|Unable to connect|timed out|timeout/i.test(message);
    return c.json({ error: offline ? 'motor de voz fora do ar — o servidor local esta rodando?' : message }, offline ? 503 : 502);
  }
});

/** Ordem do modo automatico: os gratuitos primeiro, a IA so' como ultimo recurso. */
const AUTO_ORDER = ['google', 'mymemory', 'llm'] as const;

type TranslateBody = Parameters<typeof translateBlocks>[0] & { engine?: Engine };

/**
 * Obra/capitulo vao para o prompt e para a memoria: quebra de linha forjaria uma "nota" de outra pagina.
 * Normaliza em vez de recusar porque titulo raspado traz `\n` do HTML (stripTags so' apara as pontas).
 */
const oneLine = (s: string): string => s.replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, ' ').trim();

const runEngine = (engine: Exclude<Engine, 'auto'>, body: TranslateBody): Promise<{ id: number; pt: string; orig?: string }[]> => {
  if (engine === 'llm') return translateBlocks(body);
  if (engine === 'vision') return visionBlocks(body);
  return translateWithEngine(engine, body.blocks, body.sourceLang, body.target);
};

app.post('/api/ai/translate', async (c) => {
  const body = (await c.req.json()) as TranslateBody;
  // `mode`, `style` e `context` vem da rede e entram no prompt: so' passam ja' validados
  const prose = body?.mode === 'prose';
  const blocks = sanitizeBlocks(body?.blocks, prose ? MAX_PROSE_CHARS : undefined);
  if (!blocks) return c.json({ error: 'blocks vazio ou invalido' }, 400);
  body.blocks = blocks;
  body.mode = prose ? 'prose' : undefined;
  body.style = parseStyle(body.style);
  body.context = Array.isArray(body.context)
    ? (body.context as unknown[]).filter((t): t is string => typeof t === 'string').slice(-3).map((t) => oneLine(t).slice(-400)).filter(Boolean)
    : undefined;
  if (body.pageImage !== undefined && (typeof body.pageImage !== 'string' || body.pageImage.length > MAX_PAGE_IMAGE || !PAGE_IMAGE_RE.test(body.pageImage))) {
    return c.json({ error: 'imagem da pagina invalida' }, 400);
  }
  // viram chave da memoria da obra: mesmo teto das rotas /api/ai/memory
  for (const field of ['series', 'target', 'chapter'] as const) {
    if (typeof body[field] === 'string') body[field] = oneLine(body[field]);
  }
  const shortText = (v: unknown, max: number): boolean => v === undefined || (typeof v === 'string' && v.length <= max);
  if (!shortText(body.series, 300) || !shortText(body.target, 20) || !shortText(body.chapter, 40)) {
    return c.json({ error: 'series, capitulo ou idioma invalido' }, 400);
  }
  if (body.page !== undefined && !(Number.isInteger(body.page) && body.page >= 0)) return c.json({ error: 'pagina invalida' }, 400);
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
      // translators.ts ja' prefixa com o motor ("google: limite..."): nao duplicar
      const msg = (err as Error).message;
      problems.push(msg.startsWith(`${engine}:`) ? msg : `${engine}: ${msg}`);
    }
  }
  return c.json(
    { error: `nenhum tradutor respondeu (limite ou rede). Tente de novo em 1 min. Detalhes: ${problems.join(' | ')}` },
    502,
  );
});

/** Memoria da obra (glossario + notas): consultavel e apagavel, porque erro de nome gravado se propaga. */
const memoryKey = (series: unknown, target: unknown): { series: string; target: string } | null =>
  typeof series === 'string' && oneLine(series) && oneLine(series).length <= 300
    ? { series: oneLine(series), target: typeof target === 'string' && target ? oneLine(target) : 'pt-BR' }
    : null;

app.get('/api/ai/memory', async (c) => {
  const key = memoryKey(c.req.query('series'), c.req.query('target'));
  if (!key) return c.json({ error: 'series obrigatorio' }, 400);
  return c.json(await memorySummary(key.series, key.target));
});

/** Corrige ou cria um termo do glossario e o fixa: o modelo deixa de poder muda-lo. */
app.post('/api/ai/memory/term', async (c) => {
  const body = (await c.req.json().catch(() => null)) as { series?: unknown; target?: unknown; orig?: unknown; pt?: unknown; gender?: unknown; was?: unknown } | null;
  const key = memoryKey(body?.series, body?.target);
  if (!key) return c.json({ error: 'series obrigatorio' }, 400);
  try {
    return c.json({ term: await setTerm(key.series, key.target, { orig: body?.orig, pt: body?.pt, gender: body?.gender, was: body?.was }) });
  } catch (err) {
    return c.json({ error: (err as Error).message }, 400);
  }
});

app.post('/api/ai/memory/term/delete', async (c) => {
  const body = (await c.req.json().catch(() => null)) as { series?: unknown; target?: unknown; orig?: unknown } | null;
  const key = memoryKey(body?.series, body?.target);
  if (!key) return c.json({ error: 'series obrigatorio' }, 400);
  try {
    return c.json({ removed: await removeTerm(key.series, key.target, body?.orig) });
  } catch (err) {
    return c.json({ error: (err as Error).message }, 400);
  }
});

app.post('/api/ai/memory/clear', async (c) => {
  const body = (await c.req.json().catch(() => null)) as { series?: unknown; target?: unknown } | null;
  const key = memoryKey(body?.series, body?.target);
  if (!key) return c.json({ error: 'series obrigatorio' }, 400);
  await forget(key.series, key.target);
  return c.json({ ok: true });
});

app.post('/api/ai/vision', async (c) => {
  const body = (await c.req.json()) as Parameters<typeof visionTranslate>[0];
  if (!body?.imageDataUrl?.startsWith('data:image/')) return c.json({ error: 'imagem da pagina invalida — recarregue a pagina e tente de novo' }, 400);
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

/** Pasta de sincronizacao (Dropbox, OneDrive, Syncthing...): progresso entre maquinas sem servidor. */
app.get('/api/sync/config', (c) => c.json({ dir: syncDir(), enabled: Boolean(syncDir()) }));

app.post('/api/sync/config', async (c) => {
  const body = (await c.req.json().catch(() => null)) as { dir?: unknown } | null;
  if (!body || typeof body.dir !== 'string') return c.json({ error: 'dir obrigatorio' }, 400);
  try {
    setSyncDir(body.dir);
  } catch (err) {
    if (err instanceof SyncError) return c.json({ error: err.message }, 400);
    throw err;
  }
  return c.json({ dir: syncDir(), enabled: Boolean(syncDir()) });
});

app.get('/api/sync', (c) => {
  try {
    return c.json({ data: readSync() });
  } catch (err) {
    if (err instanceof SyncError) return c.json({ error: err.message }, 409);
    throw err;
  }
});

app.post('/api/sync', async (c) => {
  const body = (await c.req.json().catch(() => null)) as { data?: unknown } | null;
  if (!body || typeof body.data !== 'object' || body.data === null) return c.json({ error: 'data obrigatorio' }, 400);
  try {
    writeSync(body.data);
  } catch (err) {
    if (err instanceof SyncError) return c.json({ error: err.message }, 409);
    throw err;
  }
  return c.json({ ok: true });
});

// rota de API inexistente devolvia o index.html com 200 e o cliente quebrava no JSON
app.all('/api/*', (c) => c.json({ error: 'rota inexistente' }, 404));

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
