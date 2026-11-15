/**
 * Traducoes corrigidas a mao, balao por balao. Ficam no aparelho (localStorage),
 * separadas do estado principal: sao muitas e pequenas, e uma cota estourada
 * aqui nao pode levar junto o progresso e os favoritos.
 *
 * A chave inclui o texto ORIGINAL do balao, nao o id: o id e' a posicao na lista
 * do OCR e muda quando o detector muda; o texto continua o mesmo.
 */
export interface EditScope {
  provider: string;
  seriesId: string;
  chapterId: string;
  page: number;
  /** idioma de chegada: a correcao em ingles nao vale para o portugues */
  target: string;
}

interface Saved {
  pt: string;
  at: number;
}

const KEY = 'manga-lens:edits:v1';
/** teto de correcoes guardadas; as mais antigas saem primeiro */
export const MAX_EDITS = 3000;
export const MAX_EDIT_CHARS = 600;

/** Mesmo balao lido com uma diferenca de espaco ou caixa continua sendo o mesmo balao. */
export const normText = (s: string): string => s.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();

export const editKey = (scope: EditScope, original: string): string =>
  [scope.provider, scope.seriesId, scope.chapterId, scope.page, scope.target.toLowerCase(), normText(original)].join('\u0001');

export interface EditStore {
  get(scope: EditScope, original: string): string | undefined;
  set(scope: EditScope, original: string, pt: string): void;
  remove(scope: EditScope, original: string): void;
  /** aplica as correcoes guardadas a uma pagina recem-traduzida */
  apply<T extends { text: string; pt?: string; edited?: boolean }>(scope: EditScope, blocks: T[]): T[];
}

type Storage = Pick<globalThis.Storage, 'getItem' | 'setItem'>;

export function createEditStore(storage: Storage | undefined): EditStore {
  let cache: Record<string, Saved> | undefined;

  const load = (): Record<string, Saved> => {
    if (cache) return cache;
    try {
      const raw = JSON.parse(storage?.getItem(KEY) ?? '{}') as unknown;
      cache = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, Saved>) : {};
    } catch {
      cache = {};
    }
    return cache;
  };

  const save = (): void => {
    const all = load();
    const keys = Object.keys(all);
    if (keys.length > MAX_EDITS) {
      for (const k of keys.sort((a, b) => (all[a]?.at ?? 0) - (all[b]?.at ?? 0)).slice(0, keys.length - MAX_EDITS)) delete all[k];
    }
    try {
      storage?.setItem(KEY, JSON.stringify(all));
    } catch {
      /* cota cheia: a correcao vale ate' fechar o app */
    }
  };

  return {
    get(scope, original) {
      const hit = load()[editKey(scope, original)];
      return typeof hit?.pt === 'string' ? hit.pt : undefined;
    },
    set(scope, original, pt) {
      const text = pt.replace(/\r\n?/g, '\n').trim().slice(0, MAX_EDIT_CHARS);
      if (!normText(original)) return;
      load()[editKey(scope, original)] = { pt: text, at: Date.now() };
      save();
    },
    remove(scope, original) {
      delete load()[editKey(scope, original)];
      save();
    },
    apply(scope, blocks) {
      return blocks.map((b) => {
        const pt = this.get(scope, b.text);
        return pt === undefined ? b : { ...b, pt, edited: true };
      });
    },
  };
}

export const edits = createEditStore(typeof localStorage === 'undefined' ? undefined : localStorage);
