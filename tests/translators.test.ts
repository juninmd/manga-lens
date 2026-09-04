import { afterEach, describe, expect, test } from 'bun:test';
import { DEFAULT_TARGET, engines, targetOf, targets, translateWithEngine } from '../src/server/translators.ts';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Resposta no formato cru do endpoint publico do Google Tradutor. */
const googleBody = (text: string): string => JSON.stringify([[[text, 'orig', null, null, 10]]]);

interface Stub {
  urls: string[];
}

function stubTranslator(reply: (url: string) => Response | Error): Stub {
  const urls: string[] = [];
  globalThis.fetch = ((input: string | URL | Request) => {
    const url = String(input);
    urls.push(url);
    const out = reply(url);
    return out instanceof Error ? Promise.reject(out) : Promise.resolve(out);
  }) as typeof fetch;
  return { urls };
}

const textOf = (url: string): string => decodeURIComponent(new URL(url).searchParams.get('q') ?? '');

describe('idioma de destino', () => {
  test('so aceita id da lista publicada', () => {
    expect(targetOf('es')).toBe('es');
    expect(targetOf('PT-br')).toBe('pt-BR');
  });

  test('valor fora da lista cai no padrao (nao entra cru na URL do tradutor)', () => {
    // o destino e' concatenado na URL do provider: aceitar texto livre aqui
    // seria deixar o cliente montar requisicao de terceiro
    expect(targetOf('../../etc/passwd')).toBe(DEFAULT_TARGET);
    expect(targetOf('&tl=evil')).toBe(DEFAULT_TARGET);
    expect(targetOf(undefined)).toBe(DEFAULT_TARGET);
    expect(targetOf('')).toBe(DEFAULT_TARGET);
  });

  test('pt-BR e o primeiro da lista e todos os ids sao unicos', () => {
    expect(DEFAULT_TARGET).toBe('pt-BR');
    expect(new Set(targets.map((t) => t.id)).size).toBe(targets.length);
  });
});

describe('catalogo de motores', () => {
  test('existe ao menos um motor que nao depende de IA', () => {
    expect(engines.some((e) => !e.needsAi)).toBe(true);
  });

  test('o modo automatico nao e marcado como dependente de IA', () => {
    expect(engines.find((e) => e.id === 'auto')?.needsAi).toBe(false);
  });
});

describe('translateWithEngine', () => {
  test('traduz bloco util e devolve na ordem de entrada', async () => {
    const stub = stubTranslator((url) => new Response(googleBody(`[${textOf(url)}]`)));
    const blocks = Array.from({ length: 12 }, (_, i) => ({ id: i, text: `TEXTO ${i}` }));
    const out = await translateWithEngine('google', blocks, 'en', 'pt-BR');
    expect(out.map((o) => o.id)).toEqual(blocks.map((b) => b.id));
    expect(out.map((o) => o.pt)).toEqual(blocks.map((b) => `[${b.text}]`));
    expect(stub.urls).toHaveLength(12);
  });

  test('ruido de OCR nao gasta requisicao e volta vazio', async () => {
    const stub = stubTranslator(() => new Response(googleBody('nao deveria')));
    const out = await translateWithEngine(
      'google',
      [
        { id: 0, text: '|| ~~ 4 @' },
        { id: 1, text: '.' },
        { id: 2, text: 'A' },
        { id: 3, text: '  ' },
        { id: 4, text: 'OK' },
      ],
      'en',
    );
    expect(out.filter((o) => o.pt)).toHaveLength(1);
    expect(stub.urls).toHaveLength(1);
    expect(textOf(stub.urls[0]!)).toBe('OK');
  });

  test('pagina so com ruido nao vira erro de motor', async () => {
    stubTranslator(() => new Error('nao deveria chamar'));
    expect(await translateWithEngine('google', [{ id: 0, text: '~~' }], 'en')).toEqual([{ id: 0, pt: '' }]);
  });

  test('quebra de linha do balao vira espaco antes de traduzir', async () => {
    const stub = stubTranslator((url) => new Response(googleBody(textOf(url))));
    await translateWithEngine('google', [{ id: 0, text: 'PRIMEIRA\n  SEGUNDA' }], 'en');
    expect(textOf(stub.urls[0]!)).toBe('PRIMEIRA SEGUNDA');
  });

  test('motor inteiro fora do ar lanca — o modo automatico depende disso', async () => {
    stubTranslator(() => new Response('', { status: 429 }));
    expect(
      translateWithEngine('google', [{ id: 0, text: 'ALGUMA COISA' }], 'en'),
    ).rejects.toThrow('google: limite de requisicoes (429)');
  });

  test('429 vira mensagem curta e acionavel, sem a URL (que levava o texto do balao)', async () => {
    stubTranslator(() => new Response('', { status: 429 }));
    const err = await translateWithEngine('google', [{ id: 0, text: 'TEXTO SECRETO' }], 'en').catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe('google: limite de requisicoes (429) — aguarde ~1 min ou use o motor Automatico');
    expect((err as Error).message).not.toContain('TEXTO');
    expect((err as Error).message).not.toContain('http');
  });

  test('mymemory: 403 de cota vira aviso de cota esgotada', async () => {
    stubTranslator(() => new Response(JSON.stringify({ responseStatus: 403, responseData: { translatedText: '' } })));
    await expect(translateWithEngine('mymemory', [{ id: 0, text: 'AA' }], 'en')).rejects.toThrow(
      'mymemory: cota esgotada',
    );
  });

  test('bloco solto perdido nao derruba a pagina inteira', async () => {
    let n = 0;
    stubTranslator(() => (n++ === 0 ? new Response('', { status: 400 }) : new Response(googleBody('traduzido'))));
    const out = await translateWithEngine(
      'google',
      [
        { id: 0, text: 'FALHA AQUI' },
        { id: 1, text: 'ESTE VAI' },
      ],
      'en',
    );
    expect(out).toHaveLength(2);
    expect(out.filter((o) => o.pt)).toHaveLength(1);
  });

  test('idioma de origem conhecido vai mapeado; desconhecido vira auto', async () => {
    const stub = stubTranslator(() => new Response(googleBody('x')));
    await translateWithEngine('google', [{ id: 0, text: 'AA' }], 'pt-br');
    await translateWithEngine('google', [{ id: 0, text: 'AA' }], 'klingon');
    expect(new URL(stub.urls[0]!).searchParams.get('sl')).toBe('pt');
    expect(new URL(stub.urls[1]!).searchParams.get('sl')).toBe('auto');
  });

  test('destino invalido nunca chega na URL do tradutor', async () => {
    const stub = stubTranslator(() => new Response(googleBody('x')));
    await translateWithEngine('google', [{ id: 0, text: 'AA' }], 'en', 'inventado');
    expect(new URL(stub.urls[0]!).searchParams.get('tl')).toBe('pt-BR');
  });

  test('mymemory: responseStatus de erro conta como falha do motor', async () => {
    stubTranslator(() => new Response(JSON.stringify({ responseStatus: 429, responseData: { translatedText: '' } })));
    expect(translateWithEngine('mymemory', [{ id: 0, text: 'AA' }], 'en')).rejects.toThrow('mymemory: cota esgotada');
  });

  test('mymemory: origem auto vira en no par de idiomas', async () => {
    const stub = stubTranslator(
      () => new Response(JSON.stringify({ responseStatus: 200, responseData: { translatedText: 'ok' } })),
    );
    await translateWithEngine('mymemory', [{ id: 0, text: 'AA' }], 'klingon', 'es');
    expect(new URL(stub.urls[0]!).searchParams.get('langpair')).toBe('en|es');
  });
});
