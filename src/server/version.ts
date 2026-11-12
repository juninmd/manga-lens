import buildInfo from './build-info.json' with { type: 'json' };

/**
 * Versao em execucao e checagem de atualizacao.
 *
 * A versao vem de `APP_VERSION` ou de `build-info.json`, que o release carimba
 * (`scripts/set-version.ts`) antes de compilar. Sem carimbo e' build de
 * desenvolvimento ("dev"): nao ha' o que comparar, entao a checagem nao roda. A "disponivel" vem da ultima release publicada no GitHub. So' o
 * numero da versao e' consultado: nada do usuario sai da maquina. Quem nao quer
 * a consulta desliga com `UPDATE_CHECK=off`.
 */

export const REPO = 'juninmd/manga-lens';
export const DEV_VERSION = 'dev';
export const CURRENT_VERSION: string =
  process.env['APP_VERSION']?.replace(/^v/, '') || (buildInfo as { version: string | null }).version || DEV_VERSION;

export interface UpdateInfo {
  current: string;
  /** ultima versao publicada; null se a consulta falhou ou esta desligada */
  latest: string | null;
  available: boolean;
  /** pagina da release */
  url: string | null;
  /** instalador (.exe) da release, quando existe */
  downloadUrl: string | null;
  notes: string | null;
  publishedAt: string | null;
  checkedAt: number;
  disabled?: boolean;
  /** rodando do codigo-fonte, sem versao carimbada */
  devBuild?: boolean;
  error?: string;
}

const SEMVER = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/;

export function parseVersion(v: string): [number, number, number] | null {
  const m = SEMVER.exec(v.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** >0 quando `a` e' mais nova que `b`; 0 se igual ou se algum nao for versao valida. */
export function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return 0;
  for (let i = 0; i < 3; i++) {
    const d = pa[i]! - pb[i]!;
    if (d !== 0) return d;
  }
  return 0;
}

interface GhRelease {
  tag_name?: string;
  html_url?: string;
  body?: string;
  published_at?: string;
  draft?: boolean;
  prerelease?: boolean;
  assets?: { name?: string; browser_download_url?: string }[];
}

type Fetcher = (url: string, init: RequestInit) => Promise<Response>;

const TTL_OK = 60 * 60_000;
const TTL_FAIL = 5 * 60_000;
const MIN_FORCE = 30_000;
let cache: UpdateInfo | undefined;

/** so' para teste */
export function resetUpdateCache(): void {
  cache = undefined;
}

export async function checkForUpdate(
  opts: { fetcher?: Fetcher; now?: number; force?: boolean; current?: string } = {},
): Promise<UpdateInfo> {
  const now = opts.now ?? Date.now();
  const current = opts.current ?? CURRENT_VERSION;
  const base: UpdateInfo = {
    current,
    latest: null,
    available: false,
    url: null,
    downloadUrl: null,
    notes: null,
    publishedAt: null,
    checkedAt: now,
  };
  if (!parseVersion(current)) return { ...base, devBuild: true };
  if (process.env['UPDATE_CHECK']?.toLowerCase() === 'off') return { ...base, disabled: true };

  if (cache && cache.current === current) {
    const age = now - cache.checkedAt;
    const ttl = cache.error ? TTL_FAIL : TTL_OK;
    // "verificar agora" respeita um intervalo minimo: nao martela a API do GitHub
    if (age < (opts.force ? MIN_FORCE : ttl)) return cache;
  }

  try {
    const fetcher: Fetcher = opts.fetcher ?? ((u, i) => fetch(u, i));
    const res = await fetcher(`https://api.github.com/repos/${REPO}/releases/latest`, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'manga-lens-update-check' },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) throw new Error(`GitHub respondeu ${res.status}`);
    const rel = (await res.json()) as GhRelease;
    const latest = rel.tag_name?.replace(/^v/, '');
    if (!latest || !parseVersion(latest) || rel.draft || rel.prerelease) throw new Error('release sem versao valida');
    const exe = rel.assets?.find((a) => a.name?.toLowerCase().endsWith('.exe'));
    cache = {
      ...base,
      latest,
      available: compareVersions(latest, current) > 0,
      url: rel.html_url ?? `https://github.com/${REPO}/releases/tag/v${latest}`,
      downloadUrl: exe?.browser_download_url ?? null,
      notes: rel.body?.trim() || null,
      publishedAt: rel.published_at ?? null,
    };
  } catch (err) {
    cache = { ...base, error: (err as Error).message };
  }
  return cache;
}
