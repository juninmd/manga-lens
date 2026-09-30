import { cached, defaultTtl } from '../cache.ts';
import { registerImageHost } from '../config.ts';
import { fetchJson } from '../http.ts';
import type { Provider, SeriesCard } from './types.ts';

const BASE = 'https://www.hq-now.com';
const API = 'https://admin.hq-now.com/graphql';
registerImageHost('admin.hq-now.com');
registerImageHost('static.hq-now.com');
interface Comic { id: number; name: string; hqCover?: string | null; synopsis?: string; status?: string; publisherName?: string; capitulos?: { id: number; name: string; number: number }[] }

async function query<T>(gql: string, variables: Record<string, string | number | boolean> = {}, signal?: AbortSignal): Promise<T> {
  const result = await fetchJson<{ data?: T; errors?: { message: string }[] }>(API, {
    method: 'POST', body: JSON.stringify({ query: gql, variables }),
    headers: { 'Content-Type': 'application/json' }, referer: `${BASE}/`, signal,
  });
  if (result.errors?.length || !result.data) throw new Error('HQ Now: resposta GraphQL invalida');
  return result.data;
}
function numericId(id: string): number {
  if (!/^\d+$/.test(id) || !Number.isSafeInteger(Number(id))) throw new Error('id de HQ invalido');
  return Number(id);
}
function imageUrl(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  const url = new URL(value);
  // The API still publishes HTTP links; this CDN supports HTTPS directly.
  if (url.hostname === 'static.hq-now.com' && url.protocol === 'http:') url.protocol = 'https:';
  return url.href;
}
const card = (c: Comic): SeriesCard => ({ id: String(c.id), provider: 'hqnow', title: c.name,
  contentType: 'hq', type: 'comic', origin: 'en', description: c.synopsis, cover: imageUrl(c.hqCover),
  coverReferer: `${BASE}/`, url: `${BASE}/hq/${c.id}`, status: c.status === 'Concluído' ? 'completed' : 'ongoing' });

export const hqnow: Provider = {
  id: 'hqnow', name: 'HQ Now', kind: 'online', contentType: 'hq', languages: ['pt-br'], supports: ['q'],
  async search(f) {
    const q = f.q?.trim() ?? '';
    return cached(`hqnow:search:v2:${q}:${f.limit ?? 24}`, defaultTtl(), async () => {
      if (q) {
        const data = await query<{ getHqsByName: Comic[] }>('query($name: String!) { getHqsByName(name: $name) { id name synopsis status publisherName } }', { name: q }, f.signal);
        return { items: data.getHqsByName.map(card) };
      }
      const data = await query<{ getHqsByFilters: Comic[] }>('query($limit: Int!) { getHqsByFilters(orderByViews: true, limit: $limit, loadCovers: true) { id name hqCover synopsis status publisherName } }', { limit: f.limit ?? 24 }, f.signal);
      return { items: data.getHqsByFilters.map(card) };
    });
  },
  async series(id) {
    const n = numericId(id);
    return cached(`hqnow:series:v2:${id}`, defaultTtl(), async () => {
      const data = await query<{ getHqsById: Comic[] }>('query($id: Int!) { getHqsById(id: $id) { id name hqCover synopsis status publisherName capitulos { id name number } } }', { id: n });
      const comic = data.getHqsById[0];
      if (!comic) throw new Error('HQ Now: obra nao encontrada');
      return { ...card(comic), authors: comic.publisherName ? [comic.publisherName] : [], availableLangs: ['pt-br'],
        chapters: (comic.capitulos ?? []).sort((a, b) => a.number - b.number).map((c) => ({ id: String(c.id), provider: 'hqnow', seriesId: id,
          number: String(c.number), title: c.name || `#${c.number}`, lang: 'pt-br' })) };
    });
  },
  async pages(id) {
    const data = await query<{ getChapterById: { pictures: { pictureUrl: string }[] } }>('query($id: Int!) { getChapterById(chapterId: $id) { pictures { pictureUrl } } }', { id: numericId(id) });
    const pages = data.getChapterById.pictures.map((p) => ({ url: imageUrl(p.pictureUrl)!, referer: `${BASE}/` }));
    if (!pages.length) throw new Error('HQ Now: capitulo sem paginas');
    return pages;
  },
};
