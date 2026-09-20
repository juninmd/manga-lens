import { api } from './base.ts';

/** categoria de conteudo do catalogo — separa mangá, HQ e livro em abas proprias */
export type ContentType = 'manga' | 'hq' | 'livro';

export interface ProviderInfo {
  id: string;
  name: string;
  kind: 'online' | 'local';
  contentType: ContentType;
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
  contentType?: ContentType;
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
  /** capitulo de texto (EPUB): abre no leitor de livro, sem OCR */
  text?: boolean;
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

/** Erro HTTP com o status separado da mensagem — a UI decide o texto pelo status. */
export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/**
 * O servidor responde `{ error: "..." }`; mostrar o JSON cru com o status na
 * frente ("502 {\"error\":...}") no toast so' confunde. Extrai a mensagem e
 * guarda o status a parte. Rede fora (`TypeError: Failed to fetch`) vira uma
 * frase em portugues em vez do texto interno do navegador.
 */
function errorMessage(status: number, body: string): string {
  const text = body.trim();
  if (text.startsWith('{')) {
    try {
      const parsed = JSON.parse(text) as { error?: unknown; message?: unknown };
      const msg = parsed.error ?? parsed.message;
      if (typeof msg === 'string' && msg) return msg;
    } catch {
      /* nao era JSON: cai no texto */
    }
  }
  if (text && !text.startsWith('<')) return text.slice(0, 200);
  if (status === 404) return 'nao encontrado';
  if (status >= 500) return 'servidor falhou';
  return `erro ${status}`;
}

const isNetworkError = (err: unknown): boolean =>
  err instanceof TypeError && /fetch|network|load failed/i.test(err.message);

/** Texto curto e legivel para qualquer erro vindo da API (ou da rede). */
export function humanizeError(err: unknown): string {
  if (isNetworkError(err)) return 'servidor indisponivel';
  if (err instanceof Error) return err.message;
  return String(err);
}

export const errorStatus = (err: unknown): number | undefined =>
  err instanceof ApiError ? err.status : undefined;

async function json<T>(url: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(api(url), init);
  } catch (err) {
    if (isNetworkError(err)) throw new ApiError('servidor indisponivel', 0);
    throw err;
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new ApiError(errorMessage(res.status, body), res.status);
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

export type AiProviderName = 'openrouter' | 'ollama' | 'openaicompatible';

export interface AiProviderInfo {
  id: AiProviderName;
  name: string;
  baseUrl: string;
  model: string;
  visionModel?: string;
  hasKey: boolean;
  apiKey: string;
}

export const aiHealth = (provider?: string): Promise<{
  ok: boolean;
  provider?: string;
  model: string;
  configuredModel?: string;
  visionModel: string;
  baseUrl: string;
  models?: string[];
  error?: string;
}> => json(provider ? `/api/ai/health?provider=${encodeURIComponent(provider)}` : '/api/ai/health');

export const getAiProviders = (): Promise<{
  active: AiProviderName;
  providers: AiProviderInfo[];
}> => json('/api/ai/providers');

export const getAiModels = (provider?: string): Promise<{
  ok: boolean;
  provider: string;
  models: string[];
  error?: string;
}> => json(provider ? `/api/ai/models?provider=${encodeURIComponent(provider)}` : '/api/ai/models');

export const saveAiConfig = (data: {
  active?: AiProviderName;
  provider?: AiProviderName;
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  visionModel?: string;
}): Promise<{
  active: AiProviderName;
  providers: AiProviderInfo[];
}> =>
  json<{ active: AiProviderName; providers: AiProviderInfo[] }>('/api/ai/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  }).then((res) => {
    // badge global e leitor reconsultam a saude sem depender de quem salvou
    window.dispatchEvent(new CustomEvent('ml:ai-changed'));
    return res;
  });

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
  blocks: { id: number; text: string; x?: number; y?: number; w?: number; h?: number }[];
  sourceLang?: string;
  series?: string;
  chapter?: string;
  page?: number;
  rtl?: boolean;
  pageImage?: string;
  engine?: string;
  target?: string;
  provider?: string;
}): Promise<{ translations: { id: number; pt: string; orig?: string }[]; engine?: string }> =>
  json('/api/ai/translate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

export interface SeriesMemory {
  glossary: { orig: string; pt: string; gender: 'm' | 'f' | '?' }[];
  notes: { chapter: string; page: number; note: string }[];
}

export const seriesMemory = (series: string, target: string): Promise<SeriesMemory> =>
  json(`/api/ai/memory?series=${encodeURIComponent(series)}&target=${encodeURIComponent(target)}`);

export const clearSeriesMemory = (series: string, target: string): Promise<{ ok: boolean }> =>
  json('/api/ai/memory/clear', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ series, target }),
  });

export const visionTranslate = (body: {
  imageDataUrl: string;
  series?: string;
  chapter?: string;
  provider?: string;
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
  provider?: string;
}, signal?: AbortSignal): AsyncGenerator<string> {
  const res = await fetch(api('/api/ai/explain'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
  // mesmo tratamento do json(): a bolha mostrava `500 {"error":...}` cru
  if (!res.ok) throw new ApiError(errorMessage(res.status, await res.text().catch(() => '')), res.status);
  if (!res.body) throw new ApiError('resposta vazia da IA', res.status);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return;
    yield decoder.decode(value, { stream: true });
  }
}

/** Paragrafos de um capitulo de livro (EPUB local). */
export const getBookChapter = (chapterId: string): Promise<{ blocks: { id: number; text: string }[] }> =>
  json(`/api/local/book?c=${encodeURIComponent(chapterId)}`);
