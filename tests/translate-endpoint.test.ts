import { afterEach, describe, expect, test } from 'bun:test';
import server from '../src/server/index.ts';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Responde a chamada de cada tradutor externo; a API sob teste nao e' tocada. */
function stubUpstream(reply: (url: string) => Response): void {
  globalThis.fetch = ((input: string | URL | Request) => Promise.resolve(reply(String(input)))) as typeof fetch;
}

const post = async (body: unknown): Promise<Response> =>
  await server.fetch(
    new Request('http://127.0.0.1/api/ai/translate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );

const BLOCKS = [{ id: 0, text: 'HELLO THERE FRIEND' }];
const googleOk = (): Response => new Response(JSON.stringify([[['OLA AMIGO', 'orig']]]));

describe('POST /api/ai/translate', () => {
  test('motor fixado que responde traduz e diz qual foi', async () => {
    stubUpstream(googleOk);
    const res = await post({ engine: 'google', sourceLang: 'en', blocks: BLOCKS });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ translations: [{ id: 0, pt: 'OLA AMIGO' }], engine: 'google' });
  });

  test('limite do provider vira 502, nao 500', async () => {
    // o Google devolve 429 em rajada; sem tratamento a excecao subia para o
    // onError e virava 500, e o cliente nao conseguia separar "o tradutor esta'
    // me limitando" de "o servidor quebrou"
    stubUpstream(() => new Response('', { status: 429 }));
    const res = await post({ engine: 'google', sourceLang: 'en', blocks: BLOCKS });
    expect(res.status).toBe(502);
    expect((await res.json()) as { error: string }).toHaveProperty('error');
  });

  test('modo automatico sem nenhum motor de pe devolve 502 explicando', async () => {
    stubUpstream(() => new Response('', { status: 503 }));
    const res = await post({ sourceLang: 'en', blocks: BLOCKS });
    expect(res.status).toBe(502);
    expect(((await res.json()) as { error: string }).error).toContain('nenhum tradutor respondeu');
  });

  test('modo automatico cai para o proximo motor quando o primeiro morre', async () => {
    stubUpstream((url) =>
      url.includes('googleapis')
        ? new Response('', { status: 429 })
        : new Response(JSON.stringify({ responseStatus: 200, responseData: { translatedText: 'ola' } })),
    );
    const res = await post({ sourceLang: 'en', blocks: BLOCKS });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { engine: string }).engine).toBe('mymemory');
  });

  test('motor de visao sem imagem da pagina falha explicando, nao com 500', async () => {
    // o modelo le a pagina: sem a imagem nao ha' o que traduzir, e o cliente
    // precisa da mensagem para saber que o problema nao e' o servidor
    const res = await post({ engine: 'vision', sourceLang: 'ja', blocks: [{ id: 0, text: '' }] });
    expect(res.status).toBe(502);
    expect(((await res.json()) as { error: string }).error).toMatch(/visao|imagem/i);
  });

  test('corpo sem blocos e recusado com 400', async () => {
    for (const body of [{ blocks: [] }, {}, { blocks: 'nao e lista' }]) {
      expect((await post(body)).status).toBe(400);
    }
  });
});
