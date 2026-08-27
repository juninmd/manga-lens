import { afterEach, describe, expect, test } from 'bun:test';
import { HttpError, fetchJson, fetchText, httpFetch } from '../src/server/http.ts';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

interface Call {
  url: string;
  headers: Record<string, string>;
}

/** Troca o fetch global por uma fila de respostas, guardando o que foi pedido. */
function stubFetch(steps: Array<Response | Error | 'hang'>): Call[] {
  const calls: Call[] = [];
  let i = 0;
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    calls.push({ url: String(input), headers });
    const step = steps[Math.min(i++, steps.length - 1)]!;
    if (step === 'hang') {
      return new Promise((_, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('The operation was aborted.')));
      });
    }
    return step instanceof Error ? Promise.reject(step) : Promise.resolve(step);
  }) as typeof fetch;
  return calls;
}

const ok = (body = 'ok', init?: ResponseInit): Response => new Response(body, init);
const status = (code: number): Response => new Response('', { status: code });

describe('httpFetch', () => {
  test('resposta boa na primeira tentativa nao repete a chamada', async () => {
    const calls = stubFetch([ok()]);
    expect((await httpFetch('https://x.test/a')).status).toBe(200);
    expect(calls).toHaveLength(1);
  });

  test('429 e' + ' repetido com recuo ate dar certo', async () => {
    const calls = stubFetch([status(429), status(429), ok('enfim')]);
    expect(await (await httpFetch('https://x.test/a')).text()).toBe('enfim');
    expect(calls).toHaveLength(3);
  });

  test('5xx persistente vira HttpError com o status do upstream', async () => {
    stubFetch([status(503)]);
    const err = (await httpFetch('https://x.test/a').catch((e) => e)) as HttpError;
    expect(err).toBeInstanceOf(HttpError);
    expect(err.status).toBe(503);
    expect(err.message).toContain('upstream 503');
  });

  test('4xx que nao e 429 volta como resposta, sem repetir', async () => {
    // 404 e 403 sao respostas legitimas do provider: repetir so' queima cota
    const calls = stubFetch([status(404)]);
    expect((await httpFetch('https://x.test/a')).status).toBe(404);
    expect(calls).toHaveLength(1);
  });

  test('falha de rede repetida vira HttpError 502', async () => {
    const calls = stubFetch([new Error('ECONNRESET')]);
    const err = (await httpFetch('https://x.test/a').catch((e) => e)) as HttpError;
    expect(err.status).toBe(502);
    expect(err.message).toContain('falha de rede');
    expect(calls).toHaveLength(3); // 1 tentativa + 2 retries
  });

  test('retries: 0 desliga a repeticao', async () => {
    const calls = stubFetch([status(500)]);
    await httpFetch('https://x.test/a', { retries: 0 }).catch(() => undefined);
    expect(calls).toHaveLength(1);
  });

  test('timeout aborta a requisicao pendurada', async () => {
    stubFetch(['hang']);
    const err = (await httpFetch('https://x.test/a', { timeoutMs: 50, retries: 0 }).catch((e) => e)) as HttpError;
    expect(err.status).toBe(502);
  });

  test('manda User-Agent de browser e Accept-Language', async () => {
    const calls = stubFetch([ok()]);
    await httpFetch('https://x.test/a');
    expect(calls[0]!.headers['user-agent']).toContain('Mozilla/5.0');
    expect(calls[0]!.headers['accept-language']).toContain('pt-BR');
  });

  test('referer tambem define Origin (provider recusa uma coisa sem a outra)', async () => {
    const calls = stubFetch([ok()]);
    await httpFetch('https://x.test/a', { referer: 'https://site.test/manga/x' });
    expect(calls[0]!.headers['referer']).toBe('https://site.test/manga/x');
    expect(calls[0]!.headers['origin']).toBe('https://site.test');
  });

  test('headers extras sobrescrevem os padroes', async () => {
    const calls = stubFetch([ok()]);
    await httpFetch('https://x.test/a', { accept: 'image/*', headers: { Accept: 'text/plain' } });
    expect(calls[0]!.headers['accept']).toBe('text/plain');
  });
});

describe('fetchJson / fetchText', () => {
  test('fetchJson devolve o corpo tipado', async () => {
    stubFetch([ok(JSON.stringify({ items: [1, 2] }))]);
    expect(await fetchJson<{ items: number[] }>('https://x.test/a')).toEqual({ items: [1, 2] });
  });

  test('fetchJson transforma 4xx em HttpError com status', async () => {
    stubFetch([status(403)]);
    const err = (await fetchJson('https://x.test/a').catch((e) => e)) as HttpError;
    expect(err.status).toBe(403);
    expect(err.message).toContain('upstream 403');
  });

  test('fetchText transforma 4xx em HttpError com status', async () => {
    stubFetch([status(451)]);
    const err = (await fetchText('https://x.test/a').catch((e) => e)) as HttpError;
    expect(err.status).toBe(451);
  });
});
