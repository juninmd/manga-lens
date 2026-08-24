const env = (k: string, d = ''): string => (process.env[k] ?? d).trim();
const num = (k: string, d: number): number => {
  const v = Number(env(k));
  return Number.isFinite(v) && v > 0 ? v : d;
};

export const config = {
  port: num('PORT', 7788),
  cacheDir: env('CACHE_DIR', '.cache'),
  cacheTtlMs: num('CACHE_TTL_MS', 30 * 60 * 1000),
  ai: {
    baseUrl: env('AI_BASE_URL', 'http://127.0.0.1:11434/v1').replace(/\/+$/, ''),
    apiKey: env('AI_API_KEY', 'ollama'),
    model: env('AI_MODEL', 'qwen2.5:7b-instruct'),
    visionModel: env('AI_VISION_MODEL'),
    maxTokens: num('AI_MAX_TOKENS', 1200),
    timeoutMs: num('AI_TIMEOUT_MS', 120_000),
  },
  localRoots: env('LOCAL_LIBRARY')
    .split(';')
    .map((p) => p.trim())
    .filter(Boolean),
  userAgent:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
};

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
