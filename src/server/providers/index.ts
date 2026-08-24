import { config } from '../config.ts';
import { mangadex } from './mangadex.ts';
import { mangapill } from './mangapill.ts';
import { weebcentral } from './weebcentral.ts';
import { local } from './local.ts';
import { archive } from './archive.ts';
import { createMadaraProvider, madaraSites } from './madara.ts';
import type { ContentType, Provider, SearchFilters, SeriesCard } from './types.ts';

export const providers: Provider[] = [
  mangadex,
  weebcentral,
  mangapill,
  ...madaraSites().map(createMadaraProvider),
  archive,
  local,
];

export const enabledProviders = (contentType?: ContentType): Provider[] =>
  providers
    .filter((p) => p.kind === 'online' || config.localRoots.length > 0)
    .filter((p) => !contentType || p.contentType === contentType);

export function getProvider(id: string): Provider {
  const p = providers.find((x) => x.id === id);
  if (!p) throw new Error(`provider desconhecido: ${id}`);
  return p;
}

export interface AggregatedSearch {
  items: SeriesCard[];
  errors: { provider: string; message: string }[];
  perProvider: Record<string, number>;
}

/**
 * Chave de titulo para juntar a mesma obra vinda de sites diferentes. O mesmo
 * manga so' costuma divergir na pontuacao — "NARUTO" vs "Naruto", travessao vs
 * hifen, apostrofo curvo vs reto, ":" vs " - ".
 *
 * De proposito NAO remove parenteses nem subtitulo: "Naruto (Color)" e
 * "Naruto - Digital Colored Comics" sao edicoes distintas, e doujinshi como
 * "Naruto - Rocket (Doujinshi)" e' outra obra. Juntar isso seria perder material.
 */
function titleKey(title: string): string {
  return title
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // acentos soltos pelo NFD
    .toLowerCase()
    .replace(/[‘’ʼ]/g, "'") // apostrofo curvo -> reto
    .replace(/[:‐-―-]+/g, ' ') // ":" e a familia do travessao -> espaco
    .replace(/[^a-z0-9' ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Entre duas entradas da mesma obra, a que tem mais material vira a principal. */
const richness = (c: SeriesCard): number =>
  (c.cover ? 4 : 0) + (c.description ? 2 : 0) + (c.tags?.length ? 1 : 0);

/**
 * Junta a mesma obra publicada em varios sites num card so', guardando cada
 * origem em `sources`. Sem isso uma busca por "naruto" devolve o mesmo titulo
 * quatro vezes e empurra o resto do catalogo para fora da primeira pagina.
 */
function mergeDuplicates(items: SeriesCard[]): SeriesCard[] {
  const groups = new Map<string, SeriesCard[]>();
  const order: string[] = [];
  for (const item of items) {
    const key = titleKey(item.title);
    if (!key) continue;
    const group = groups.get(key);
    if (group) group.push(item);
    else {
      groups.set(key, [item]);
      order.push(key);
    }
  }

  return order.map((key) => {
    const group = groups.get(key)!;
    // o mesmo provider pode repetir a obra na propria lista: uma origem por site
    const seen = new Set<string>();
    const sources = group
      .filter((c) => !seen.has(c.provider) && seen.add(c.provider))
      .map((c) => ({ provider: c.provider, id: c.id, title: c.title }));
    const primary = [...group].sort((a, b) => richness(b) - richness(a))[0]!;
    return { ...primary, sources };
  });
}

/** Busca em N providers em paralelo; provider que cai vira aviso, nao erro fatal. */
export async function searchAll(ids: string[], filters: SearchFilters): Promise<AggregatedSearch> {
  const chosen = ids.length ? ids.map(getProvider) : enabledProviders(filters.contentType);
  const settled = await Promise.allSettled(chosen.map((p) => p.search(filters)));

  const items: SeriesCard[] = [];
  const errors: AggregatedSearch['errors'] = [];
  const perProvider: Record<string, number> = {};

  settled.forEach((r, i) => {
    const provider = chosen[i]!;
    if (r.status === 'fulfilled') {
      // safety net: provider misto (ex. biblioteca local com mangá + livro)
      // pode devolver card de outro tipo — o card decide, provider e' so' o default
      const filtered = filters.contentType
        ? r.value.items.filter((it) => (it.contentType ?? provider.contentType) === filters.contentType)
        : r.value.items;
      perProvider[provider.id] = filtered.length;
      items.push(...filtered);
    } else {
      perProvider[provider.id] = 0;
      errors.push({ provider: provider.id, message: String(r.reason?.message ?? r.reason) });
    }
  });

  // Intercala os providers para nenhum monopolizar o topo da grade.
  const byProvider = new Map<string, SeriesCard[]>();
  for (const it of mergeDuplicates(items)) {
    const arr = byProvider.get(it.provider) ?? [];
    arr.push(it);
    byProvider.set(it.provider, arr);
  }
  const interleaved: SeriesCard[] = [];
  const lists = [...byProvider.values()];
  for (let i = 0; lists.some((l) => l.length > i); i++) {
    for (const l of lists) if (l[i]) interleaved.push(l[i]!);
  }

  return { items: interleaved, errors, perProvider };
}

export type { ContentType, Provider, SearchFilters, SeriesCard };
