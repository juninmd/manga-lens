import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { config } from './config.ts';

const mem = new Map<string, { at: number; value: unknown }>();
let dirReady: Promise<void> | null = null;

function ensureDir(): Promise<void> {
  dirReady ??= mkdir(config.cacheDir, { recursive: true }).then(() => undefined);
  return dirReady;
}

const fileFor = (key: string): string =>
  join(config.cacheDir, `${createHash('sha1').update(key).digest('hex')}.json`);

/** Cache em duas camadas (memoria + disco) com TTL. Evita queimar rate limit dos providers. */
export async function cached<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
  const now = Date.now();
  const hit = mem.get(key);
  if (hit && now - hit.at < ttlMs) return hit.value as T;

  await ensureDir();
  const file = Bun.file(fileFor(key));
  if (await file.exists()) {
    try {
      const raw = (await file.json()) as { at: number; value: T };
      if (now - raw.at < ttlMs) {
        mem.set(key, raw);
        return raw.value;
      }
    } catch {
      /* cache corrompido: recarrega */
    }
  }

  const value = await load();
  const entry = { at: now, value };
  mem.set(key, entry);
  await Bun.write(fileFor(key), JSON.stringify(entry)).catch(() => undefined);
  return value;
}

export const defaultTtl = (): number => config.cacheTtlMs;
