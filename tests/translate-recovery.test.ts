import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config } from '../src/server/config.ts';
import { invalidateProvider, isTransientAiError, translateBlocks } from '../src/server/ai.ts';

const dir = await mkdtemp(join(tmpdir(), 'manga-lens-recovery-'));
config.cacheDir = dir;
afterAll(() => rm(dir, { recursive: true, force: true }));

const realFetch = globalThis.fetch;
const oc = config.ai.openaiCompatible;
const saved = { ...oc };
let calls: { id: number; text: string }[][] = [];

/** LLM falso: `answer` decide, por chamada, o que volta para o lote (string crua ou lista de ids traduzidos). */
function fakeLlm(answer: (batch: { id: number; text: string }[], n: number) => string | number[]): void {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('/models')) return new Response(JSON.stringify({ data: [{ id: oc.model }] }));
    const body = JSON.parse(String(init?.body)) as { model: string; messages: { content: string }[] };
    const text = body.messages.at(-1)!.content;
    const batch = JSON.parse(text.slice(text.lastIndexOf('Blocos (ordem de leitura): ') + 27)) as { id: number; text: string }[];
    calls.push(batch);
    const a = answer(batch, calls.length);
    const content =
      typeof a === 'string' ? a : JSON.stringify({ translations: batch.filter((b) => a.includes(b.id)).map((b) => ({ id: b.id, pt: `PT:${b.text}` })) });
    return new Response(JSON.stringify({ id: 'x', model: body.model, choices: [{ message: { role: 'assistant', content } }] }));
  }) as typeof fetch;
}

let seq = 0;
/** texto unico por teste: o cache de traducao nao pode servir um teste com a resposta de outro */
const page = (n: number) => {
  seq++;
  return Array.from({ length: n }, (_, id) => ({ id, text: `fala ${seq}-${id}` }));
};

beforeEach(() => {
  calls = [];
  Object.assign(oc, { baseUrl: 'http://llm.test/v1', model: 'text-model', visionModel: '' });
  invalidateProvider('openaicompatible');
});
afterEach(() => {
  globalThis.fetch = realFetch;
  Object.assign(oc, saved);
  invalidateProvider('openaicompatible');
});

describe('recuperacao de lote', () => {
  test('lote com JSON torto e repartido e os baloes saem na repescagem', async () => {
    fakeLlm((batch, n) => (n === 1 ? 'desculpe, nao consigo' : batch.map((b) => b.id)));
    const out = await translateBlocks({ provider: 'openaicompatible', blocks: page(4) });
    expect(out.map((t) => t.id).sort()).toEqual([0, 1, 2, 3]);
    expect(calls[0]).toHaveLength(4);
    expect(calls[1]).toHaveLength(2);
  });

  test('balao pulado pelo modelo volta sozinho num pedido menor', async () => {
    fakeLlm((batch, n) => (n === 1 ? batch.filter((b) => b.id !== 2).map((b) => b.id) : batch.map((b) => b.id)));
    const blocks = page(3);
    const out = await translateBlocks({ provider: 'openaicompatible', blocks });
    expect(out.find((t) => t.id === 2)?.pt).toBe(`PT:${blocks[2]!.text}`);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.map((b) => b.id)).toEqual([2]);
  });

  test('balao que nunca sai para depois da profundidade fixa, sem loop', async () => {
    fakeLlm((batch) => batch.filter((b) => b.id !== 0).map((b) => b.id));
    const out = await translateBlocks({ provider: 'openaicompatible', blocks: page(8) });
    expect(out.some((t) => t.id === 0)).toBe(false);
    expect(calls.length).toBeLessThanOrEqual(4);
  });

  test('erro de rede nao e repartido: so um timeout, nao sete', async () => {
    globalThis.fetch = (async (input: string | URL | Request) => {
      if (String(input).includes('/models')) return new Response(JSON.stringify({ data: [{ id: 'text-model' }] }));
      calls.push([]);
      throw new TypeError('fetch failed');
    }) as typeof fetch;
    await expect(translateBlocks({ provider: 'openaicompatible', blocks: page(4) })).rejects.toThrow(/IA indisponivel/);
    expect(calls).toHaveLength(1);
  });

  test('classifica erro transitorio', () => {
    expect(isTransientAiError('fetch failed')).toBe(true);
    expect(isTransientAiError('Request failed with status 429')).toBe(true);
    expect(isTransientAiError('resposta do LLM sem JSON: oi')).toBe(false);
  });
});

describe('cache de traducao', () => {
  test('a mesma pagina reaberta nao chama o modelo de novo', async () => {
    fakeLlm((batch) => batch.map((b) => b.id));
    const blocks = page(2);
    const first = await translateBlocks({ provider: 'openaicompatible', blocks });
    const again = await translateBlocks({ provider: 'openaicompatible', blocks });
    expect(again).toEqual(first);
    expect(calls).toHaveLength(1);
  });

  test('trocar o modelo invalida o cache', async () => {
    fakeLlm((batch) => batch.map((b) => b.id));
    const blocks = page(2);
    await translateBlocks({ provider: 'openaicompatible', blocks });
    Object.assign(oc, { model: 'outro-modelo' });
    invalidateProvider('openaicompatible');
    await translateBlocks({ provider: 'openaicompatible', blocks });
    expect(calls).toHaveLength(2);
  });

  test('trocar o estilo invalida o cache', async () => {
    fakeLlm((batch) => batch.map((b) => b.id));
    const blocks = page(1);
    await translateBlocks({ provider: 'openaicompatible', blocks });
    await translateBlocks({ provider: 'openaicompatible', blocks, style: { honorifics: 'adapt', tone: 'natural', sfx: 'translate' } });
    expect(calls).toHaveLength(2);
  });

  test('pagina incompleta nao vai ao cache: o R volta ao modelo', async () => {
    fakeLlm((batch) => batch.filter((b) => b.id !== 1).map((b) => b.id));
    const blocks = page(2);
    await translateBlocks({ provider: 'openaicompatible', blocks });
    const before = calls.length;
    await translateBlocks({ provider: 'openaicompatible', blocks });
    expect(calls.length).toBeGreaterThan(before);
  });
});

describe('cache de traducao corrompido', () => {
  test('entrada com formato errado e ignorada e a pagina volta ao modelo', async () => {
    const { readdir, writeFile } = await import('node:fs/promises');
    fakeLlm((batch) => batch.map((b) => b.id));
    const blocks = page(1);
    await translateBlocks({ provider: 'openaicompatible', blocks });
    const { memSize } = await import('../src/server/cache.ts');
    expect(memSize()).toBeGreaterThan(0);
    // estraga todos os arquivos de cache em disco e reinicia a camada de memoria via outro processo simulado
    for (const name of await readdir(dir)) if (name.endsWith('.json')) await writeFile(join(dir, name), JSON.stringify({ at: Date.now(), value: { nao: 'lista' } }));
    const { clearMemCache } = await import('../src/server/cache.ts');
    clearMemCache();
    const out = await translateBlocks({ provider: 'openaicompatible', blocks });
    expect(out).toEqual([{ id: 0, pt: `PT:${blocks[0]!.text}` }]);
    expect(calls).toHaveLength(2);
  });
});
