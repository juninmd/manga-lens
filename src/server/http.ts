import { userAgentForUrl } from './config.ts';

export class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

interface FetchOpts {
  method?: 'GET' | 'POST';
  body?: string;
  signal?: AbortSignal;
  referer?: string;
  accept?: string;
  timeoutMs?: number;
  retries?: number;
  headers?: Record<string, string>;
  /** `manual` devolve o 3xx cru para quem chama decidir se segue (proxy de imagem). */
  redirect?: RequestRedirect;
}

const MAX_UPSTREAM_REQUESTS = 16;
let activeRequests = 0;
const pendingRequests: (() => void)[] = [];

function requestSlot(signal: AbortSignal): Promise<() => void> {
  return new Promise((resolve, reject) => {
    let acquired = false;
    const abort = (): void => {
      if (acquired) return;
      const index = pendingRequests.indexOf(start);
      if (index >= 0) pendingRequests.splice(index, 1);
      reject(new Error('requisicao cancelada'));
    };
    const start = (): void => {
      acquired = true;
      signal.removeEventListener('abort', abort);
      activeRequests++;
      resolve(() => {
        activeRequests--;
        pendingRequests.shift()?.();
      });
    };
    if (signal.aborted) { abort(); return; }
    signal.addEventListener('abort', abort, { once: true });
    if (activeRequests < MAX_UPSTREAM_REQUESTS) start();
    else pendingRequests.push(start);
  });
}

const originFrom = (ref: string | undefined): string | undefined => {
  if (!ref) return undefined;
  try {
    return new URL(ref).origin;
  } catch {
    return undefined;
  }
};

/**
 * A URL completa fica so' no log: na mensagem (que chega ao usuario via /api/*)
 * ela carregava a query inteira — inclusive o texto do balao sendo traduzido.
 */
function upstreamError(status: number, url: string): HttpError {
  let host = url;
  // a query dos tradutores carrega o texto do balao: nem o log deve guarda-la
  let safeUrl = url;
  try {
    const u = new URL(url);
    host = u.host;
    safeUrl = u.origin + u.pathname;
  } catch {
    /* url relativa ou invalida: fica como esta' */
  }
  console.error(`[http] upstream ${status} em ${safeUrl}`);
  return new HttpError(`upstream ${status} (${host})`, status);
}

/** fetch com UA de browser, timeout e retry com backoff em 429/5xx. */
export async function httpFetch(url: string, opts: FetchOpts = {}): Promise<Response> {
  const { referer, accept, timeoutMs = 20_000, retries = 2, redirect = 'follow' } = opts;
  let lastErr: unknown;

  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const signal = opts.signal ? AbortSignal.any([ctrl.signal, opts.signal]) : ctrl.signal;
    let release: (() => void) | undefined;
    try {
      release = await requestSlot(signal);
      const origin = originFrom(referer);
      const res = await fetch(url, {
        method: opts.method,
        body: opts.body,
        signal,
        redirect,
        headers: {
          'User-Agent': userAgentForUrl(url),
          'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8,ja;q=0.7',
          ...(accept ? { Accept: accept } : {}),
          ...(referer ? { Referer: referer, ...(origin ? { Origin: origin } : {}) } : {}),
          ...opts.headers,
        },
      });
      if (res.status === 429 || res.status >= 500) {
        if (attempt < retries) {
          await Bun.sleep(400 * 2 ** attempt);
          continue;
        }
        throw upstreamError(res.status, url);
      }
      return res;
    } catch (err) {
      // desistencia deliberada (429/5xx apos os retries) ja' carrega o status do
      // upstream; sem isto o proprio catch a converteria num generico 502
      if (err instanceof HttpError) throw err;
      if (opts.signal?.aborted) throw new HttpError('requisicao cancelada', 504);
      lastErr = err;
      if (attempt >= retries) break;
      await Bun.sleep(400 * 2 ** attempt);
    } finally {
      release?.();
      clearTimeout(timer);
    }
  }
  throw new HttpError(`falha de rede: ${String(lastErr)}`, 502);
}

export async function fetchJson<T>(url: string, opts: FetchOpts = {}): Promise<T> {
  const res = await httpFetch(url, { accept: 'application/json', ...opts });
  if (!res.ok) throw upstreamError(res.status, url);
  return (await res.json()) as T;
}

export async function fetchText(url: string, opts: FetchOpts = {}): Promise<string> {
  const res = await httpFetch(url, { accept: 'text/html,*/*', ...opts });
  if (!res.ok) throw upstreamError(res.status, url);
  return await res.text();
}
