import { afterEach, describe, expect, test } from 'bun:test';
import server from '../src/server/index.ts';
import { signUrl } from '../src/server/sign.ts';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Substitui o fetch de upstream por uma fila; devolve as URLs que o servidor pediu. */
function stubUpstream(steps: Response[]): string[] {
  const calls: string[] = [];
  let i = 0;
  globalThis.fetch = ((input: string | URL | Request) => {
    calls.push(String(input));
    return Promise.resolve(steps[Math.min(i++, steps.length - 1)]!);
  }) as typeof fetch;
  return calls;
}

const req = async (path: string, init?: RequestInit): Promise<Response> =>
  server.fetch(new Request(`http://127.0.0.1${path}`, init));

const EVIL = 'https://evil.example';

describe('DNS rebinding: Host fora de loopback', () => {
  test('GET com Host de terceiro e recusado antes de qualquer rota', async () => {
    const res = await req('/api/ai/providers', { headers: { Host: 'atacante.example:7788' } });
    expect(res.status).toBe(403);
    // e a resposta nao carrega a chave da IA
    expect(await res.text()).not.toContain('apiKey');
  });

  test.each(['127.0.0.1:7788', 'localhost', 'LOCALHOST:1234', '[::1]:7788'])('Host %s passa', async (host) => {
    const res = await req('/api/translate/engines', { headers: { Host: host } });
    expect(res.status).toBe(200);
  });
});

describe('CSRF: POST com Origin de fora', () => {
  test('POST de site qualquer nao troca a configuracao da IA', async () => {
    // `text/plain` nao dispara preflight: e' exatamente o que um site malicioso
    // usaria para apontar o baseUrl do provider para si e receber a chave
    const res = await req('/api/ai/config', {
      method: 'POST',
      headers: { Origin: EVIL, 'Content-Type': 'text/plain' },
      body: JSON.stringify({ provider: 'openrouter', baseUrl: `${EVIL}/v1` }),
    });
    expect(res.status).toBe(403);

    const providers = (await (await req('/api/ai/providers')).json()) as {
      providers: { id: string; baseUrl: string }[];
    };
    expect(providers.providers.find((p) => p.id === 'openrouter')?.baseUrl).not.toContain(EVIL);
  });

  test.each(['tauri://localhost', 'http://localhost:7788', 'http://127.0.0.1:5173'])(
    'POST com Origin do app (%s) segue para a rota',
    async (origin) => {
      const res = await req('/api/ai/translate', {
        method: 'POST',
        headers: { Origin: origin, 'Content-Type': 'application/json' },
        body: JSON.stringify({ blocks: [] }),
      });
      // 400 = a rota rodou e validou o corpo; o que importa e' nao ser 403
      expect(res.status).toBe(400);
    },
  );

  test('GET com Origin de fora continua servido (CORS ja impede a leitura)', async () => {
    const res = await req('/api/translate/engines', { headers: { Origin: EVIL } });
    expect(res.status).toBe(200);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });
});

describe('proxy de imagem: redirect passa pela allowlist', () => {
  const signed = signUrl('https://uploads.mangadex.org/covers/a.jpg');

  test('302 para host interno nao e seguido', async () => {
    const calls = stubUpstream([
      new Response('', { status: 302, headers: { Location: 'http://169.254.169.254/latest/meta-data' } }),
      new Response('nunca', { status: 200 }),
    ]);
    const res = await req(signed);
    expect(res.status).toBe(403);
    expect(await res.text()).toContain('169.254.169.254');
    expect(calls).toHaveLength(1);
  });

  test('302 dentro da allowlist e seguido e entrega a imagem', async () => {
    const calls = stubUpstream([
      new Response('', { status: 302, headers: { Location: '/data/final.jpg' } }),
      new Response('imagem', { status: 200, headers: { 'Content-Type': 'image/jpeg' } }),
    ]);
    const res = await req(signed);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('imagem');
    expect(calls).toEqual(['https://uploads.mangadex.org/covers/a.jpg', 'https://uploads.mangadex.org/data/final.jpg']);
  });

  test('cadeia de redirects sem fim vira 502, nao loop', async () => {
    const calls = stubUpstream([
      new Response('', { status: 302, headers: { Location: 'https://uploads.mangadex.org/loop.jpg' } }),
    ]);
    const res = await req(signed);
    expect(res.status).toBe(502);
    expect(calls.length).toBeLessThanOrEqual(4);
  });
});

describe('biblioteca local: sem CORS aberto para o mundo', () => {
  test('pagina local nao responde Access-Control-Allow-Origin: * para origem estranha', async () => {
    const res = await req('/api/local/page?c=abc&i=0', { headers: { Origin: EVIL } });
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });
});
