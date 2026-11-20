import { generateText, streamText, type LanguageModel, type ModelMessage } from 'ai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import { keyHint } from './ai-config-body.ts';
import { createHash } from 'node:crypto';
import { echoes, realign } from './align.ts';
import { readCached, writeCached } from './cache.ts';
import { config, getProviderConfig, normalizeProvider, type AiProvider } from './config.ts';
import { readingOrder, type PageBlock } from './page-text.ts';
import { contextFor, remember } from './series-memory.ts';
import {
  DEFAULT_STYLE,
  parseReply,
  proseSystemPrompt,
  proseUserPrompt,
  systemPrompt,
  userPrompt,
  visionSystemPrompt,
  visionUserPrompt,
  type TranslateStyle,
} from './translate-prompt.ts';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string | Array<{ type: string; text?: string; image_url?: { url: string } }>;
}

type ProviderInstance = ReturnType<typeof createOpenRouter> | ReturnType<typeof createOpenAICompatible>;

const providers = new Map<AiProvider, ProviderInstance>();
const effectiveModels = new Map<AiProvider, string>();

function getProviderInstance(providerName: AiProvider) {
  let inst = providers.get(providerName);
  if (inst) return inst;
  const pConfig = getProviderConfig(providerName);
  if (providerName === 'openrouter') {
    inst = createOpenRouter({
      baseURL: pConfig.baseUrl,
      apiKey: pConfig.apiKey,
    });
  } else {
    inst = createOpenAICompatible({
      name: providerName,
      baseURL: pConfig.baseUrl,
      apiKey: pConfig.apiKey || 'ollama',
    });
  }
  providers.set(providerName, inst);
  return inst;
}

/**
 * So' no Ollama (outro servidor OpenAI-compativel pode recusar os campos): modelo pensante
 * (qwen3.x, deepseek-r1) gastava o limite raciocinando e devolvia vazio; `json` liga a
 * gramatica de JSON, porque o 7B quebrava aspas e escapes em ~5% das paginas.
 */
const ollamaOptions = (p: AiProvider, json = false) =>
  p === 'ollama'
    ? { providerOptions: { ollama: { reasoningEffort: 'none', ...(json ? { response_format: { type: 'json_object' } } : {}) } } }
    : {};

export function getLanguageModel(providerName: AiProvider, modelId: string): LanguageModel {
  const p = getProviderInstance(providerName);
  return p(modelId);
}

export async function listModels(providerName: AiProvider = config.ai.provider): Promise<string[]> {
  const pConfig = getProviderConfig(providerName);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 6000);
  try {
    const headers: Record<string, string> = {};
    if (pConfig.apiKey) headers['Authorization'] = `Bearer ${pConfig.apiKey}`;

    const base = pConfig.baseUrl.replace(/\/+$/, '');
    // 1. Tenta endpoint OpenAI /models
    let res = await fetch(`${base}/models`, {
      signal: ctrl.signal,
      headers,
    }).catch(() => null);

    // 2. Se falhar ou der 404, e for Ollama/porta 11434, tenta /api/tags nativo
    if (!res?.ok) {
      const rootUrl = base.replace(/\/v1\/?$/, '');
      res = await fetch(`${rootUrl}/api/tags`, {
        signal: ctrl.signal,
        headers,
      }).catch(() => null);
    }

    if (!res?.ok) return [];

    const text = await res.text().catch(() => '');
    if (!text || text.trim().startsWith('<')) return [];

    try {
      const parsed = JSON.parse(text) as {
        data?: { id?: string }[];
        models?: { name?: string; model?: string }[];
      };
      if (Array.isArray(parsed.data)) {
        return parsed.data.map((m) => m.id ?? '').filter(Boolean);
      }
      if (Array.isArray(parsed.models)) {
        return parsed.models.map((m) => m.name || m.model || '').filter(Boolean);
      }
    } catch {
      return [];
    }
    return [];
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Modelo apontando para modelo que o endpoint nao serve devolve 404.
 * Se o configurado nao estiver na lista, usa o primeiro disponivel.
 */
export async function resolveModel(providerName: AiProvider = config.ai.provider): Promise<string> {
  const cached = effectiveModels.get(providerName);
  if (cached) return cached;
  const pConfig = getProviderConfig(providerName);
  const models = await listModels(providerName);
  if (!models.length || models.includes(pConfig.model)) {
    effectiveModels.set(providerName, pConfig.model);
    return pConfig.model;
  }
  const effective = models[0]!;
  console.error(
    `[llm/${providerName}] AI_MODEL="${pConfig.model}" nao esta' em ${pConfig.baseUrl}/models; ` +
      `usando "${effective}" (disponiveis: ${models.join(', ')})`,
  );
  effectiveModels.set(providerName, effective);
  return effective;
}

function parseJsonArray<T>(raw: string): T[] {
  const cleaned = raw.replace(/```(?:json)?/gi, '').trim();
  const start = cleaned.indexOf('[');
  const end = cleaned.lastIndexOf(']');
  if (start < 0 || end <= start) throw new Error(`resposta do LLM sem JSON: ${cleaned.slice(0, 200)}`);
  return JSON.parse(cleaned.slice(start, end + 1)) as T[];
}

const LANG_NAME: Record<string, string> = {
  ja: 'japones',
  ko: 'coreano',
  zh: 'chines',
  en: 'ingles',
  es: 'espanhol',
  unknown: 'idioma original',
};

/** Nome do idioma de chegada para o prompt — codigo cru o modelo entende mal. */
const TARGET_NAME: Record<string, string> = {
  'pt-br': 'portugues do Brasil',
  en: 'ingles',
  es: 'espanhol',
  fr: 'frances',
  de: 'alemao',
  it: 'italiano',
  ja: 'japones',
  ko: 'coreano',
  'zh-cn': 'chines simplificado',
  ru: 'russo',
};

export interface TranslateInput {
  blocks: PageBlock[];
  sourceLang?: string;
  series?: string;
  chapter?: string;
  /** pagina (base 0) dentro do capitulo: posiciona a nota na memoria da obra */
  page?: number;
  /** manga le da direita para a esquerda; decide a ordem dos baloes na mesma altura */
  rtl?: boolean;
  /** pagina reduzida com o id desenhado em cada balao; so' vai ao modelo de visao */
  pageImage?: string;
  /** idioma de chegada (pt-BR, en, es...); ausente = portugues do Brasil */
  target?: string;
  provider?: AiProvider | string;
  /** honorificos, tom e onomatopeia: preferencias de quem le, ja' validadas (`parseStyle`) */
  style?: TranslateStyle;
  /** `prose` = paragrafos de livro: prompt literario, sem ordem de leitura nem imagem */
  mode?: 'prose';
  /** livro: paragrafos imediatamente anteriores ao lote, so' contexto */
  context?: string[];
}

/** Uma pagina cabe num lote so': quebrar em 12 escondia do LLM metade da conversa. */
const PAGE_BATCH = 24;
export const PAGE_IMAGE_RE = /^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/;
export const MAX_PAGE_IMAGE = 2_000_000;

/**
 * Erro de rede, de autenticacao ou de limite: repetir o lote menor so' gasta mais
 * um timeout inteiro. Recuperacao balao a balao e' para resposta torta do modelo.
 */
export const isTransientAiError = (message: string): boolean =>
  /fetch failed|ECONNREFUSED|ECONNRESET|ENOTFOUND|Unable to connect|timed? ?out|aborted|\b(401|403|404|429|5\d\d)\b/i.test(message);

/** Quantas vezes o que o modelo pulou e' repartido ao meio e pedido de novo (1 + 2 + 4 chamadas no pior caso). */
export const RECOVERY_DEPTH = 2;

/** Traduz balões em lote preservando o id — sem id, nao da' pra ancorar de volta na pagina. */
export async function translateBlocks(input: TranslateInput): Promise<{ id: number; pt: string }[]> {
  const target = input.target ?? 'pt-br';
  const providerName = normalizeProvider(input.provider, config.ai.provider);
  const visionModel = getProviderConfig(providerName).visionModel;
  const prose = input.mode === 'prose';
  const image =
    !prose && visionModel && input.pageImage && input.pageImage.length <= MAX_PAGE_IMAGE && PAGE_IMAGE_RE.test(input.pageImage)
      ? input.pageImage
      : undefined;
  const modelId = image ? visionModel! : await resolveModel(providerName);
  const series = input.series?.trim();
  const locked = series ? (await contextFor(series, target, input.chapter ?? '', 0)).glossary.filter((g) => g.locked) : [];
  const key = translationKey({ input, providerName, modelId, image, locked });
  const hit = await readCached<unknown>(key, TRANSLATION_TTL_MS);
  // arquivo de cache e' JSON valido mas pode vir de outra versao ou ter sido editado: so' serve no formato certo
  if (isTranslationList(hit)) return hit;
  const { out, complete } = await translateUncached(input, providerName, modelId, image);
  // so' guarda pagina inteira: balao que falhou tem de voltar ao modelo no proximo R
  if (complete) await writeCached(key, out);
  return out;
}

const isTranslationList = (v: unknown): v is { id: number; pt: string }[] =>
  Array.isArray(v) && v.every((t: { id?: unknown; pt?: unknown } | null) => Number.isInteger(t?.id) && typeof t?.pt === 'string');

/** Traducao reaberta (outro dia, outra sessao) nao paga o LLM de novo. */
export const TRANSLATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Chave do cache de traducao: tudo que muda a saida do modelo. O prompt de
 * sistema entra inteiro (hash), entao mudar regra de prompt, modelo, estilo,
 * idioma ou um termo fixado no glossario invalida sozinho — a mesma ideia da
 * "revisao do pipeline" do FrankYomik.
 */
function translationKey(p: {
  input: TranslateInput;
  providerName: AiProvider;
  modelId: string;
  image?: string;
  locked: { orig: string; pt: string; gender: string }[];
}): string {
  const { input } = p;
  const target = input.target ?? 'pt-br';
  const dst = TARGET_NAME[target.toLowerCase()] ?? 'portugues do Brasil';
  const style = input.style ?? DEFAULT_STYLE;
  const system = input.mode === 'prose' ? proseSystemPrompt(dst, target, style) : systemPrompt(dst, target, style);
  const sha = (s: string): string => createHash('sha256').update(s).digest('hex');
  return `translation:${sha(
    JSON.stringify({
      rev: PIPELINE_REV,
      system: sha(system),
      provider: p.providerName,
      model: p.modelId,
      target,
      src: input.sourceLang ?? '',
      mode: input.mode ?? '',
      rtl: input.rtl ?? true,
      series: input.series?.trim().toLowerCase() ?? '',
      chapter: input.chapter ?? '',
      page: input.page ?? -1,
      blocks: input.blocks.map((b) => [b.id, b.text, b.kind ?? '', b.x ?? 0, b.y ?? 0, b.w ?? 0, b.h ?? 0]),
      context: input.context ?? [],
      image: p.image ? sha(p.image) : '',
      locked: p.locked.map((g) => [g.orig, g.pt, g.gender]),
    }),
  )}`;
}

/** Sobe quando o formato do prompt de usuario ou o pos-processamento mudam de um jeito que o hash do prompt de sistema nao ve. */
export const PIPELINE_REV = 1;

async function translateUncached(
  input: TranslateInput,
  providerName: AiProvider,
  modelId: string,
  image: string | undefined,
): Promise<{ out: { id: number; pt: string }[]; complete: boolean }> {
  const target = input.target ?? 'pt-br';
  const src = LANG_NAME[input.sourceLang ?? 'unknown'] ?? input.sourceLang ?? 'idioma original';
  const dst = TARGET_NAME[target.toLowerCase()] ?? 'portugues do Brasil';
  const prose = input.mode === 'prose';
  const style = input.style ?? DEFAULT_STYLE;
  const model = getLanguageModel(providerName, modelId);
  const series = input.series?.trim();
  const chapter = input.chapter ?? '';
  const memory = series ? await contextFor(series, target, chapter, input.page ?? 0) : { glossary: [], notes: [] };
  const blocks = prose ? input.blocks : readingOrder(input.blocks, input.rtl ?? true);

  const done = new Map<number, string>();
  let calls = 0;
  let answered = 0;
  let lastError = '';

  /** Uma chamada ao modelo para `batch`; devolve so' o que voltou ancorado. Lanca se a resposta nao serve. */
  const attempt = async (batch: PageBlock[], previous: string[] | undefined, strict = false): Promise<{ id: number; pt: string }[]> => {
    const neighbours = blocks.length > batch.length ? blocks.filter((b) => !batch.includes(b)) : [];
    const ctx = { series, chapter: input.chapter, page: input.page, sourceName: src, ...memory, neighbours, withImage: Boolean(image) };
    const prompt = prose ? proseUserPrompt({ ...ctx, previous }, batch) : userPrompt(ctx, batch);
    // paragrafo e' longo: o orcamento por balao (160 tokens) cortava a resposta no meio do lote
    const budget = prose ? Math.ceil(batch.reduce((n, b) => n + b.text.length, 0) / 2) + 900 : batch.length * 160 + 900;
    calls++;
    let raw = '';
    try {
      const result = await generateText({
        model,
        system: prose ? proseSystemPrompt(dst, target, style) : systemPrompt(dst, target, style),
        ...(image
          ? {
              messages: [
                {
                  role: 'user' as const,
                  content: [
                    { type: 'text' as const, text: prompt },
                    { type: 'file' as const, data: image, mediaType: image.slice(5, image.indexOf(';')) },
                  ],
                },
              ],
            }
          : { prompt }),
        temperature: 0.2,
        maxOutputTokens: Math.max(config.ai.maxTokens, budget),
        ...ollamaOptions(providerName, true),
        maxRetries: 0,
        abortSignal: AbortSignal.timeout(config.ai.timeoutMs),
      });
      raw = result.text;
      const reply = parseReply(raw);
      answered++;
      if (reply.partial) {
        console.error(
          `[traducao/${providerName}] resposta cortada (${result.finishReason}): ${reply.translations.length} de ${batch.length} baloes aproveitados`,
        );
      }
      // repescagem com 1-2 baloes: nao ha' vizinho para onde realinhar, entao eco que aponta
      // para outra fala da pagina e' a resposta do lote anterior repetida — cai
      const own = new Map(batch.map((b) => [b.id, b.text]));
      const items = strict ? reply.translations.filter((t) => !t.src || echoes(t.src, own.get(t.id) ?? '')) : reply.translations;
      const aligned = realign(items, batch);
      if (series) {
        // termo que nao esta' no texto do lote nao foi aprendido aqui: o 7B inventava personagens
        const seen = batch.map((b) => b.text).join(' ').toLowerCase();
        const learned = Array.isArray(reply.glossary)
          ? (reply.glossary as { orig?: unknown }[]).filter((g) => typeof g?.orig === 'string' && seen.includes(g.orig.trim().toLowerCase()))
          : [];
        await remember(series, target, chapter, input.page ?? -1, {
          glossary: learned,
          note: input.page === undefined ? undefined : reply.note,
        });
      }
      return aligned;
    } catch (err) {
      lastError = (err as Error).message;
      console.error(`[traducao/${providerName}] lote de ${batch.length} falhou: ${lastError}`);
      if (raw) console.error(`[traducao/${providerName}] resposta crua: ${raw.slice(0, 300)}`);
      throw err;
    }
  };

  /**
   * O que o modelo pulou, devolveu fora do lugar ou estragou com JSON torto volta
   * em pedacos menores: lote de 24 que falha inteiro perdia a pagina toda, e o
   * balao isolado quase sempre sai. Profundidade fixa: nunca vira um loop de chamadas.
   */
  const recover = async (batch: PageBlock[], depth: number): Promise<void> => {
    if (!batch.length || depth > RECOVERY_DEPTH) return;
    let missing = batch;
    try {
      for (const t of await attempt(batch, undefined, true)) if (batch.some((b) => b.id === t.id)) done.set(t.id, t.pt);
      missing = batch.filter((b) => !done.has(b.id));
    } catch (err) {
      if (isTransientAiError((err as Error).message)) return;
    }
    if (!missing.length || missing.length === 1 && batch.length === 1) return;
    const half = Math.ceil(missing.length / 2);
    await recover(missing.slice(0, half), depth + 1);
    await recover(missing.slice(half), depth + 1);
  };

  for (let i = 0; i < blocks.length; i += PAGE_BATCH) {
    const batch = blocks.slice(i, i + PAGE_BATCH);
    // so' o primeiro lote continua do trecho que o cliente mandou; os seguintes continuam do lote anterior
    const previous = i === 0 ? input.context : blocks.slice(Math.max(0, i - 2), i).map((b) => b.text.slice(-400));
    let retry: PageBlock[] = [];
    try {
      for (const t of await attempt(batch, previous)) done.set(t.id, t.pt);
      retry = batch.filter((b) => !done.has(b.id));
    } catch (err) {
      // rede/limite: o proximo lote provavelmente cai igual, nao vale repartir
      if (!isTransientAiError((err as Error).message)) retry = batch;
    }
    if (retry.length) {
      const half = retry.length === 1 ? 1 : Math.ceil(retry.length / 2);
      await recover(retry.slice(0, half), 1);
      await recover(retry.slice(half), 1);
    }
  }

  if (calls > 0 && answered === 0) throw new Error(`IA indisponivel (${providerName}): ${lastError}`);
  // balao sem resposta fica de fora (o cliente trata como vazio e o R refaz so' ele)
  const out = blocks.filter((b) => done.has(b.id)).map((b) => ({ id: b.id, pt: done.get(b.id)! }));
  return { out, complete: blocks.every((b) => done.has(b.id)) };
}

/**
 * Motor de visao: o detector ja' deu a geometria dos baloes, mas o Tesseract
 * NAO rodou — quem le o texto e' o proprio modelo, na pagina numerada. Resolve
 * o que o OCR erra sempre (japones vertical, letra estilizada, SFX sobre arte)
 * sem perder o letreiramento, que so' depende das caixas.
 */
export async function visionBlocks(input: TranslateInput): Promise<{ id: number; pt: string; orig?: string }[]> {
  const target = input.target ?? 'pt-br';
  const src = LANG_NAME[input.sourceLang ?? 'unknown'] ?? input.sourceLang ?? 'idioma original';
  const dst = TARGET_NAME[target.toLowerCase()] ?? 'portugues do Brasil';
  const providerName = normalizeProvider(input.provider, config.ai.provider);
  const visionModel = getProviderConfig(providerName).visionModel;
  if (!visionModel) throw new Error(`modelo de visao nao configurado para ${providerName} — defina em IA > Modelo de visao`);
  const image = input.pageImage;
  if (!image || image.length > MAX_PAGE_IMAGE || !PAGE_IMAGE_RE.test(image)) {
    throw new Error('o motor de visao precisa da imagem da pagina; recarregue a pagina e tente de novo');
  }
  const model = getLanguageModel(providerName, visionModel);
  const series = input.series?.trim();
  const chapter = input.chapter ?? '';
  const memory = series ? await contextFor(series, target, chapter, input.page ?? 0) : { glossary: [], notes: [] };
  const blocks = readingOrder(input.blocks, input.rtl ?? true);

  const prompt = visionUserPrompt(
    { series, chapter: input.chapter, page: input.page, sourceName: src, ...memory, neighbours: [], withImage: true },
    blocks.map((b) => b.id),
  );
  const result = await generateText({
    model,
    system: visionSystemPrompt(dst, target, input.style ?? DEFAULT_STYLE),
    messages: [
      {
        role: 'user' as const,
        content: [
          { type: 'text' as const, text: prompt },
          { type: 'file' as const, data: image, mediaType: image.slice(5, image.indexOf(';')) },
        ],
      },
    ],
    temperature: 0.2,
    maxOutputTokens: Math.max(config.ai.maxTokens, blocks.length * 200 + 900),
    ...ollamaOptions(providerName, true),
    maxRetries: 0,
    abortSignal: AbortSignal.timeout(config.ai.timeoutMs),
  });
  const reply = parseReply(result.text);
  if (reply.partial) {
    console.error(`[visao/${providerName}] resposta cortada (${result.finishReason}): ${reply.translations.length} de ${blocks.length} baloes aproveitados`);
  }
  // sem texto de OCR nao ha' como reancorar: o id marcado na imagem e' a unica chave
  const known = new Set(blocks.map((b) => b.id));
  const out = reply.translations
    .filter((t) => known.has(t.id))
    .map((t) => ({ id: t.id, pt: t.pt, ...(t.orig ? { orig: t.orig } : {}) }));
  if (series) {
    // o modelo le a pagina inteira: o termo aprendido tem de aparecer no que ele diz ter lido
    const seen = out.map((t) => `${t.orig ?? ''} ${t.pt}`).join(' ').toLowerCase();
    const learned = Array.isArray(reply.glossary)
      ? (reply.glossary as { orig?: unknown; pt?: unknown }[]).filter(
          (g) => typeof g?.orig === 'string' && (seen.includes(g.orig.trim().toLowerCase()) || (typeof g.pt === 'string' && seen.includes(g.pt.trim().toLowerCase()))),
        )
      : [];
    await remember(series, target, chapter, input.page ?? -1, {
      glossary: learned,
      note: input.page === undefined ? undefined : reply.note,
    });
  }
  return out;
}

export interface VisionInput {
  imageDataUrl: string;
  series?: string;
  chapter?: string;
  provider?: AiProvider | string;
}

/** Caminho alternativo ao OCR: modelo com visao le a pagina direto (texto vertical/estilizado). */
export async function visionTranslate(input: VisionInput): Promise<{ original: string; pt: string }[]> {
  const providerName = normalizeProvider(input.provider, config.ai.provider);
  const pConfig = getProviderConfig(providerName);
  if (!pConfig.visionModel) throw new Error(`modelo de visao nao configurado para ${providerName} — defina em IA > Modelo de visao`);
  const model = getLanguageModel(providerName, pConfig.visionModel);

  const mime = input.imageDataUrl.match(/^data:([^;]+);/)?.[1] ?? 'image/jpeg';
  const result = await generateText({
    model,
    system:
      'Voce le paginas de manga/HQ. Liste os baloes na ordem de leitura da obra e traduza para portugues do Brasil. ' +
      'Responda SOMENTE um array JSON [{"original":string,"pt":string}].',
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: `Obra: ${input.series ?? 'desconhecida'}${input.chapter ? ` — capitulo ${input.chapter}` : ''}`,
          },
          {
            type: 'file',
            data: input.imageDataUrl,
            mediaType: mime,
          },
        ],
      },
    ],
    maxOutputTokens: config.ai.maxTokens,
    ...ollamaOptions(providerName),
    maxRetries: 0,
    abortSignal: AbortSignal.timeout(config.ai.timeoutMs),
  });
  return parseJsonArray<{ original: string; pt: string }>(result.text);
}

export interface ExplainInput {
  series?: string;
  description?: string;
  chapter?: string;
  pageText?: string[];
  question?: string;
  history?: { role: 'user' | 'assistant'; content: string }[];
  provider?: AiProvider | string;
}

export async function explainStream(input: ExplainInput): Promise<ReadableStream<Uint8Array>> {
  const providerName = normalizeProvider(input.provider, config.ai.provider);
  const modelId = await resolveModel(providerName);
  const model = getLanguageModel(providerName, modelId);

  const context = [
    input.series ? `Obra: ${input.series}` : '',
    input.chapter ? `Capitulo: ${input.chapter}` : '',
    input.description ? `Sinopse: ${input.description.slice(0, 1200)}` : '',
    input.pageText?.length ? `Texto lido na pagina atual:\n${input.pageText.join('\n')}` : '',
  ]
    .filter(Boolean)
    .join('\n');

  const messages: ModelMessage[] = [
    ...(input.history ?? []).map((h) => ({
      role: h.role,
      content: h.content,
    })),
    {
      role: 'user',
      content: `${context}\n\nPergunta: ${input.question ?? 'Explique o que esta acontecendo nesta pagina.'}`,
    },
  ];

  const result = streamText({
    model,
    system:
      'Voce e um leitor experiente de manga/HQ ajudando em portugues do Brasil. Explique contexto, ' +
      'personagens, referencias culturais e o que acontece na cena. Seja direto. ' +
      'NUNCA entregue spoiler alem do ponto informado: se precisar, avise antes. ' +
      'Se o contexto nao bastar, diga o que falta em vez de inventar.',
    messages,
    temperature: 0.4,
    maxOutputTokens: config.ai.maxTokens,
    ...ollamaOptions(providerName),
    maxRetries: 0,
    abortSignal: AbortSignal.timeout(config.ai.timeoutMs),
  });

  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for await (const chunk of result.textStream) {
          controller.enqueue(encoder.encode(chunk));
        }
        controller.close();
      } catch (err) {
        controller.error(err);
      }
    },
  });
}

export async function aiHealth(providerName: AiProvider = config.ai.provider): Promise<{
  ok: boolean;
  provider: AiProvider;
  baseUrl: string;
  model: string;
  configuredModel: string;
  visionModel: string;
  models?: string[];
  error?: string;
}> {
  const pConfig = getProviderConfig(providerName);
  const base = {
    provider: providerName,
    baseUrl: pConfig.baseUrl,
    model: pConfig.model,
    configuredModel: pConfig.model,
    visionModel: pConfig.visionModel ?? '',
  };
  const models = await listModels(providerName);
  if (!models.length) {
    return { ...base, ok: false, error: `sem resposta de ${pConfig.baseUrl}/models` };
  }
  return { ...base, ok: true, model: await resolveModel(providerName), models };
}

export function invalidateProvider(providerName?: AiProvider): void {
  if (providerName) {
    providers.delete(providerName);
    effectiveModels.delete(providerName);
  } else {
    providers.clear();
    effectiveModels.clear();
  }
}

export function getAvailableProviders(): {
  active: AiProvider;
  providers: {
    id: AiProvider;
    name: string;
    baseUrl: string;
    model: string;
    visionModel?: string;
    hasKey: boolean;
    /** no maximo os 4 ultimos caracteres; a chave em si nunca sai do servidor */
    keyHint: string;
  }[];
} {
  const ollama = getProviderConfig('ollama');
  const openrouter = getProviderConfig('openrouter');
  const openai = getProviderConfig('openaicompatible');
  return {
    active: config.ai.provider,
    providers: [
      {
        id: 'ollama',
        name: 'Ollama',
        baseUrl: ollama.baseUrl,
        model: ollama.model,
        visionModel: ollama.visionModel ?? '',
        hasKey: Boolean(ollama.apiKey && ollama.apiKey !== 'ollama'),
        keyHint: keyHint(ollama.apiKey),
      },
      {
        id: 'openrouter',
        name: 'OpenRouter',
        baseUrl: openrouter.baseUrl,
        model: openrouter.model,
        visionModel: openrouter.visionModel ?? '',
        hasKey: Boolean(openrouter.apiKey),
        keyHint: keyHint(openrouter.apiKey),
      },
      {
        id: 'openaicompatible',
        name: 'OpenAI Compatible',
        baseUrl: openai.baseUrl,
        model: openai.model,
        visionModel: openai.visionModel ?? '',
        hasKey: Boolean(openai.apiKey && openai.apiKey !== 'ollama'),
        keyHint: keyHint(openai.apiKey),
      },
    ],
  };
}
