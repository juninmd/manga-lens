import { afterEach, describe, expect, test } from 'bun:test';
import { providers, searchAll } from '../src/server/providers/index.ts';
import type { ContentType, Provider, SeriesCard } from '../src/server/providers/types.ts';

const originalCount = providers.length;
afterEach(() => {
  providers.length = originalCount;
});

const card = (p: Partial<SeriesCard> & { title: string; provider: string }): SeriesCard => ({
  id: `${p.provider}:${p.title}`,
  ...p,
});

/** Provider de mentira: devolve uma lista fixa ou explode, sem tocar a rede. */
function fake(id: string, result: SeriesCard[] | Error, contentType: ContentType = 'manga'): string {
  providers.push({
    id,
    name: id,
    kind: 'online',
    contentType,
    supports: ['q'],
    search: async () => {
      if (result instanceof Error) throw result;
      return { items: result };
    },
    series: async () => {
      throw new Error('nao usado');
    },
    pages: async () => [],
  } satisfies Provider);
  return id;
}

describe('searchAll: provider que cai', () => {
  test('vira aviso, nao derruba a busca inteira', async () => {
    fake('cai', new Error('upstream 503'));
    fake('vive', [card({ provider: 'vive', title: 'One Piece' })]);
    const res = await searchAll(['cai', 'vive'], {});
    expect(res.items).toHaveLength(1);
    expect(res.errors).toEqual([{ provider: 'cai', message: 'upstream 503' }]);
    expect(res.perProvider).toEqual({ cai: 0, vive: 1 });
  });

  test('provider desconhecido e erro do chamador, nao aviso', () => {
    expect(searchAll(['nao-existe'], {})).rejects.toThrow('provider desconhecido');
  });
});

describe('searchAll: juncao da mesma obra em sites diferentes', () => {
  test('mesmo titulo com pontuacao/caixa diferente vira um card com varias origens', async () => {
    fake('a', [card({ provider: 'a', title: 'NARUTO' })]);
    fake('b', [card({ provider: 'b', title: 'Naruto' })]);
    fake('c', [card({ provider: 'c', title: 'naruto' })]);
    const res = await searchAll(['a', 'b', 'c'], {});
    expect(res.items).toHaveLength(1);
    expect(res.items[0]!.sources?.map((s) => s.provider).sort()).toEqual(['a', 'b', 'c']);
  });

  test('acento e apostrofo curvo nao separam a mesma obra', async () => {
    fake('a', [card({ provider: 'a', title: 'Fullmetal Alchemist' })]);
    fake('b', [card({ provider: 'b', title: 'Fullmétal — Alchemist' })]);
    expect((await searchAll(['a', 'b'], {})).items).toHaveLength(1);
  });

  test('edicao diferente continua sendo obra propria', async () => {
    // juntar "Naruto" com "Naruto (Color)" ou com um doujinshi seria perder material
    fake('a', [card({ provider: 'a', title: 'Naruto' })]);
    fake('b', [
      card({ provider: 'b', title: 'Naruto (Color)' }),
      card({ provider: 'b', title: 'Naruto - Rocket (Doujinshi)' }),
    ]);
    expect((await searchAll(['a', 'b'], {})).items).toHaveLength(3);
  });

  test('a entrada com mais material vira a principal', async () => {
    fake('pobre', [card({ provider: 'pobre', title: 'Bleach' })]);
    fake('rico', [
      card({ provider: 'rico', title: 'Bleach', cover: 'http://x/c.jpg', description: 'sinopse', tags: ['acao'] }),
    ]);
    const [item] = (await searchAll(['pobre', 'rico'], {})).items;
    expect(item!.provider).toBe('rico');
    expect(item!.cover).toBe('http://x/c.jpg');
  });

  test('o mesmo provider repetindo a obra rende uma origem so', async () => {
    fake('a', [
      card({ provider: 'a', title: 'Berserk', id: 'a:1' }),
      card({ provider: 'a', title: 'BERSERK', id: 'a:2' }),
    ]);
    const [item] = (await searchAll(['a'], {})).items;
    expect(item!.sources).toHaveLength(1);
  });

  test('titulo que vira chave vazia e descartado, nao quebra a lista', async () => {
    fake('a', [card({ provider: 'a', title: '???' }), card({ provider: 'a', title: 'Vagabond' })]);
    const res = await searchAll(['a'], {});
    expect(res.items.map((i) => i.title)).toEqual(['Vagabond']);
  });
});

describe('searchAll: ordem da grade', () => {
  test('intercala providers para nenhum monopolizar o topo', async () => {
    fake('a', [
      card({ provider: 'a', title: 'A1' }),
      card({ provider: 'a', title: 'A2' }),
      card({ provider: 'a', title: 'A3' }),
    ]);
    fake('b', [card({ provider: 'b', title: 'B1' })]);
    const res = await searchAll(['a', 'b'], {});
    expect(res.items.map((i) => i.title)).toEqual(['A1', 'B1', 'A2', 'A3']);
  });
});

describe('searchAll: separacao por tipo de conteudo', () => {
  test('provider de outro tipo nao entra na aba pedida', async () => {
    fake('mang', [card({ provider: 'mang', title: 'Naruto' })], 'manga');
    fake('quad', [card({ provider: 'quad', title: 'Plastic Man' })], 'hq');
    const res = await searchAll(['mang', 'quad'], { contentType: 'hq' });
    expect(res.items.map((i) => i.title)).toEqual(['Plastic Man']);
    expect(res.perProvider).toEqual({ mang: 0, quad: 1 });
  });

  test('o card manda sobre o padrao do provider (biblioteca mista)', async () => {
    fake(
      'misto',
      [
        card({ provider: 'misto', title: 'Um Manga' }),
        card({ provider: 'misto', title: 'Um Livro', contentType: 'livro' }),
      ],
      'manga',
    );
    const res = await searchAll(['misto'], { contentType: 'livro' });
    expect(res.items.map((i) => i.title)).toEqual(['Um Livro']);
  });

  test('sem filtro de tipo tudo passa', async () => {
    fake('mang', [card({ provider: 'mang', title: 'Naruto' })], 'manga');
    fake('quad', [card({ provider: 'quad', title: 'Plastic Man' })], 'hq');
    expect((await searchAll(['mang', 'quad'], {})).items).toHaveLength(2);
  });
});

describe('searchAll: provider lento', () => {
  test('estoura o prazo e vira aviso, sem segurar os outros', async () => {
    const { config } = await import('../src/server/providers/../config.ts');
    const original = config.searchTimeoutMs;
    config.searchTimeoutMs = 60;
    try {
      providers.push({
        id: 'lento',
        name: 'lento',
        kind: 'online',
        contentType: 'manga',
        supports: ['q'],
        search: () => new Promise(() => undefined),
        series: async () => {
          throw new Error('nao usado');
        },
        pages: async () => [],
      } satisfies Provider);
      fake('rapido', [card({ provider: 'rapido', title: 'Bleach' })]);
      const started = Date.now();
      const res = await searchAll(['lento', 'rapido'], {});
      expect(Date.now() - started).toBeLessThan(2000);
      expect(res.items).toHaveLength(1);
      expect(res.errors).toEqual([{ provider: 'lento', message: 'tempo esgotado (0s)' }]);
    } finally {
      config.searchTimeoutMs = original;
    }
  });
});
