import { api } from './base.ts';

export interface ProviderInfo {
  id: string;
  name: string;
  kind: 'online' | 'local';
  supports: string[];
  languages: string[];
}

export interface SeriesCard {
  id: string;
  provider: string;
  title: string;
  altTitles?: string[];
  cover?: string;
  year?: number;
  status?: string;
  origin?: string;
  type?: string;
  demographic?: string;
  contentRating?: string;
  rating?: number;
  follows?: number;
  tags?: string[];
  description?: string;
  url?: string;
  /** origens da mesma obra quando a busca agregada juntou duplicatas */
  sources?: { provider: string; id: string; title: string }[];
}

export interface ChapterRef {
  id: string;
  provider: string;
  seriesId: string;
  number?: string;
  volume?: string;
  title?: string;
  lang?: string;
  group?: string;
  pages?: number;
  publishedAt?: string;
}

export interface SeriesDetail extends SeriesCard {
  authors?: string[];
  chapters: ChapterRef[];
  availableLangs?: string[];
}

export interface PageRef {
  url: string;
  width?: number;
  height?: number;
}

export interface TagInfo {
  id: string;
  name: string;
  group?: string;
}

export interface SearchResponse {
  items: SeriesCard[];
  errors: { provider: string; message: string }[];
  perProvider: Record<string, number>;
}

/** URLs de imagem voltam relativas ('/api/img?...'); no desktop precisam apontar para o sidecar. */
function absolutize<T>(value: T): T {
  if (typeof value === 'string') return (value.startsWith('/api/') ? api(value) : value) as T;
  if (Array.isArray(value)) return value.map(absolutize) as T;
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) (value as Record<string, unknown>)[k] = absolutize(v);
  }
  return value;
}

async function json<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(api(url), init);
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`${res.status} ${body.slice(0, 200)}`);
  }
  return absolutize((await res.json()) as T);
}

export const getProviders = (): Promise<ProviderInfo[]> => json('/api/providers');
export const getTags = (provider: string): Promise<TagInfo[]> =>
  json(`/api/tags?provider=${encodeURIComponent(provider)}`);

export const search = (params: URLSearchParams): Promise<SearchResponse> => json(`/api/search?${params}`);

export const getSeries = (provider: string, id: string): Promise<SeriesDetail> =>
  json(`/api/series?provider=${encodeURIComponent(provider)}&id=${encodeURIComponent(id)}`);

export const getPages = (provider: string, chapter: string): Promise<{ pages: PageRef[] }> =>
  json(`/api/pages?provider=${encodeURIComponent(provider)}&chapter=${encodeURIComponent(chapter)}`);

export const aiHealth = (): Promise<{
  ok: boolean;
  model: string;
  configuredModel?: string;
  visionModel: string;
  baseUrl: string;
  models?: string[];
  error?: string;
}> => json('/api/ai/health');

export interface TranslateEngineInfo {
  id: 'auto' | 'llm' | 'google' | 'mymemory';
  name: string;
  needsAi: boolean;
  note: string;
}

export interface TargetLangInfo {
  id: string;
  name: string;
}

export const getEngines = (): Promise<TranslateEngineInfo[]> => json('/api/translate/engines');

export const getTargets = (): Promise<TargetLangInfo[]> => json('/api/translate/targets');

export const translate = (body: {
  blocks: { id: number; text: string }[];
  sourceLang?: string;
  series?: string;
  chapter?: string;
  engine?: string;
  target?: string;
}): Promise<{ translations: { id: number; pt: string }[]; engine?: string }> =>
  json('/api/ai/translate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

export const visionTranslate = (body: {
  imageDataUrl: string;
  series?: string;
  chapter?: string;
}): Promise<{ balloons: { original: string; pt: string }[] }> =>
  json('/api/ai/vision', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

/** Resposta do explain vem em streaming de texto puro. */
export async function* explain(body: {
  series?: string;
  description?: string;
  chapter?: string;
  pageText?: string[];
  question?: string;
  history?: { role: 'user' | 'assistant'; content: string }[];
}): AsyncGenerator<string> {
  const res = await fetch(api('/api/ai/explain'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok || !res.body) throw new Error(`${res.status} ${await res.text().catch(() => '')}`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return;
    yield decoder.decode(value, { stream: true });
  }
}
