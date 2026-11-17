import { beforeEach, describe, expect, test } from 'bun:test';

const memory = new Map<string, string>();
(globalThis as { localStorage?: Storage }).localStorage = {
  getItem: (k: string) => memory.get(k) ?? null,
  setItem: (k: string, v: string) => void memory.set(k, v),
  removeItem: (k: string) => void memory.delete(k),
  clear: () => memory.clear(),
  key: () => null,
  get length() {
    return memory.size;
  },
} as Storage;
(globalThis as { window?: Window }).window ??= globalThis as unknown as Window;
(globalThis as { document?: Pick<Document, 'addEventListener'> }).document ??= { addEventListener: () => {} };

const { store, toggleFavorite, markChaptersSeen } = await import('../src/client/state.ts');
const { applyCount, checkFavorites, updatesMessage, CHECK_EVERY_MS } = await import('../src/client/updates.ts');

const detail = (n: number) => ({ chapters: Array.from({ length: n }, (_, i) => ({ id: `c${i}` })) }) as never;

beforeEach(() => {
  store.favorites = {};
});

describe('capitulos novos nos favoritos', () => {
  test('primeira consulta so fixa a linha de base', () => {
    const fav = { provider: 'p', id: 's', title: 'T', at: 0 };
    expect(applyCount(fav, 10)).toBe(false);
    expect(fav).toMatchObject({ knownCount: 10, newChapters: 0 });
  });

  test('capitulo a mais vira aviso uma vez so', () => {
    const fav = { provider: 'p', id: 's', title: 'T', at: 0, knownCount: 10, newChapters: 0 };
    expect(applyCount(fav, 12)).toBe(true);
    expect(fav.newChapters).toBe(2);
    expect(applyCount(fav, 12)).toBe(false);
  });

  test('checkFavorites respeita o intervalo e conta os novos', async () => {
    toggleFavorite({ provider: 'p', id: 'a', title: 'Obra A' });
    toggleFavorite({ provider: 'p', id: 'b', title: 'Obra B' });
    let calls = 0;
    let size = 5;
    const load = async () => {
      calls++;
      return detail(size);
    };
    expect(await checkFavorites(load, 1_000)).toEqual([]);
    expect(calls).toBe(2);
    size = 7;
    expect(await checkFavorites(load, 2_000)).toEqual([]);
    expect(calls).toBe(2);
    const found = await checkFavorites(load, 1_000 + CHECK_EVERY_MS);
    expect(found.map((f) => f.count)).toEqual([2, 2]);
  });

  test('fonte fora do ar nao derruba a rodada', async () => {
    toggleFavorite({ provider: 'p', id: 'a', title: 'Obra A' });
    const found = await checkFavorites(async () => {
      throw new Error('503');
    });
    expect(found).toEqual([]);
  });

  test('abrir a obra zera o selo', () => {
    toggleFavorite({ provider: 'p', id: 'a', title: 'Obra A' });
    const fav = Object.values(store.favorites)[0]!;
    fav.knownCount = 3;
    fav.newChapters = 2;
    markChaptersSeen('p', 'a', 5);
    expect(fav).toMatchObject({ knownCount: 5, newChapters: 0 });
  });

  test('mensagem do aviso', () => {
    expect(updatesMessage([{ provider: 'p', id: 'a', title: 'Naruto', count: 2 }])).toBe('capitulos novos em Naruto (+2)');
    expect(updatesMessage([{ provider: 'p', id: 'a', title: 'X', count: 1 }, { provider: 'p', id: 'b', title: 'Y', count: 1 }])).toBe(
      '2 obras favoritas com capitulos novos',
    );
  });
});
