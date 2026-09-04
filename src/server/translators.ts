import { HttpError, httpFetch } from './http.ts';

export type Engine = 'auto' | 'llm' | 'google' | 'mymemory';

export interface EngineInfo {
  id: Engine;
  name: string;
  needsAi: boolean;
  note: string;
}

export const engines: EngineInfo[] = [
  {
    id: 'auto',
    name: 'Automatico (sem IA primeiro)',
    needsAi: false,
    note: 'tenta Google, depois MyMemory, e recorre a IA apenas se os dois falharem',
  },
  {
    id: 'llm',
    name: 'IA (contexto)',
    needsAi: true,
    note: 'corrige ruido do OCR e entende girias; depende do endpoint OpenAI-compatible',
  },
  {
    id: 'google',
    name: 'Google (sem IA)',
    needsAi: false,
    note: 'rapido e sem chave; traduz literal e nao conserta erro de OCR',
  },
  {
    id: 'mymemory',
    name: 'MyMemory (sem IA)',
    needsAi: false,
    note: 'plano anonimo com cota diaria; reserva quando o Google recusa',
  },
];

const LANG: Record<string, string> = {
  ja: 'ja',
  ko: 'ko',
  zh: 'zh-CN',
  'zh-hk': 'zh-TW',
  en: 'en',
  'pt-br': 'pt',
  pt: 'pt',
  es: 'es',
  'es-la': 'es',
  fr: 'fr',
  it: 'it',
  de: 'de',
  ru: 'ru',
  id: 'id',
};

const sourceOf = (lang: string | undefined): string => LANG[(lang ?? '').toLowerCase()] ?? 'auto';

/** Idiomas de chegada oferecidos na leitura. O primeiro e' o padrao. */
export const targets = [
  { id: 'pt-BR', name: 'Portugues (Brasil)' },
  { id: 'en', name: 'Ingles' },
  { id: 'es', name: 'Espanhol' },
  { id: 'fr', name: 'Frances' },
  { id: 'de', name: 'Alemao' },
  { id: 'it', name: 'Italiano' },
  { id: 'ja', name: 'Japones' },
  { id: 'ko', name: 'Coreano' },
  { id: 'zh-CN', name: 'Chines (simplificado)' },
  { id: 'ru', name: 'Russo' },
] as const;

export const DEFAULT_TARGET = targets[0].id;

/** Idioma de chegada so' pode vir da lista: ele entra na URL do tradutor. */
export const targetOf = (lang: string | undefined): string =>
  targets.find((t) => t.id.toLowerCase() === (lang ?? '').toLowerCase())?.id ?? DEFAULT_TARGET;

/**
 * Endpoint publico do Google Tradutor (mesmo que o widget usa). Sem chave, mas
 * responde 429 sob rajada: por isso um bloco por chamada, em serie, com recuo.
 */
async function googleTranslate(text: string, source: string, target: string): Promise<string> {
  const url =
    `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${source}&tl=${target}&dt=t&q=` +
    encodeURIComponent(text);
  const res = await httpFetch(url, { accept: 'application/json', timeoutMs: 15_000, retries: 3 });
  if (!res.ok) throw new HttpError(`google HTTP ${res.status}`, res.status);
  // formato: [[["traduzido","original",...],...],...]
  const data = (await res.json()) as unknown[];
  const segments = (data[0] ?? []) as [string, ...unknown[]][];
  return segments
    .map((s) => s[0] ?? '')
    .join('')
    .trim();
}

/**
 * O que o usuario le no toast. Sem URL (a query levava o texto do balao) e com
 * a acao possivel: 429 do Google passa em ~1 min; cota do MyMemory nao volta hoje.
 */
function engineErrorMessage(engine: string, err: unknown): string {
  const status = err instanceof HttpError ? err.status : undefined;
  if (engine === 'mymemory' && (status === 403 || status === 429 || /quota|limit/i.test(String((err as Error).message)))) {
    return 'mymemory: cota esgotada — use Google ou IA';
  }
  if (status === 429) return `${engine}: limite de requisicoes (429) — aguarde ~1 min ou use o motor Automatico`;
  if (status !== undefined) return `${engine} indisponivel (HTTP ${status})`;
  return `${engine} indisponivel: ${(err as Error).message}`;
}

async function myMemoryTranslate(text: string, source: string, target: string): Promise<string> {
  const pair = `${source === 'auto' ? 'en' : source}|${target}`;
  const url = `https://api.mymemory.translated.net/get?langpair=${encodeURIComponent(pair)}&q=${encodeURIComponent(text)}`;
  const res = await httpFetch(url, { accept: 'application/json', timeoutMs: 15_000, retries: 2 });
  if (!res.ok) throw new HttpError(`mymemory HTTP ${res.status}`, res.status);
  const data = (await res.json()) as {
    responseStatus?: number | string;
    responseData?: { translatedText?: string };
  };
  const status = Number(data.responseStatus ?? 200);
  // 403/429 (ou texto de cota) = limite diario do MyMemory, nao erro do texto
  if (status !== 200) throw new HttpError(`mymemory status ${status}`, status);
  return (data.responseData?.translatedText ?? '').trim();
}

/** Ruido de OCR quase nunca tem letras legiveis de verdade — simbolos isolados, digitos e pontuacao repetida nao contam. */
export const isNoise = (text: string): boolean => {
  const cleaned = text.replace(/^[|:;~^`'"\\/_-]+|[|:;~^`'"\\/_-]+$/g, '').trim();
  const letters = cleaned.replace(/[^\p{L}\p{N}]/gu, '');
  if (letters.length < 2) return true;
  if (/^[\p{P}\p{S}\s\d]+$/u.test(cleaned)) return true;
  const nonSpace = cleaned.replace(/\s/g, '').length;
  return nonSpace > 0 && letters.length / nonSpace < 0.45;
};

/**
 * Quantos baloes traduzem ao mesmo tempo. Os endpoints livres respondem 429 em
 * rajada, entao paralelismo aqui e' com teto: sem teto a pagina inteira dispara
 * de uma vez e o motor devolve erro em vez de traducao.
 */
const CONCURRENCY = Math.max(1, Number(process.env['TRANSLATE_CONCURRENCY'] ?? 5));

/** map com teto de concorrencia, preservando a ordem da entrada. */
async function mapPool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const runner = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, runner));
  return out;
}

/**
 * Tradutores classicos nao sabem ignorar ruido de OCR nem juntar contexto, entao
 * o filtro de lixo e a limpeza acontecem aqui antes de gastar requisicao.
 */
export async function translateWithEngine(
  engine: Exclude<Engine, 'llm' | 'auto'>,
  blocks: { id: number; text: string }[],
  sourceLang: string | undefined,
  targetLang?: string,
): Promise<{ id: number; pt: string }[]> {
  const source = sourceOf(sourceLang);
  const target = targetOf(targetLang);
  const translate = engine === 'google' ? googleTranslate : myMemoryTranslate;
  let lastError = '';

  const results = await mapPool(blocks, CONCURRENCY, async (block) => {
    const text = block.text.replace(/\s*\n\s*/g, ' ').trim();
    // ruido nao gasta requisicao — e tambem nao conta como tentativa
    if (isNoise(text)) return { id: block.id, pt: '', attempted: false, failed: false };
    try {
      return { id: block.id, pt: await translate(text, source, target), attempted: true, failed: false };
    } catch (err) {
      console.error(`[traducao/${engine}] bloco ${block.id}: ${(err as Error).message}`);
      lastError = engineErrorMessage(engine, err);
      return { id: block.id, pt: '', attempted: true, failed: true };
    }
  });

  const attempted = results.filter((r) => r.attempted).length;
  const failed = results.filter((r) => r.failed).length;
  // um bloco perdido e' aceitavel; o motor inteiro fora do ar precisa virar erro
  // para o modo automatico saber que tem de tentar o proximo
  if (attempted > 0 && failed === attempted) throw new Error(lastError || `${engine} indisponivel`);
  return results.map((r) => ({ id: r.id, pt: r.pt }));
}
