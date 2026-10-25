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

describe('corpo travado, limite de concorrencia e cancelamento', () => {
  test('servidor que trava o corpo rejeita com HttpError 504 dentro de bodyTimeoutMs', async () => {
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        const stream = new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('1234567890'));
            // envia 10 bytes e para/trava
          },
        });
        return new Response(stream, {
          status: 200,
          headers: { 'content-length': '1000' },
        });
      },
    });

    try {
      const url = `http://127.0.0.1:${server.port}/hang`;
      const t0 = Date.now();
      const err = (await fetchText(url, { bodyTimeoutMs: 150, retries: 0 }).catch((e) => e)) as HttpError;
      const elapsed = Date.now() - t0;

      expect(err).toBeInstanceOf(HttpError);
      expect(err.status).toBe(504);
      expect(err.message).toContain('timeout lendo corpo');
      expect(elapsed).toBeGreaterThanOrEqual(100);
      expect(elapsed).toBeLessThan(1000);
    } finally {
      server.stop(true);
    }
  });

  test('20 downloads lentos simultaneos nunca tem mais de 16 em andamento', async () => {
    let currentInFlight = 0;
    let maxInFlight = 0;

    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        currentInFlight++;
        if (currentInFlight > maxInFlight) maxInFlight = currentInFlight;

        const stream = new ReadableStream({
          async start(controller) {
            controller.enqueue(new TextEncoder().encode('part1'));
            await Bun.sleep(100);
            controller.enqueue(new TextEncoder().encode('part2'));
            controller.close();
          },
        });

        return new Response(stream, { status: 200 });
      },
    });

    try {
      const url = `http://127.0.0.1:${server.port}/slow`;
      const downloads = Array.from({ length: 20 }, async () => {
        const res = await httpFetch(url, { retries: 0, bodyTimeoutMs: 2000 });
        const text = await res.text();
        currentInFlight--;
        return text;
      });

      const results = await Promise.all(downloads);
      expect(results).toHaveLength(20);
      expect(maxInFlight).toBeLessThanOrEqual(16);
    } finally {
      server.stop(true);
    }
  });

  test('cancelar o stream libera a vaga do semaforo', async () => {
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        const u = new URL(req.url);
        const hang = u.searchParams.has('hang');
        const stream = new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('chunk1'));
            if (!hang) controller.close();
          },
        });
        return new Response(stream, { status: 200 });
      },
    });

    try {
      const url = `http://127.0.0.1:${server.port}/cancel`;
      // Primeira requisicao responde 'chunk1' e NAO fecha o corpo no servidor (hang)
      const res = await httpFetch(`${url}?hang=1`, { retries: 0 });
      const reader = res.body!.getReader();
      const firstRead = await reader.read();
      expect(new TextDecoder().decode(firstRead.value)).toBe('chunk1');

      // Cancela o stream
      await reader.cancel('usuario mudou de capitulo');

      // Se a vaga nao tivesse sido liberada por cancel(), a 16a das 16 novas requisicoes ficaria presa
      const requests = Array.from({ length: 16 }, () =>
        httpFetch(url, { retries: 0, bodyTimeoutMs: 500 }).then((r) => r.text()),
      );
      const results = await Promise.all(requests);
      expect(results).toHaveLength(16);
      expect(results[0]).toBe('chunk1');
    } finally {
      server.stop(true);
    }
  });
});
