const env = (k: string, d = ''): string => (process.env[k] ?? d).trim();
const num = (k: string, d: number): number => {
  const v = Number(env(k));
  return Number.isFinite(v) && v > 0 ? v : d;
};

export type AiProvider = 'openrouter' | 'ollama' | 'openaicompatible';

export function normalizeProvider(raw: string | undefined, fallback: AiProvider = 'ollama'): AiProvider {
  if (!raw) return fallback;
  const p = raw.toLowerCase().replace(/[-_]/g, '');
  if (p === 'openrouter') return 'openrouter';
  if (p === 'openaicompatible' || p === 'openai') return 'openaicompatible';
  if (p === 'ollama') return 'ollama';
  return fallback;
}

export const config = {
  port: num('PORT', 7788),
  cacheDir: env('CACHE_DIR', '.cache'),
  cacheTtlMs: num('CACHE_TTL_MS', 30 * 60 * 1000),
  ai: {
    provider: normalizeProvider(env('AI_PROVIDER'), 'ollama'),
    baseUrl: env('AI_BASE_URL', 'http://127.0.0.1:11434/v1').replace(/\/+$/, ''),
    apiKey: env('AI_API_KEY', 'ollama'),
    model: env('AI_MODEL', 'qwen2.5:7b-instruct'),
    visionModel: env('AI_VISION_MODEL'),
    maxTokens: num('AI_MAX_TOKENS', 1200),
    timeoutMs: num('AI_TIMEOUT_MS', 120_000),
    openrouter: {
      baseUrl: env('OPENROUTER_BASE_URL', 'https://openrouter.ai/api/v1').replace(/\/+$/, ''),
      apiKey: env('OPENROUTER_API_KEY', env('AI_API_KEY')),
      model: env('OPENROUTER_MODEL', env('AI_MODEL', 'meta-llama/llama-3.3-70b-instruct')),
      visionModel: env('OPENROUTER_VISION_MODEL', env('AI_VISION_MODEL')),
    },
    ollama: {
      baseUrl: env('OLLAMA_BASE_URL', env('AI_BASE_URL', 'http://127.0.0.1:11434/v1')).replace(/\/+$/, ''),
      apiKey: env('OLLAMA_API_KEY', env('AI_API_KEY', 'ollama')),
      model: env('OLLAMA_MODEL', env('AI_MODEL', 'qwen2.5:7b-instruct')),
      visionModel: env('OLLAMA_VISION_MODEL', env('AI_VISION_MODEL')),
    },
    openaiCompatible: {
      baseUrl: env('OPENAI_COMPATIBLE_BASE_URL', env('AI_BASE_URL', 'http://127.0.0.1:11434/v1')).replace(/\/+$/, ''),
      apiKey: env('OPENAI_COMPATIBLE_API_KEY', env('AI_API_KEY', 'ollama')),
      model: env('OPENAI_COMPATIBLE_MODEL', env('AI_MODEL', 'qwen2.5:7b-instruct')),
      visionModel: env('OPENAI_COMPATIBLE_VISION_MODEL', env('AI_VISION_MODEL')),
    },
  },
  localRoots: env('LOCAL_LIBRARY')
    .split(';')
    .map((p) => p.trim())
    .filter(Boolean),
  userAgent:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
};

export interface ProviderConfig {
  name: AiProvider;
  baseUrl: string;
  apiKey: string;
  model: string;
  visionModel?: string;
}

export function getProviderConfig(provider: AiProvider = config.ai.provider): ProviderConfig {
  if (provider === 'openrouter') {
    return {
      name: 'openrouter',
      baseUrl: config.ai.openrouter.baseUrl,
      apiKey: config.ai.openrouter.apiKey,
      model: config.ai.openrouter.model,
      visionModel: config.ai.openrouter.visionModel,
    };
  }
  if (provider === 'openaicompatible') {
    return {
      name: 'openaicompatible',
      baseUrl: config.ai.openaiCompatible.baseUrl,
      apiKey: config.ai.openaiCompatible.apiKey,
      model: config.ai.openaiCompatible.model,
      visionModel: config.ai.openaiCompatible.visionModel,
    };
  }
  return {
    name: 'ollama',
    baseUrl: config.ai.ollama.baseUrl,
    apiKey: config.ai.ollama.apiKey,
    model: config.ai.ollama.model,
    visionModel: config.ai.ollama.visionModel,
  };
}

/**
 * Hosts liberados no proxy de imagem. Toda URL proxiada e' assinada (HMAC), esta
 * lista e' a segunda barreira contra SSRF caso a chave vaze do processo.
 */
export const imageHostAllowlist = [
  'uploads.mangadex.org',
  '.mangadex.network',
  'mangadex.org',
  'cdn.readdetectiveconan.com',
  '.planeptune.us',
  '.compsci88.com',
  'temp.compsci88.com',
  'official.lowee.us',
  'scans.lastation.us',
  'hot.leanbox.us',
  'official.leanbox.us',
];

/**
 * Provider configuravel (Madara) registra seu proprio host aqui na inicializacao.
 * A origem e' sempre configuracao do processo, nunca a requisicao — senao a
 * allowlist deixaria de valer alguma coisa.
 */
export function registerImageHost(host: string): void {
  const h = host.toLowerCase();
  if (h && !imageHostAllowlist.includes(h)) imageHostAllowlist.push(h);
}

export function hostAllowed(host: string): boolean {
  const h = host.toLowerCase();
  return imageHostAllowlist.some((a) => (a.startsWith('.') ? h.endsWith(a) : h === a));
}

import { join } from 'node:path';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';

function loadPersistedAiConfig(): void {
  try {
    const p = join(config.cacheDir, 'ai-config.json');
    if (existsSync(p)) {
      const data = JSON.parse(readFileSync(p, 'utf-8')) as {
        active?: string;
        ollama?: Partial<typeof config.ai.ollama>;
        openrouter?: Partial<typeof config.ai.openrouter>;
        openaiCompatible?: Partial<typeof config.ai.openaiCompatible>;
      };
      if (data.active) config.ai.provider = normalizeProvider(data.active);
      if (data.ollama) Object.assign(config.ai.ollama, data.ollama);
      if (data.openrouter) Object.assign(config.ai.openrouter, data.openrouter);
      if (data.openaiCompatible) Object.assign(config.ai.openaiCompatible, data.openaiCompatible);
    }
  } catch {}
}

export function saveAiConfig(): void {
  try {
    mkdirSync(config.cacheDir, { recursive: true });
    const p = join(config.cacheDir, 'ai-config.json');
    const data = {
      active: config.ai.provider,
      ollama: config.ai.ollama,
      openrouter: config.ai.openrouter,
      openaiCompatible: config.ai.openaiCompatible,
    };
    writeFileSync(p, JSON.stringify(data, null, 2), 'utf-8');
  } catch (err) {
    console.error('[config] erro ao salvar ai-config.json:', err);
  }
}

loadPersistedAiConfig();

