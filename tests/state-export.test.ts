import { beforeEach, describe, expect, test } from 'bun:test';

// state.ts guarda tudo num modulo singleton (`store`) que le do localStorage no
// import — precisa de um `localStorage` global antes de importar o modulo.
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
(globalThis as { window?: Window }).window = globalThis as unknown as Window;
(globalThis as { document?: Pick<Document, 'addEventListener'> }).document = {
  addEventListener: () => {},
};

const {
  store,
  exportStore,
  importStore,
  toggleFavorite,
  saveProgress,
  toggleBookmark,
  markUpTo,
  isChapterRead,
  isFavorite,
  getProgress,
  hasBookmark,
} = await import('../src/client/state.ts');

function populate(): void {
  toggleFavorite({ provider: 'mangadex', id: 's1', title: 'Serie Um', cover: 'c1' });
  saveProgress({
    provider: 'mangadex',
    seriesId: 's1',
    chapterId: 'c1',
    chapterLabel: '1',
    page: 3,
    title: 'Serie Um',
    at: Date.now(),
  });
  markUpTo('mangadex', 's1', ['c1', 'c2']);
  toggleBookmark({ provider: 'mangadex', seriesId: 's1', chapterId: 'c1', chapterLabel: '1', page: 3, title: 'Serie Um' });
}

function clearAll(): void {
  store.favorites = {};
  store.progress = {};
  store.read = {};
  store.bookmarks = [];
}

describe('exportStore / importStore', () => {
  beforeEach(() => clearAll());

  test('round-trip: exportar e importar num store limpo restaura tudo identico', () => {
    populate();
    const backup = exportStore();

    clearAll();
    expect(isFavorite('mangadex', 's1')).toBe(false);

    const result = importStore(backup);
    expect(result).toEqual({ ok: true });
    expect(isFavorite('mangadex', 's1')).toBe(true);
    expect(getProgress('mangadex', 's1')?.page).toBe(3);
    expect(isChapterRead('mangadex', 's1', 'c1')).toBe(true);
    expect(isChapterRead('mangadex', 's1', 'c2')).toBe(true);
    expect(hasBookmark('mangadex', 'c1', 3)).toBe(true);
  });

  test('JSON malformado falha sem tocar no estado atual', () => {
    populate();
    // `exportedAt` muda a cada milissegundo: comparar o backup inteiro falhava sob carga
    const before = JSON.parse(exportStore()).store;
    const result = importStore('{ isso nao e json valido');
    expect(result.ok).toBe(false);
    expect(JSON.parse(exportStore()).store).toEqual(before);
  });

  test('JSON valido mas sem o formato de backup falha sem tocar no estado atual', () => {
    populate();
    // `exportedAt` muda a cada milissegundo: comparar o backup inteiro falhava sob carga
    const before = JSON.parse(exportStore()).store;
    const result = importStore(JSON.stringify({ hello: 'world' }));
    expect(result.ok).toBe(false);
    expect(JSON.parse(exportStore()).store).toEqual(before);
  });

  test.each([
    ['favoritos null', { favorites: null }],
    ['favoritos array', { favorites: [] }],
    ['progresso null', { progress: null }],
    ['progresso array', { progress: [1, 2] }],
    ['settings null', { settings: null }],
  ])('backup com %s e recusado sem tocar no estado', (_n, patch) => {
    populate();
    const before = JSON.parse(exportStore()).store;
    const backup = JSON.parse(exportStore());
    Object.assign(backup.store, patch);
    expect(importStore(JSON.stringify(backup)).ok).toBe(false);
    expect(JSON.parse(exportStore()).store).toEqual(before);
  });

  test('entradas que nao sao objeto sao descartadas na importacao', () => {
    populate();
    const backup = JSON.parse(exportStore());
    backup.store.favorites.lixo = null;
    backup.store.bookmarks.push(42);
    expect(importStore(JSON.stringify(backup)).ok).toBe(true);
    const after = JSON.parse(exportStore()).store;
    expect(after.favorites.lixo).toBeUndefined();
    expect(after.bookmarks).not.toContain(42);
  });
});
