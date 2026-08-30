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
    const before = exportStore();
    const result = importStore('{ isso nao e json valido');
    expect(result.ok).toBe(false);
    expect(exportStore()).toBe(before);
  });

  test('JSON valido mas sem o formato de backup falha sem tocar no estado atual', () => {
    populate();
    const before = exportStore();
    const result = importStore(JSON.stringify({ hello: 'world' }));
    expect(result.ok).toBe(false);
    expect(exportStore()).toBe(before);
  });
});
