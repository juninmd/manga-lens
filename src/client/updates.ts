import { getSeries, type SeriesDetail } from './api.ts';
import { favorites, persist, type Favorite } from './state.ts';

/** Mesma obra nao e' consultada de novo antes disso. */
export const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;
/** Consultas simultaneas: favoritos demais nao podem derrubar a fonte nem a rede. */
const CONCURRENCY = 3;

export interface NewChapters {
  provider: string;
  id: string;
  title: string;
  count: number;
}

/**
 * Confere os favoritos e anota quantos capitulos novos cada um tem. A primeira
 * consulta so' fixa a linha de base: sem ela, todo favorito antigo apareceria
 * com a lista inteira como "nova".
 */
export async function checkFavorites(
  load: (provider: string, id: string) => Promise<SeriesDetail> = getSeries,
  now = Date.now(),
): Promise<NewChapters[]> {
  const due = favorites().filter((f) => !f.checkedAt || now - f.checkedAt >= CHECK_EVERY_MS);
  const found: NewChapters[] = [];
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < due.length) {
      const fav = due[next++]!;
      try {
        const detail = await load(fav.provider, fav.id);
        if (applyCount(fav, detail.chapters.length, now)) {
          found.push({ provider: fav.provider, id: fav.id, title: fav.title, count: fav.newChapters ?? 0 });
        }
      } catch {
        /* fonte fora do ar: tenta na proxima rodada */
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, due.length) }, worker));
  if (due.length) persist();
  return found;
}

/** Atualiza o favorito com a contagem atual; devolve true quando apareceu capitulo novo agora. */
export function applyCount(fav: Favorite, count: number, now = Date.now()): boolean {
  fav.checkedAt = now;
  if (fav.knownCount === undefined) {
    fav.knownCount = count;
    fav.newChapters = 0;
    return false;
  }
  const fresh = Math.max(0, count - fav.knownCount);
  const grew = fresh > (fav.newChapters ?? 0);
  fav.newChapters = fresh;
  return grew;
}

/** Texto do aviso: "Naruto (+2)" ou "3 obras com capitulos novos". */
export function updatesMessage(found: NewChapters[]): string {
  if (found.length === 1) {
    const f = found[0]!;
    return `capitulo${f.count > 1 ? 's' : ''} novo${f.count > 1 ? 's' : ''} em ${f.title} (+${f.count})`;
  }
  return `${found.length} obras favoritas com capitulos novos`;
}
