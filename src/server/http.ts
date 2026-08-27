import { config } from './config.ts';

export class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

interface FetchOpts {
  referer?: string;
  accept?: string;
  timeoutMs?: number;
  retries?: number;
  headers?: Record<string, string>;
}

/** fetch com UA de browser, timeout e retry com backoff em 429/5xx. */
export async function httpFetch(url: string, opts: FetchOpts = {}): Promise<Response> {
  const { referer, accept, timeoutMs = 20_000, retries = 2 } = opts;
  let lastErr: unknown;

  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        signal: ctrl.signal,
        redirect: 'follow',
        headers: {
          'User-Agent': config.userAgent,
          'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8,ja;q=0.7',
          ...(accept ? { Accept: accept } : {}),
          ...(referer ? { Referer: referer, Origin: new URL(referer).origin } : {}),
          ...opts.headers,
        },
      });
      if (res.status === 429 || res.status >= 500) {
        if (attempt < retries) {
          await Bun.sleep(400 * 2 ** attempt);
          continue;
        }
        throw new HttpError(`upstream ${res.status} em ${url}`, res.status);
      }
      return res;
    } catch (err) {
      // desistencia deliberada (429/5xx apos os retries) ja' carrega o status do
      // upstream; sem isto o proprio catch a converteria num generico 502
      if (err instanceof HttpError) throw err;
      lastErr = err;
      if (attempt >= retries) break;
      await Bun.sleep(400 * 2 ** attempt);
    } finally {
      clearTimeout(timer);
    }
  }
  throw new HttpError(`falha de rede: ${String(lastErr)}`, 502);
}

export async function fetchJson<T>(url: string, opts: FetchOpts = {}): Promise<T> {
  const res = await httpFetch(url, { accept: 'application/json', ...opts });
  if (!res.ok) throw new HttpError(`upstream ${res.status} em ${url}`, res.status);
  return (await res.json()) as T;
}

export async function fetchText(url: string, opts: FetchOpts = {}): Promise<string> {
  const res = await httpFetch(url, { accept: 'text/html,*/*', ...opts });
  if (!res.ok) throw new HttpError(`upstream ${res.status} em ${url}`, res.status);
  return await res.text();
}
