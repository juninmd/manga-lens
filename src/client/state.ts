export type ReadingMode = 'single' | 'double' | 'strip';
export type FitMode = 'width' | 'page' | 'height' | 'free';

export type TranslateEngine = 'auto' | 'llm' | 'google' | 'mymemory';
export type LetterFont = 'comic' | 'sans' | 'serif';
export type TranslateMode = 'ocr' | 'ai';
export type AiProviderName = 'openrouter' | 'ollama' | 'openaicompatible';

export interface Settings {
  mode: ReadingMode;
  fit: FitMode;
  rtl: boolean;
  ocrLang: string;
  autoTranslate: boolean;
  showOriginal: boolean;
  invertScroll: boolean;
  engine: TranslateEngine;
  /** modo de traducao: OCR tradicional (motores web) ou IA (LLM) */
  translateMode: TranslateMode;
  /** idioma de chegada da traducao (pt-BR, en, es...) */
  targetLang: string;
  /** familia usada para letreirar a traducao dentro do balao */
  font: LetterFont;
  /** provider de IA (openrouter, ollama, openaicompatible) */
  aiProvider: AiProviderName;
}

export interface Bookmark {
  provider: string;
  seriesId: string;
  chapterId: string;
  chapterLabel: string;
  page: number;
  title: string;
  cover?: string;
  at: number;
}

export interface Progress {
  seriesId: string;
  chapterId: string;
  chapterLabel: string;
  page: number;
  title: string;
  provider: string;
  cover?: string;
  at: number;
}

const KEY = 'manga-lens:v1';

interface Store {
  settings: Settings;
  favorites: Record<string, { provider: string; id: string; title: string; cover?: string; at: number }>;
  progress: Record<string, Progress>;
  /** capitulos ja' lidos, por serie */
  read: Record<string, string[]>;
  bookmarks: Bookmark[];
}

const DEFAULTS: Store = {
  settings: {
    mode: 'single',
    fit: 'page',
    rtl: true,
    ocrLang: 'auto',
    autoTranslate: false,
    showOriginal: false,
    invertScroll: false,
    engine: 'auto',
    // primeiro uso sem IA configurada: o motor web traduz sem chave nenhuma
    translateMode: 'ocr',
    targetLang: 'pt-BR',
    font: 'comic',
    aiProvider: 'ollama',
  },
  favorites: {},
  progress: {},
  read: {},
  bookmarks: [],
};

function load(): Store {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return structuredClone(DEFAULTS);
    const parsed = JSON.parse(raw) as Partial<Store>;
    return {
      settings: { ...DEFAULTS.settings, ...parsed.settings },
      favorites: parsed.favorites ?? {},
      progress: parsed.progress ?? {},
      read: parsed.read ?? {},
      bookmarks: parsed.bookmarks ?? [],
    };
  } catch {
    // JSON quebrado: o proximo persist() sobrescreveria o valor cru, que ainda
    // da' para recuperar a mao. Guarda uma copia antes de cair no padrao.
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) localStorage.setItem(`${KEY}.corrupt`, raw);
    } catch {
      /* sem espaco: nao ha' o que salvar */
    }
    return structuredClone(DEFAULTS);
  }
}

export const store: Store = load();

let saveTimer: number | undefined;

function writeNow(): void {
  clearTimeout(saveTimer);
  saveTimer = undefined;
  try {
    localStorage.setItem(KEY, JSON.stringify(store));
  } catch {
    /* quota cheia: preferencia nao vale travar a leitura */
  }
}

export function persist(): void {
  clearTimeout(saveTimer);
  saveTimer = window.setTimeout(writeNow, 200);
}

/**
 * O debounce economiza escrita durante a leitura, mas a janela pode morrer antes
 * de ele disparar — fechar o app logo depois de virar a pagina perdia a posicao.
 * `pagehide` cobre fechar/navegar; `visibilitychange` cobre o app mandado para o
 * fundo no desktop, que nem sempre chega a emitir `pagehide`.
 */
if (typeof window !== 'undefined') {
  const flush = (): void => {
    if (saveTimer !== undefined) writeNow();
  };
  window.addEventListener('pagehide', flush);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flush();
  });
}

export const seriesKey = (provider: string, id: string): string => `${provider}:${id}`;

export function toggleFavorite(s: { provider: string; id: string; title: string; cover?: string }): boolean {
  const k = seriesKey(s.provider, s.id);
  if (store.favorites[k]) {
    delete store.favorites[k];
    persist();
    return false;
  }
  store.favorites[k] = { ...s, at: Date.now() };
  persist();
  return true;
}

export const isFavorite = (provider: string, id: string): boolean => Boolean(store.favorites[seriesKey(provider, id)]);

/** Favoritos do mais recente para o mais antigo. */
export const favorites = (): { provider: string; id: string; title: string; cover?: string; at: number }[] =>
  Object.values(store.favorites).sort((a, b) => b.at - a.at);

export function saveProgress(p: Progress): void {
  store.progress[seriesKey(p.provider, p.seriesId)] = {
    seriesId: p.seriesId,
    chapterId: p.chapterId,
    chapterLabel: p.chapterLabel,
    page: p.page,
    title: p.title,
    provider: p.provider,
    cover: p.cover,
    at: Date.now(),
  };
  persist();
}

export const getProgress = (provider: string, seriesId: string): Progress | undefined =>
  store.progress[seriesKey(provider, seriesId)];

/**
 * Troca a capa guardada de uma obra em todos os lugares que a repetem. Capa e'
 * salva ja' assinada; assinatura feita por um servidor antigo responde 403 para
 * sempre, e sem regravar a entrada o favorito ficaria sem imagem ate' o usuario
 * desfavoritar e favoritar de novo.
 */
export function updateStoredCover(provider: string, id: string, cover: string): void {
  const key = seriesKey(provider, id);
  const fav = store.favorites[key];
  if (fav) fav.cover = cover;
  const progress = store.progress[key];
  if (progress) progress.cover = cover;
  for (const mark of store.bookmarks) {
    if (mark.provider === provider && mark.seriesId === id) mark.cover = cover;
  }
  persist();
}

// ---------- capitulos lidos ----------

/**
 * O Set fica guardado por serie. Montar um novo a cada consulta parecia barato,
 * mas `isChapterRead` e' chamado uma vez por linha da lista: em obra longa (Naruto
 * tem 701 capitulos) sao 701 Sets construidos, ~490 mil insercoes, a cada
 * renderizacao do painel — e o painel re-renderiza a cada capitulo marcado.
 */
const readCache = new Map<string, Set<string>>();

const readSet = (provider: string, seriesId: string): Set<string> => {
  const key = seriesKey(provider, seriesId);
  let set = readCache.get(key);
  if (!set) {
    set = new Set(store.read[key] ?? []);
    readCache.set(key, set);
  }
  return set;
};

export const isChapterRead = (provider: string, seriesId: string, chapterId: string): boolean =>
  readSet(provider, seriesId).has(chapterId);

export const readCount = (provider: string, seriesId: string): number =>
  (store.read[seriesKey(provider, seriesId)] ?? []).length;

/**
 * "Continuar" num capitulo ja' terminado (marcado lido ou salvo na ultima pagina)
 * devolve o seguinte no mesmo idioma; senao `undefined` (retoma o proprio).
 */
export function nextUnreadChapter<C extends { id: string; lang?: string; pages?: number }>(
  detail: { provider: string; id: string; chapters: C[] },
  chapter: C,
  page: number,
): C | undefined {
  const finished =
    // `pages: 0` (desconhecido) nao pode contar como terminado — mesma regra de resumePage
    isChapterRead(detail.provider, detail.id, chapter.id) || (chapter.pages ? page >= chapter.pages - 1 : false);
  if (!finished) return undefined;
  const same = detail.chapters.filter((c) => (c.lang ?? '') === (chapter.lang ?? ''));
  const i = same.findIndex((c) => c.id === chapter.id);
  return i >= 0 ? same[i + 1] : undefined;
}

export function markChapterRead(provider: string, seriesId: string, chapterId: string, read = true): void {
  markUpTo(provider, seriesId, [chapterId], read);
}

/** Marca o capitulo e todos os anteriores — como se pega uma serie no meio. */
/** Volta so' as preferencias (modo, ajuste, motor, idiomas, letra) ao padrao; favoritos e progresso ficam. */
export function resetSettings(): void {
  store.settings = structuredClone(DEFAULTS.settings);
  persist();
}

export function markUpTo(provider: string, seriesId: string, chapterIds: string[], read = true): void {
  const set = readSet(provider, seriesId);
  for (const id of chapterIds) {
    if (read) set.add(id);
    else set.delete(id);
  }
  store.read[seriesKey(provider, seriesId)] = [...set];
  persist();
}

// ---------- marcadores ----------

const sameSpot = (a: Bookmark, provider: string, chapterId: string, page: number): boolean =>
  a.provider === provider && a.chapterId === chapterId && a.page === page;

export function toggleBookmark(mark: Omit<Bookmark, 'at'>): boolean {
  const i = store.bookmarks.findIndex((b) => sameSpot(b, mark.provider, mark.chapterId, mark.page));
  if (i >= 0) {
    store.bookmarks.splice(i, 1);
    persist();
    return false;
  }
  store.bookmarks.unshift({ ...mark, at: Date.now() });
  store.bookmarks = store.bookmarks.slice(0, 200);
  persist();
  return true;
}

export const hasBookmark = (provider: string, chapterId: string, page: number): boolean =>
  store.bookmarks.some((b) => sameSpot(b, provider, chapterId, page));

export const bookmarks = (): Bookmark[] => [...store.bookmarks].sort((a, b) => b.at - a.at);

/** Mesma obra em duas fontes: chave por titulo, sem pontuacao nem caixa. */
export const titleKey = (title: string): string =>
  title
    .toLowerCase()
    .normalize('NFD')
    .replace(/[^a-z0-9]/g, '');

/**
 * Progresso mais recente por obra (a mesma obra em dois sites aparecia duas vezes).
 * Compromisso: duas obras diferentes com o mesmo titulo exato (ex. dois "Monster")
 * tambem colapsam — raro, e a outra continua acessivel pelo painel/favoritos.
 */
export const recentReads = (keep: (p: Progress) => boolean = () => true): Progress[] => {
  const seen = new Set<string>();
  const out: Progress[] = [];
  for (const p of Object.values(store.progress).sort((a, b) => b.at - a.at)) {
    // filtrar depois do corte em 12 escondia as HQs lidas atras de 12 mangas recentes
    if (!keep(p)) continue;
    const key = titleKey(p.title) || seriesKey(p.provider, p.seriesId);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p);
    if (out.length >= 12) break;
  }
  return out;
};

// ---------- backup (export/import) ----------

interface StoreBackup {
  version: 1;
  exportedAt: string;
  store: Store;
}

/** JSON baixavel com favoritos, progresso, marcadores e capitulos lidos — para trocar de maquina sem perder nada. */
export function exportStore(): string {
  const payload: StoreBackup = { version: 1, exportedAt: new Date().toISOString(), store };
  return JSON.stringify(payload, null, 2);
}

/** Sobrescreve o estado a partir de um backup exportado por `exportStore`. Falha sem tocar no estado atual se o JSON for invalido ou incompleto. */
export function importStore(json: string): { ok: true } | { ok: false; error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return { ok: false, error: 'arquivo nao e um JSON valido' };
  }
  const backup = parsed as Partial<StoreBackup> | null;
  const s = backup?.store as Partial<Store> | undefined;
  if (
    !s ||
    typeof s.settings !== 'object' ||
    typeof s.favorites !== 'object' ||
    typeof s.progress !== 'object' ||
    typeof s.read !== 'object' ||
    !Array.isArray(s.bookmarks)
  ) {
    return { ok: false, error: 'arquivo nao parece um backup do MangaLens' };
  }
  store.settings = { ...DEFAULTS.settings, ...s.settings };
  store.favorites = s.favorites as Store['favorites'];
  store.progress = s.progress as Store['progress'];
  store.read = s.read as Store['read'];
  store.bookmarks = s.bookmarks as Bookmark[];
  readCache.clear();
  persist();
  return { ok: true };
}
