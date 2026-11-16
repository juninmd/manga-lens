import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config } from '../src/server/config.ts';
import { loadTtsConfig, ttsConfig } from '../src/server/tts.ts';
import server from '../src/server/index.ts';
import { splitForSpeech } from '../src/client/tts.ts';

const box = await mkdtemp(join(tmpdir(), 'manga-lens-tts-'));
const savedCache = config.cacheDir;
const realFetch = globalThis.fetch;

interface Seen {
  url: string;
  init: RequestInit;
}
let seen: Seen[] = [];
const mockFetch = (respond: (url: string, init: RequestInit) => Response): void => {
  globalThis.fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input instanceof Request ? input.url : input);
    seen.push({ url, init });
    return respond(url, init);
  }) as typeof fetch;
};

const post = (path: string, body: unknown): Promise<Response> =>
  Promise.resolve(server.fetch(new Request(`http://127.0.0.1${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })));
const get = (path: string): Promise<Response> => Promise.resolve(server.fetch(new Request(`http://127.0.0.1${path}`)));

beforeAll(() => {
  config.cacheDir = join(box, 'cache');
  loadTtsConfig();
});

afterEach(() => {
  globalThis.fetch = realFetch;
  seen = [];
});

afterAll(async () => {
  config.cacheDir = savedCache;
  loadTtsConfig();
  await rm(box, { recursive: true, force: true });
});

describe('splitForSpeech', () => {
  test('junta frases curtas e respeita o teto', () => {
    expect(splitForSpeech('Ola. Tudo bem? Sim!', 400)).toEqual(['Ola. Tudo bem? Sim!']);
    const parts = splitForSpeech('Primeira frase aqui. Segunda frase aqui. Terceira frase aqui.', 25);
    expect(parts).toEqual(['Primeira frase aqui.', 'Segunda frase aqui.', 'Terceira frase aqui.']);
  });

  test('frase gigante quebra na virgula ou no espaco, sem perder texto', () => {
    const long = `${'palavra '.repeat(30)}fim, ${'outra '.repeat(30)}final.`;
    const parts = splitForSpeech(long, 100);
    expect(parts.every((p) => p.length <= 100)).toBe(true);
    expect(parts.join(' ').replace(/\s+/g, ' ')).toBe(long.replace(/\s+/g, ' ').trim());
  });

  test('texto vazio nao gera trecho', () => {
    expect(splitForSpeech('   ')).toEqual([]);
  });
});

describe('API de voz', () => {
  test('lista os motores com os locais primeiro e Kokoro com vozes PT-BR', async () => {
    const list = (await (await get('/api/tts/engines')).json()) as { id: string; local: boolean; voices: { id: string }[]; ready: boolean }[];
    expect(list[0]!.id).toBe('kokoro');
    expect(list[0]!.local).toBe(true);
    expect(list[0]!.voices.map((v) => v.id)).toContain('pf_dora');
    expect(list.map((e) => e.id)).toEqual(expect.arrayContaining(['piper', 'openai', 'elevenlabs', 'azure', 'google']));
  });

  test('a chave salva nunca volta na resposta e fica no arquivo local', async () => {
    const res = await post('/api/tts/config', { engine: 'openai', apiKey: 'sk-segredo-123' });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain('sk-segredo-123');
    const openai = (JSON.parse(text) as { id: string; hasKey: boolean; ready: boolean }[]).find((e) => e.id === 'openai')!;
    expect(openai).toMatchObject({ hasKey: true, ready: true });
    expect(await readFile(join(box, 'cache', 'tts-config.json'), 'utf-8')).toContain('sk-segredo-123');
    expect(await (await get('/api/tts/engines')).text()).not.toContain('sk-segredo-123');
  });

  test('config invalida vira 400', async () => {
    expect((await post('/api/tts/config', { engine: 'nada' })).status).toBe(400);
    expect((await post('/api/tts/config', { engine: 'kokoro', baseUrl: 'file:///etc/passwd' })).status).toBe(400);
  });

  test('Kokoro: rota OpenAI-compativel com voz PT-BR', async () => {
    ttsConfig.kokoro.baseUrl = 'http://kokoro.test/v1';
    mockFetch(() => new Response(new Uint8Array([1, 2, 3]), { headers: { 'Content-Type': 'audio/mpeg' } }));
    const res = await post('/api/tts/speak', { engine: 'kokoro', text: 'Bom dia.', speed: 1.25 });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('audio/mpeg');
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
    expect(seen[0]!.url).toBe('http://kokoro.test/v1/audio/speech');
    expect(JSON.parse(String(seen[0]!.init.body))).toMatchObject({ input: 'Bom dia.', voice: 'pf_dora', speed: 1.25, lang_code: 'p' });
  });

  test('SaaS sem chave recusa sem chamar a rede', async () => {
    ttsConfig.google.apiKey = '';
    mockFetch(() => new Response('nao devia chamar'));
    const res = await post('/api/tts/speak', { engine: 'google', text: 'Oi.' });
    expect(res.status).toBe(502);
    expect(((await res.json()) as { error: string }).error).toContain('chave');
    expect(seen).toHaveLength(0);
  });

  test('Google devolve o audio em base64; Azure recebe SSML escapado', async () => {
    ttsConfig.google.apiKey = 'g-key';
    mockFetch(() => Response.json({ audioContent: Buffer.from([9, 8]).toString('base64') }));
    const g = await post('/api/tts/speak', { engine: 'google', text: 'Oi.' });
    expect(new Uint8Array(await g.arrayBuffer())).toEqual(new Uint8Array([9, 8]));
    expect(JSON.parse(String(seen[0]!.init.body)).voice.languageCode).toBe('pt-BR');

    seen = [];
    ttsConfig.azure.apiKey = 'az-key';
    ttsConfig.azure.region = 'brazilsouth';
    mockFetch(() => new Response(new Uint8Array([7]), { headers: { 'Content-Type': 'audio/mpeg' } }));
    await post('/api/tts/speak', { engine: 'azure', text: 'A & B <c>' });
    expect(seen[0]!.url).toBe('https://brazilsouth.tts.speech.microsoft.com/cognitiveservices/v1');
    expect(String(seen[0]!.init.body)).toContain('A &amp; B &lt;c&gt;');
    expect(String(seen[0]!.init.body)).toContain('pt-BR-FranciscaNeural');
  });

  test('ElevenLabs usa o modelo multilingue e a chave no cabecalho', async () => {
    ttsConfig.elevenlabs.apiKey = 'el-key';
    mockFetch(() => new Response(new Uint8Array([5]), { headers: { 'Content-Type': 'audio/mpeg' } }));
    await post('/api/tts/speak', { engine: 'elevenlabs', text: 'Oi.' });
    expect(seen[0]!.url).toContain('/text-to-speech/');
    expect((seen[0]!.init.headers as Record<string, string>)['xi-api-key']).toBe('el-key');
    expect(JSON.parse(String(seen[0]!.init.body)).model_id).toBe('eleven_multilingual_v2');
  });

  test('motor local fora do ar responde 503 com dica', async () => {
    globalThis.fetch = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    const res = await post('/api/tts/speak', { engine: 'piper', text: 'Oi.' });
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: string }).error).toContain('fora do ar');
  });

  test('texto vazio, longo demais ou motor desconhecido sao recusados', async () => {
    expect((await post('/api/tts/speak', { engine: 'kokoro', text: '  ' })).status).toBe(400);
    expect((await post('/api/tts/speak', { engine: 'kokoro', text: 'a'.repeat(5000) })).status).toBe(413);
    expect((await post('/api/tts/speak', { engine: 'x', text: 'oi' })).status).toBe(400);
  });
});
