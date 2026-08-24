import { config } from '../config.ts';
import { mangadex } from './mangadex.ts';
import { mangapill } from './mangapill.ts';
import { weebcentral } from './weebcentral.ts';
import { local } from './local.ts';
import { archive } from './archive.ts';
import { createMadaraProvider, madaraSites } from './madara.ts';
import type { Provider, SearchFilters, SeriesCard } from './types.ts';

export const providers: Provider[] = [
  mangadex,
  weebcentral,
  mangapill,
  ...madaraSites().map(createMadaraProvider),
  archive,
  local,
];

export const enabledProviders = (): Provider[] =>
  providers.filter((p) => p.kind === 'online' || config.localRoots.length > 0);

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

/** Busca em N providers em paralelo; provider que cai vira aviso, nao erro fatal. */
export async function searchAll(ids: string[], filters: SearchFilters): Promise<AggregatedSearch> {
  const chosen = ids.length ? ids.map(getProvider) : enabledProviders();
  const settled = await Promise.allSettled(chosen.map((p) => p.search(filters)));

  const items: SeriesCard[] = [];
  const errors: AggregatedSearch['errors'] = [];
  const perProvider: Record<string, number> = {};

  settled.forEach((r, i) => {
    const provider = chosen[i]!;
    if (r.status === 'fulfilled') {
      perProvider[provider.id] = r.value.items.length;
      items.push(...r.value.items);
    } else {
      perProvider[provider.id] = 0;
      errors.push({ provider: provider.id, message: String(r.reason?.message ?? r.reason) });
    }
  });

  // Intercala os providers para nenhum monopolizar o topo da grade.
  const byProvider = new Map<string, SeriesCard[]>();
  for (const it of items) {
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

export type { Provider, SearchFilters, SeriesCard };
