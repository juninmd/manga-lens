import { afterAll, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config } from '../src/server/config.ts';
import { cached } from '../src/server/cache.ts';

// tem de ser trocado antes da primeira chamada: o mkdir do diretorio e memoizado
const dir = await mkdtemp(join(tmpdir(), 'manga-lens-cache-'));
config.cacheDir = dir;
afterAll(() => rm(dir, { recursive: true, force: true }));

const fileFor = (key: string): string => join(dir, `${createHash('sha1').update(key).digest('hex')}.json`);

describe('cache de duas camadas', () => {
  test('segunda chamada dentro do TTL nao volta ao provider', async () => {
    let hits = 0;
    const load = async (): Promise<number> => ++hits;
    expect(await cached('k:memoria', 60_000, load)).toBe(1);
    expect(await cached('k:memoria', 60_000, load)).toBe(1);
    expect(hits).toBe(1);
  });

  test('TTL vencido recarrega', async () => {
    let hits = 0;
    const load = async (): Promise<number> => ++hits;
    await cached('k:ttl', 60_000, load);
    expect(await cached('k:ttl', -1, load)).toBe(2);
  });

  test('camada de disco serve sem passar pela memoria', async () => {
    const key = 'k:disco';
    await writeFile(fileFor(key), JSON.stringify({ at: Date.now(), value: { titulo: 'do disco' } }));
    const value = await cached<{ titulo: string }>(key, 60_000, async () => {
      throw new Error('nao deveria consultar o provider');
    });
    expect(value).toEqual({ titulo: 'do disco' });
  });

  test('arquivo de cache corrompido recarrega em vez de estourar', async () => {
    const key = 'k:corrompido';
    await writeFile(fileFor(key), '{isto nao e json');
    expect(await cached(key, 60_000, async () => 'recarregado')).toBe('recarregado');
  });

  test('entrada de disco vencida nao e servida', async () => {
    const key = 'k:disco-velho';
    await writeFile(fileFor(key), JSON.stringify({ at: Date.now() - 90_000, value: 'antigo' }));
    expect(await cached(key, 1_000, async () => 'novo')).toBe('novo');
  });

  test('chaves diferentes nao se misturam', async () => {
    await cached('k:a', 60_000, async () => 'A');
    expect(await cached('k:b', 60_000, async () => 'B')).toBe('B');
    expect(await cached('k:a', 60_000, async () => 'outro')).toBe('A');
  });
});
