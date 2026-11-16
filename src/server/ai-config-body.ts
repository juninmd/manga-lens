import type { AiProvider } from './config.ts';

const PROVIDERS: readonly AiProvider[] = ['ollama', 'openrouter', 'openaicompatible'];
// biome-ignore lint/suspicious/noControlCharactersInRegex: e' justamente o que se quer recusar
const CONTROL = /[\u0000-\u001f\u007f]/;

export interface AiConfigPatch {
  active?: AiProvider;
  provider?: AiProvider;
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  visionModel?: string;
  clearKey: boolean;
  keepKey: boolean;
}

export class AiConfigError extends Error {}

/** Loopback ou rede privada: unico lugar onde `http:` ainda e' aceito. */
export function isPrivateHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h === '::1' || h.endsWith('.local')) return true;
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(h);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a === 127 || a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31);
}

function provider(raw: unknown, field: string): AiProvider | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  if (typeof raw !== 'string') throw new AiConfigError(`${field} invalido`);
  const p = raw.toLowerCase().replace(/[-_]/g, '');
  const norm = p === 'openai' ? 'openaicompatible' : p;
  if (!PROVIDERS.includes(norm as AiProvider)) throw new AiConfigError('provider invalido');
  return norm as AiProvider;
}

function text(raw: unknown, field: string, max: number): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'string') throw new AiConfigError(`${field} invalido`);
  const v = raw.trim();
  if (v.length > max) throw new AiConfigError(`${field} longo demais (maximo ${max} caracteres)`);
  if (CONTROL.test(v)) throw new AiConfigError(`${field} com caracteres de controle`);
  return v;
}

export function parseBaseUrl(raw: string): string {
  if (raw.length > 300) throw new AiConfigError('baseUrl longa demais (maximo 300 caracteres)');
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new AiConfigError('baseUrl invalida');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new AiConfigError('baseUrl precisa ser http ou https');
  if (url.username || url.password) throw new AiConfigError('baseUrl nao pode ter usuario e senha embutidos');
  if (url.protocol === 'http:' && !isPrivateHost(url.hostname)) {
    throw new AiConfigError('baseUrl publica precisa de https');
  }
  return raw.replace(/\/+$/, '');
}

/**
 * Valida o corpo de `POST /api/ai/config`. Quem troca `baseUrl` recebe a chave na
 * proxima traducao, entao nada entra sem passar por aqui.
 */
export function parseAiConfigBody(raw: unknown): AiConfigPatch {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new AiConfigError('corpo invalido');
  const b = raw as Record<string, unknown>;
  const baseUrl = text(b.baseUrl, 'baseUrl', 300);
  const apiKey = text(b.apiKey, 'apiKey', 500);
  return {
    active: provider(b.active, 'active'),
    provider: provider(b.provider, 'provider'),
    baseUrl: baseUrl ? parseBaseUrl(baseUrl) : undefined,
    // campo vazio = "nao mexer": o painel nao recebe mais a chave para reenviar
    apiKey: apiKey || undefined,
    model: text(b.model, 'model', 200),
    visionModel: text(b.visionModel, 'visionModel', 200),
    clearKey: b.clearKey === true,
    keepKey: b.keepKey === true,
  };
}

/** `••••1234` para chave com 12+ caracteres; nada para chave curta (revelaria demais). */
export function keyHint(key: string | undefined): string {
  if (!key || key.length < 12 || key === 'ollama') return '';
  return `••••${key.slice(-4)}`;
}
