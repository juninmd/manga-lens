import { config } from './config.ts';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string | Array<{ type: string; text?: string; image_url?: { url: string } }>;
}

interface ChatOpts {
  model?: string;
  temperature?: number;
  maxTokens?: number;
}

let effectiveModel: string | null = null;

async function listModels(): Promise<string[]> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 6000);
  try {
    const res = await fetch(`${config.ai.baseUrl}/models`, {
      signal: ctrl.signal,
      headers: { Authorization: `Bearer ${config.ai.apiKey}` },
    });
    if (!res.ok) return [];
    const data = (await res.json()) as { data?: { id: string }[] };
    return (data.data ?? []).map((m) => m.id);
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

/**
 * `AI_MODEL` apontando para modelo que o endpoint nao serve devolve 404 e o app
 * inteiro parece quebrado. Se o configurado nao estiver na lista, usa o primeiro
 * que o gateway oferece — e diz qual, para nao trocar de modelo em silencio.
 */
export async function resolveModel(): Promise<string> {
  if (effectiveModel) return effectiveModel;
  const models = await listModels();
  if (!models.length || models.includes(config.ai.model)) {
    effectiveModel = config.ai.model;
    return effectiveModel;
  }
  effectiveModel = models[0]!;
  console.error(
    `[llm] AI_MODEL="${config.ai.model}" nao esta' em ${config.ai.baseUrl}/models; ` +
      `usando "${effectiveModel}" (disponiveis: ${models.join(', ')})`,
  );
  return effectiveModel;
}

async function chat(messages: ChatMessage[], opts: ChatOpts = {}): Promise<string> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), config.ai.timeoutMs);
  try {
    const res = await fetch(`${config.ai.baseUrl}/chat/completions`, {
      method: 'POST',
      signal: ctrl.signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.ai.apiKey}`,
      },
      body: JSON.stringify({
        model: opts.model ?? (await resolveModel()),
        messages,
        temperature: opts.temperature ?? 0.2,
        // Modelo de raciocinio gasta orcamento pensando: apertar isso devolve content vazio.
        max_tokens: opts.maxTokens ?? config.ai.maxTokens,
        stream: false,
      }),
    });
    if (!res.ok) throw new Error(`LLM ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const data = (await res.json()) as {
      choices?: { message?: { content?: string; reasoning?: string }; finish_reason?: string }[];
      usage?: { completion_tokens?: number };
    };
    const choice = data.choices?.[0];
    // Modelo de raciocinio local (qwen128k e afins) as vezes entrega tudo em
    // `reasoning` e deixa `content` vazio — o texto util esta' la'.
    const content = choice?.message?.content?.trim() ? choice.message.content : (choice?.message?.reasoning ?? '');
    if (!content.trim()) {
      // Modelo de raciocinio gasta o orcamento pensando e devolve content vazio:
      // sem esse log o sintoma vira "a IA nao traduziu" sem causa aparente.
      console.error(
        `[llm] content vazio — finish_reason=${choice?.finish_reason} ` +
          `completion_tokens=${data.usage?.completion_tokens} max_tokens=${opts.maxTokens ?? config.ai.maxTokens}` +
          (choice?.message?.reasoning ? ' (o modelo devolveu raciocinio em vez de resposta)' : ''),
      );
    }
    return content;
  } finally {
    clearTimeout(timer);
  }
}

/** Stream SSE cru do upstream repassado como texto puro para o cliente. */
export async function chatStream(messages: ChatMessage[], opts: ChatOpts = {}): Promise<ReadableStream<Uint8Array>> {
  const res = await fetch(`${config.ai.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.ai.apiKey}` },
    body: JSON.stringify({
      model: opts.model ?? (await resolveModel()),
      messages,
      temperature: opts.temperature ?? 0.4,
      max_tokens: opts.maxTokens ?? config.ai.maxTokens,
      stream: true,
    }),
  });
  if (!res.ok || !res.body) throw new Error(`LLM ${res.status}: ${(await res.text()).slice(0, 300)}`);

  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = '';

  return res.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        buffer += decoder.decode(chunk, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          const t = line.trim();
          if (!t.startsWith('data:')) continue;
          const payload = t.slice(5).trim();
          if (payload === '[DONE]') return;
          try {
            const j = JSON.parse(payload) as { choices?: { delta?: { content?: string } }[] };
            const piece = j.choices?.[0]?.delta?.content;
            if (piece) controller.enqueue(encoder.encode(piece));
          } catch {
            /* keep-alive ou fragmento: ignora */
          }
        }
      },
    }),
  );
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
}

/** Traduz balões em lote preservando o id — sem id, nao da' pra ancorar de volta na pagina. */
export async function translateBlocks(input: TranslateInput): Promise<{ id: number; pt: string }[]> {
  const out: { id: number; pt: string }[] = [];
  const BATCH = 12;
  const src = LANG_NAME[input.sourceLang ?? 'unknown'] ?? input.sourceLang;
  const dst = TARGET_NAME[(input.target ?? 'pt-br').toLowerCase()] ?? 'portugues do Brasil';

  for (let i = 0; i < input.blocks.length; i += BATCH) {
    const batch = input.blocks.slice(i, i + BATCH);
    let raw = '';
    try {
      raw = await chat([
      {
        role: 'system',
        content:
          `Voce traduz baloes de manga/HQ para ${dst}. O texto vem de OCR e pode ter ruido, ` +
          'letras trocadas ou quebras estranhas: corrija o obvio antes de traduzir. Mantenha registro, ' +
          `girias e onomatopeias naturais em ${dst}. Se um bloco for so ruido, devolva string vazia. ` +
          'O texto vai ser letreirado dentro do balao original: prefira a formulacao mais curta que ' +
          'preserve o sentido, sem inventar conteudo. ' +
          'Responda SOMENTE um array JSON [{"id":number,"pt":string}], sem comentarios.',
      },
        {
          role: 'user',
          content:
            `Obra: ${input.series ?? 'desconhecida'}${input.chapter ? ` — capitulo ${input.chapter}` : ''}\n` +
            `Idioma de origem: ${src}\n\nBlocos:\n${JSON.stringify(batch, null, 0)}`,
        },
        // Orcamento cresce com o lote: modelo que raciocina consome tudo pensando
        // e devolve content vazio quando o teto e' fixo e apertado.
      ], { maxTokens: Math.max(config.ai.maxTokens, batch.length * 160 + 600) });
      out.push(...parseJsonArray<{ id: number; pt: string }>(raw));
    } catch (err) {
      // Traducao vazia sem log vira "o modelo nao traduziu"; o motivo real fica aqui.
      console.error(`[traducao] lote ${i / BATCH} falhou: ${(err as Error).message}`);
      if (raw) console.error(`[traducao] resposta crua: ${raw.slice(0, 300)}`);
      out.push(...batch.map((b) => ({ id: b.id, pt: '' })));
    }
  }
  return out;
}

export interface VisionInput {
  imageDataUrl: string;
  series?: string;
  chapter?: string;
}

/** Caminho alternativo ao OCR: modelo com visao le a pagina direto (texto vertical/estilizado). */
export async function visionTranslate(input: VisionInput): Promise<{ original: string; pt: string }[]> {
  if (!config.ai.visionModel) throw new Error('AI_VISION_MODEL nao configurado');
  const raw = await chat(
    [
      {
        role: 'system',
        content:
          'Voce le paginas de manga/HQ. Liste os baloes na ordem de leitura da obra e traduza para portugues do Brasil. ' +
          'Responda SOMENTE um array JSON [{"original":string,"pt":string}].',
      },
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: `Obra: ${input.series ?? 'desconhecida'}${input.chapter ? ` — capitulo ${input.chapter}` : ''}`,
          },
          { type: 'image_url', image_url: { url: input.imageDataUrl } },
        ],
      },
    ],
    { model: config.ai.visionModel },
  );
  return parseJsonArray<{ original: string; pt: string }>(raw);
}

export interface ExplainInput {
  series?: string;
  description?: string;
  chapter?: string;
  pageText?: string[];
  question?: string;
  history?: { role: 'user' | 'assistant'; content: string }[];
}

export function explainStream(input: ExplainInput): Promise<ReadableStream<Uint8Array>> {
  const context = [
    input.series ? `Obra: ${input.series}` : '',
    input.chapter ? `Capitulo: ${input.chapter}` : '',
    input.description ? `Sinopse: ${input.description.slice(0, 1200)}` : '',
    input.pageText?.length ? `Texto lido na pagina atual:\n${input.pageText.join('\n')}` : '',
  ]
    .filter(Boolean)
    .join('\n');

  return chatStream([
    {
      role: 'system',
      content:
        'Voce e um leitor experiente de manga/HQ ajudando em portugues do Brasil. Explique contexto, ' +
        'personagens, referencias culturais e o que acontece na cena. Seja direto. ' +
        'NUNCA entregue spoiler alem do ponto informado: se precisar, avise antes. ' +
        'Se o contexto nao bastar, diga o que falta em vez de inventar.',
    },
    ...(input.history ?? []),
    {
      role: 'user',
      content: `${context}\n\nPergunta: ${input.question ?? 'Explique o que esta acontecendo nesta pagina.'}`,
    },
  ]);
}

export async function aiHealth(): Promise<{
  ok: boolean;
  baseUrl: string;
  model: string;
  configuredModel: string;
  visionModel: string;
  models?: string[];
  error?: string;
}> {
  const base = {
    baseUrl: config.ai.baseUrl,
    model: config.ai.model,
    configuredModel: config.ai.model,
    visionModel: config.ai.visionModel,
  };
  const models = await listModels();
  if (!models.length) {
    return { ...base, ok: false, error: `sem resposta de ${config.ai.baseUrl}/models` };
  }
  // Estar listado nao prova que responde — a homologacao real e' pedir uma traducao.
  return { ...base, ok: true, model: await resolveModel(), models };
}
