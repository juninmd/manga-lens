import { mkdir, readdir, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { config } from './config.ts';

/** Teto da camada de memoria: a mais antiga sai primeiro (Map preserva ordem de insercao). */
export const MAX_MEM_ENTRIES = 1000;
/** Arquivo de cache em disco sem uso ha mais que isto e' apagado no expurgo. */
export const DISK_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const PURGE_EVERY_MS = 6 * 60 * 60 * 1000;
// so' o que o proprio cache gravou: ai-config.json e afins vivem na mesma pasta
const CACHE_FILE = /^[0-9a-f]{40}\.json$/;

const mem = new Map<string, { at: number; value: unknown }>();
const inflight = new Map<string, Promise<unknown>>();
let dirReady: Promise<void> | null = null;
let purgeTimer: ReturnType<typeof setInterval> | null = null;

function ensureDir(): Promise<void> {
  dirReady ??= mkdir(config.cacheDir, { recursive: true }).then(() => {
    void purgeDisk().catch(() => undefined);
    purgeTimer ??= setInterval(() => void purgeDisk().catch(() => undefined), PURGE_EVERY_MS);
    (purgeTimer as { unref?: () => void }).unref?.();
  });
  return dirReady;
}

const fileFor = (key: string): string =>
  join(config.cacheDir, `${createHash('sha1').update(key).digest('hex')}.json`);

function remember(key: string, entry: { at: number; value: unknown }): void {
  mem.delete(key);
  mem.set(key, entry);
  while (mem.size > MAX_MEM_ENTRIES) mem.delete(mem.keys().next().value as string);
}

/** Apaga do disco os arquivos de cache mais velhos que `maxAgeMs`. Devolve quantos saiu. */
export async function purgeDisk(maxAgeMs = DISK_MAX_AGE_MS, now = Date.now()): Promise<number> {
  let removed = 0;
  for (const name of await readdir(config.cacheDir).catch(() => [] as string[])) {
    if (!CACHE_FILE.test(name)) continue;
    const path = join(config.cacheDir, name);
    try {
      if (now - (await stat(path)).mtimeMs > maxAgeMs) {
        await unlink(path);
        removed++;
      }
    } catch {
      /* apagado por outra chamada no meio do caminho */
    }
  }
  return removed;
}

/** Quantas entradas estao em memoria (para teste e diagnostico). */
export const memSize = (): number => mem.size;

/**
 * Cache em duas camadas (memoria + disco) com TTL. Evita queimar rate limit dos
 * providers. Chamadas simultaneas da mesma chave compartilham um unico `load`.
 */
export async function cached<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
  const now = Date.now();
  const hit = mem.get(key);
  if (hit && now - hit.at < ttlMs) return hit.value as T;

  const pending = inflight.get(key);
  if (pending) return pending as Promise<T>;

  const run = (async () => {
    await ensureDir();
    const file = Bun.file(fileFor(key));
    if (await file.exists()) {
      try {
        const raw = (await file.json()) as { at: number; value: T };
        if (now - raw.at < ttlMs) {
          remember(key, raw);
          return raw.value;
        }
      } catch {
        /* cache corrompido: recarrega */
      }
    }

    const value = await load();
    const entry = { at: now, value };
    remember(key, entry);
    await Bun.write(fileFor(key), JSON.stringify(entry)).catch(() => undefined);
    return value;
  })();
  inflight.set(key, run);
  try {
    return await run;
  } finally {
    inflight.delete(key);
  }
}

export const defaultTtl = (): number => config.cacheTtlMs;

/**
 * Leitura avulsa (sem `load`): para quem decide depois se o valor merece ir ao
 * cache — a traducao so' e' gravada quando a pagina saiu inteira.
 */
export async function readCached<T>(key: string, ttlMs: number, now = Date.now()): Promise<T | undefined> {
  const hit = mem.get(key);
  if (hit && now - hit.at < ttlMs) return hit.value as T;
  await ensureDir();
  const file = Bun.file(fileFor(key));
  if (!(await file.exists())) return undefined;
  try {
    const raw = (await file.json()) as { at: number; value: T };
    if (now - raw.at >= ttlMs) return undefined;
    remember(key, raw);
    return raw.value;
  } catch {
    return undefined;
  }
}

export async function writeCached(key: string, value: unknown): Promise<void> {
  const entry = { at: Date.now(), value };
  remember(key, entry);
  await ensureDir();
  await Bun.write(fileFor(key), JSON.stringify(entry)).catch(() => undefined);
}
