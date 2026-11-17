import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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

const { asPayload, mergePayloads } = await import('../src/client/sync.ts');
const { default: server } = await import('../src/server/index.ts');
const { setSyncDir } = await import('../src/server/sync.ts');

type P = Parameters<typeof mergePayloads>[0];
const empty = (): P => ({ version: 1, updatedAt: 0, favorites: {}, progress: {}, read: {}, bookmarks: [], removed: {} });
const fav = (id: string, at: number) => ({ provider: 'p', id, title: id, at });
const prog = (page: number, at: number) => ({ provider: 'p', seriesId: 's', chapterId: 'c', chapterLabel: '1', title: 't', page, at });
const mark = (page: number, at: number) => ({ provider: 'p', seriesId: 's', chapterId: 'c', chapterLabel: '1', title: 't', page, at });

describe('juntar duas maquinas', () => {
  test('progresso: o mais recente vence', () => {
    const a = { ...empty(), progress: { 'p:s': prog(3, 100) } };
    const b = { ...empty(), progress: { 'p:s': prog(9, 200) } };
    expect(mergePayloads(a, b).progress['p:s']?.page).toBe(9);
    expect(mergePayloads(b, a).progress['p:s']?.page).toBe(9);
  });

  test('favoritos e lidos se somam', () => {
    const a = { ...empty(), favorites: { 'p:a': fav('a', 1) }, read: { 'p:s': ['c1'] } };
    const b = { ...empty(), favorites: { 'p:b': fav('b', 2) }, read: { 'p:s': ['c1', 'c2'] } };
    const m = mergePayloads(a, b);
    expect(Object.keys(m.favorites).sort()).toEqual(['p:a', 'p:b']);
    expect(m.read['p:s']).toEqual(['c1', 'c2']);
  });

  test('favorito removido numa maquina nao volta pela outra', () => {
    const now = Date.now();
    const a = { ...empty(), removed: { 'fav:p:a': now } };
    const b = { ...empty(), favorites: { 'p:a': fav('a', now - 1000) } };
    expect(mergePayloads(a, b).favorites['p:a']).toBeUndefined();
    // favoritado de novo depois da remocao: volta
    const c = { ...empty(), favorites: { 'p:a': fav('a', now + 1000) } };
    expect(mergePayloads(a, c).favorites['p:a']).toBeDefined();
  });

  test('marcador removido some; duplicado vira um', () => {
    const now = Date.now();
    const a = { ...empty(), bookmarks: [mark(1, now - 10), mark(2, now - 5)], removed: { 'bm:p:c:1': now } };
    const b = { ...empty(), bookmarks: [mark(2, now - 1)] };
    const m = mergePayloads(a, b);
    expect(m.bookmarks.map((x) => [x.page, x.at])).toEqual([[2, now - 1]]);
  });

  test('arquivo remoto estranho e filtrado, nao corrompe', () => {
    expect(asPayload(null)).toBeNull();
    expect(asPayload({ version: 2 })).toBeNull();
    const p = asPayload({ version: 1, favorites: { x: null, y: fav('y', 1) }, read: { s: ['a', 3] }, bookmarks: [1, mark(1, 1)], removed: { k: 'x' } });
    expect(Object.keys(p!.favorites)).toEqual(['y']);
    expect(p!.read.s).toEqual(['a']);
    expect(p!.bookmarks).toHaveLength(1);
    expect(p!.removed).toEqual({});
  });
});

const dir = await mkdtemp(join(tmpdir(), 'manga-lens-sync-'));

describe('rotas de sincronizacao', () => {
  afterAll(() => rm(dir, { recursive: true, force: true }));
  afterEach(() => setSyncDir(''));
  const req = (path: string, init?: RequestInit) => server.fetch(new Request(`http://127.0.0.1${path}`, init));
  const post = (path: string, body: unknown) =>
    req(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

  test('desligada: 409', async () => {
    expect((await req('/api/sync')).status).toBe(409);
  });

  test('pasta relativa ou inexistente e recusada', async () => {
    expect((await post('/api/sync/config', { dir: 'relativa' })).status).toBe(400);
    expect((await post('/api/sync/config', { dir: join(dir, 'nao-existe') })).status).toBe(400);
  });

  test('grava e le o arquivo na pasta', async () => {
    expect((await post('/api/sync/config', { dir })).status).toBe(200);
    expect(((await (await req('/api/sync')).json()) as { data: unknown }).data).toBeNull();
    expect((await post('/api/sync', { data: { version: 1, favorites: {} } })).status).toBe(200);
    expect(JSON.parse(await readFile(join(dir, 'manga-lens-sync.json'), 'utf-8'))).toEqual({ version: 1, favorites: {} });
  });

  test('arquivo pela metade (nuvem baixando) nao e sobrescrito', async () => {
    await post('/api/sync/config', { dir });
    await writeFile(join(dir, 'manga-lens-sync.json'), '{"version":1,"fav');
    expect((await req('/api/sync')).status).toBe(409);
  });
});
