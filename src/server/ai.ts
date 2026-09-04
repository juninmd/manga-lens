import { generateText, streamText, type LanguageModel, type ModelMessage } from 'ai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import { config, getProviderConfig, normalizeProvider, type AiProvider } from './config.ts';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string | Array<{ type: string; text?: string; image_url?: { url: string } }>;
}

const providers = new Map<AiProvider, any>();
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
    if (!res || !res.ok) {
      const rootUrl = base.replace(/\/v1\/?$/, '');
      res = await fetch(`${rootUrl}/api/tags`, {
        signal: ctrl.signal,
        headers,
      }).catch(() => null);
    }

    if (!res || !res.ok) return [];

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
  blocks: { id: number; text: string }[];
  sourceLang?: string;
  series?: string;
  chapter?: string;
  /** idioma de chegada (pt-BR, en, es...); ausente = portugues do Brasil */
  target?: string;
  provider?: AiProvider | string;
}

/** Traduz balões em lote preservando o id — sem id, nao da' pra ancorar de volta na pagina. */
export async function translateBlocks(input: TranslateInput): Promise<{ id: number; pt: string }[]> {
  const out: { id: number; pt: string }[] = [];
  const BATCH = 12;
  const src = LANG_NAME[input.sourceLang ?? 'unknown'] ?? input.sourceLang;
  const dst = TARGET_NAME[(input.target ?? 'pt-br').toLowerCase()] ?? 'portugues do Brasil';
  const providerName = normalizeProvider(input.provider, config.ai.provider);
  const modelId = await resolveModel(providerName);
  const model = getLanguageModel(providerName, modelId);

  let batches = 0;
  let failed = 0;
  let lastError = '';

  for (let i = 0; i < input.blocks.length; i += BATCH) {
    const batch = input.blocks.slice(i, i + BATCH);
    batches++;
    let raw = '';
    try {
      const result = await generateText({
        model,
        system:
          `Voce traduz baloes de manga/HQ para ${dst}. O texto vem de OCR e pode ter ruido, ` +
          'letras trocadas ou quebras estranhas: corrija o obvio antes de traduzir. Mantenha registro, ' +
          `girias e onomatopeias naturais em ${dst}. Se um bloco for so ruido, devolva string vazia. ` +
          'O texto vai ser letreirado dentro do balao original: prefira a formulacao mais curta que ' +
          'preserve o sentido, sem inventar conteudo. ' +
          'Responda SOMENTE um array JSON [{"id":number,"pt":string}], sem comentarios.',
        prompt:
          `Obra: ${input.series ?? 'desconhecida'}${input.chapter ? ` — capitulo ${input.chapter}` : ''}\n` +
          `Idioma de origem: ${src}\n\nBlocos:\n${JSON.stringify(batch, null, 0)}`,
        temperature: 0.2,
        maxOutputTokens: Math.max(config.ai.maxTokens, batch.length * 160 + 600),
        maxRetries: 0,
        abortSignal: AbortSignal.timeout(config.ai.timeoutMs),
      });
      raw = result.text;
      out.push(...parseJsonArray<{ id: number; pt: string }>(raw));
    } catch (err) {
      failed++;
      lastError = (err as Error).message;
      console.error(`[traducao/${providerName}] lote ${i / BATCH} falhou: ${lastError}`);
      if (raw) console.error(`[traducao/${providerName}] resposta crua: ${raw.slice(0, 300)}`);
      out.push(...batch.map((b) => ({ id: b.id, pt: '' })));
    }
  }

  if (batches > 0 && failed === batches) throw new Error(`IA indisponivel (${providerName}): ${lastError}`);
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
    apiKey: string;
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
        apiKey: ollama.apiKey ?? '',
      },
      {
        id: 'openrouter',
        name: 'OpenRouter',
        baseUrl: openrouter.baseUrl,
        model: openrouter.model,
        visionModel: openrouter.visionModel ?? '',
        hasKey: Boolean(openrouter.apiKey),
        apiKey: openrouter.apiKey ?? '',
      },
      {
        id: 'openaicompatible',
        name: 'OpenAI Compatible',
        baseUrl: openai.baseUrl,
        model: openai.model,
        visionModel: openai.visionModel ?? '',
        hasKey: Boolean(openai.apiKey && openai.apiKey !== 'ollama'),
        apiKey: openai.apiKey ?? '',
      },
    ],
  };
}
