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

describe('chave da IA nao sai do servidor (#18)', () => {
  const post = (body: unknown) =>
    req('/api/ai/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

  test('GET /api/ai/providers nao devolve a chave, so a dica mascarada', async () => {
    const key = 'fake-key-abcdef-1234';
    const saved = await post({ provider: 'openrouter', apiKey: key });
    expect(await saved.text()).not.toContain(key);
    const body = await (await req('/api/ai/providers')).text();
    expect(body).not.toContain(key);
    const or = (JSON.parse(body) as { providers: { id: string; keyHint: string; hasKey: boolean }[] }).providers.find(
      (p) => p.id === 'openrouter',
    );
    expect(or?.hasKey).toBe(true);
    expect(or?.keyHint).toBe('••••1234');
  });

  test('POST sem apiKey preserva a chave; clearKey remove', async () => {
    await post({ provider: 'openrouter', apiKey: 'test-token-keep' });
    await post({ provider: 'openrouter', model: 'x/y', apiKey: '' });
    const { config } = await import('../src/server/config.ts');
    expect(config.ai.openrouter.apiKey).toBe('test-token-keep');
    await post({ provider: 'openrouter', clearKey: true });
    expect(config.ai.openrouter.apiKey).toBe('');
  });

  test.skipIf(process.platform === 'win32')('ai-config.json e gravado com modo 0600', async () => {
    await post({ provider: 'openrouter', model: 'x/z' });
    const { config } = await import('../src/server/config.ts');
    const { statSync } = await import('node:fs');
    const { join } = await import('node:path');
    expect(statSync(join(config.cacheDir, 'ai-config.json')).mode & 0o777).toBe(0o600);
  });
});

describe('validacao de POST /api/ai/config (#20)', () => {
  const raw = (body: string) =>
    req('/api/ai/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });

  test.each([
    ['null', 'null'],
    ['array', '[]'],
    ['ftp', JSON.stringify({ provider: 'openrouter', baseUrl: 'ftp://x' })],
    ['javascript', JSON.stringify({ provider: 'openrouter', baseUrl: 'javascript:alert(1)' })],
    ['enorme', JSON.stringify({ provider: 'openrouter', baseUrl: `https://a.com/${'x'.repeat(5000)}` })],
    ['http publico', JSON.stringify({ provider: 'openrouter', baseUrl: 'http://example.com/v1' })],
    ['credencial embutida', JSON.stringify({ provider: 'openrouter', baseUrl: `https://${'u'}:${'p'}@example.com/v1` })],
    ['provider desconhecido', JSON.stringify({ provider: 'foo', model: 'm' })],
  ])('%s vira 400 sem alterar a configuracao', async (_n, body) => {
    const { config } = await import('../src/server/config.ts');
    const before = JSON.stringify(config.ai);
    const res = await raw(body);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBeTruthy();
    expect(JSON.stringify(config.ai)).toBe(before);
  });

  test('http em rede privada continua aceito', async () => {
    const res = await raw(JSON.stringify({ provider: 'ollama', baseUrl: 'http://192.168.0.10:11434/v1' }));
    expect(res.status).toBe(200);
  });

  test('troca de host sem mandar chave limpa a chave anterior', async () => {
    const { config } = await import('../src/server/config.ts');
    await raw(JSON.stringify({ provider: 'openaicompatible', baseUrl: 'https://a.example/v1', apiKey: 'fake-host-a-000' }));
    expect(config.ai.openaiCompatible.apiKey).toBe('fake-host-a-000');
    await raw(JSON.stringify({ provider: 'openaicompatible', baseUrl: 'https://b.example/v1' }));
    expect(config.ai.openaiCompatible.apiKey).toBe('');
    expect(config.ai.openaiCompatible.baseUrl).toBe('https://b.example/v1');
  });
});

describe('erros da API (#21, #22)', () => {
  test('JSON invalido vira 400', async () => {
    const res = await req('/api/ai/translate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{nao json' });
    expect(res.status).toBe(400);
  });

  test('provider desconhecido vira 404', async () => {
    const res = await req('/api/series?provider=nao-existe&id=1');
    expect(res.status).toBe(404);
  });

  test('rota /api inexistente devolve JSON 404, nao o index.html', async () => {
    const res = await req('/api/nao-existe');
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toContain('application/json');
  });

  test('page e limit fora da faixa sao limitados', async () => {
    const { clampInt } = await import('../src/server/index.ts');
    expect(clampInt('-5', 1, 1, 500)).toBe(1);
    expect(clampInt('999999', 24, 1, 100)).toBe(100);
    expect(clampInt('abc', 24, 1, 100)).toBe(24);
    expect(clampInt(undefined, 24, 1, 100)).toBe(24);
    expect(clampInt('2.7', 1, 1, 500)).toBe(2);
  });
});

describe('modelo do Tesseract (#25)', () => {
  test('gzip integro passa; truncado, sem magic ou pequeno demais falha', async () => {
    const { tessdataLooksValid } = await import('../src/server/index.ts');
    const { gzipSync } = await import('node:zlib');
    const { randomBytes } = await import('node:crypto');
    const gz = gzipSync(randomBytes(8192));
    expect(tessdataLooksValid('por.traineddata.gz', gz)).toBe(true);
    expect(tessdataLooksValid('por.traineddata.gz', gz.subarray(0, gz.length - 100))).toBe(false);
    expect(tessdataLooksValid('por.traineddata.gz', Buffer.alloc(4096, 1))).toBe(false);
    expect(tessdataLooksValid('por.traineddata', Buffer.alloc(10))).toBe(false);
  });

  test('download truncado nao e gravado no cache', async () => {
    const { gzipSync } = await import('node:zlib');
    const { randomBytes } = await import('node:crypto');
    const gz = gzipSync(randomBytes(8192));
    stubUpstream([new Response(gz.subarray(0, 2000), { headers: { 'content-length': String(gz.length) } })]);
    const res = await req('/api/tessdata/zzz_teste.traineddata.gz');
    expect(res.status).toBe(502);
    const { config } = await import('../src/server/config.ts');
    const { join } = await import('node:path');
    expect(await Bun.file(join(config.cacheDir, 'tessdata', 'zzz_teste.traineddata.gz')).exists()).toBe(false);
  });
});
