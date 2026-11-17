import { api } from './base.ts';
import { persist, store, type Bookmark, type Progress } from './state.ts';

/** O que vai para o arquivo da pasta sincronizada. Preferencias ficam por maquina. */
export interface SyncPayload {
  version: 1;
  updatedAt: number;
  favorites: typeof store.favorites;
  progress: Record<string, Progress>;
  read: Record<string, string[]>;
  bookmarks: Bookmark[];
  removed: Record<string, number>;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const at = (v: unknown): number => (isObj(v) && typeof v.at === 'number' ? v.at : 0);
const bmKey = (b: Bookmark): string => `bm:${b.provider}:${b.chapterId}:${b.page}`;

/** Le o arquivo remoto com tolerancia: o que nao tem o formato esperado fica de fora. */
export function asPayload(raw: unknown): SyncPayload | null {
  if (!isObj(raw) || raw.version !== 1) return null;
  const rec = (v: unknown) => (isObj(v) ? Object.fromEntries(Object.entries(v).filter(([, x]) => isObj(x))) : {});
  return {
    version: 1,
    updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : 0,
    favorites: rec(raw.favorites) as SyncPayload['favorites'],
    progress: rec(raw.progress) as SyncPayload['progress'],
    read: isObj(raw.read)
      ? Object.fromEntries(Object.entries(raw.read).filter(([, v]) => Array.isArray(v)).map(([k, v]) => [k, (v as unknown[]).filter((x) => typeof x === 'string') as string[]]))
      : {},
    bookmarks: Array.isArray(raw.bookmarks) ? (raw.bookmarks.filter(isObj) as unknown as Bookmark[]) : [],
    removed: isObj(raw.removed) ? (Object.fromEntries(Object.entries(raw.removed).filter(([, v]) => typeof v === 'number')) as Record<string, number>) : {},
  };
}

export function localPayload(now = Date.now()): SyncPayload {
  return {
    version: 1,
    updatedAt: now,
    favorites: store.favorites,
    progress: store.progress,
    read: store.read,
    bookmarks: store.bookmarks,
    removed: store.removed,
  };
}

/** Junta duas maquinas: o mais recente vence por item; remocao vence quem e' mais antigo que ela. */
export function mergePayloads(a: SyncPayload, b: SyncPayload, now = Date.now()): SyncPayload {
  const removed: Record<string, number> = { ...a.removed };
  for (const [k, t] of Object.entries(b.removed)) removed[k] = Math.max(removed[k] ?? 0, t);

  const newer = <T>(x: Record<string, T>, y: Record<string, T>): Record<string, T> => {
    const out: Record<string, T> = { ...x };
    for (const [k, v] of Object.entries(y)) if (!out[k] || at(v) > at(out[k])) out[k] = v;
    return out;
  };

  const favorites = newer(a.favorites, b.favorites);
  for (const [k, f] of Object.entries(favorites)) if ((removed[`fav:${k}`] ?? 0) >= at(f)) delete favorites[k];

  const read: Record<string, string[]> = {};
  for (const src of [a.read, b.read]) {
    for (const [k, ids] of Object.entries(src)) read[k] = [...new Set([...(read[k] ?? []), ...ids])];
  }

  const marks = new Map<string, Bookmark>();
  for (const m of [...a.bookmarks, ...b.bookmarks]) {
    const k = bmKey(m);
    const cur = marks.get(k);
    if (!cur || at(m) > at(cur)) marks.set(k, m);
  }
  const bookmarks = [...marks.values()]
    .filter((m) => (removed[bmKey(m)] ?? 0) < at(m))
    .sort((x, y) => at(y) - at(x))
    .slice(0, 200);

  // lapide com mais de 180 dias ja' passou por todas as maquinas
  const horizon = now - 180 * 24 * 60 * 60 * 1000;
  for (const [k, t] of Object.entries(removed)) if (t < horizon) delete removed[k];

  return { version: 1, updatedAt: now, favorites, progress: newer(a.progress, b.progress), read, bookmarks, removed };
}

let running: Promise<SyncResult> | null = null;

export type SyncResult = { ok: true; changed: boolean } | { ok: false; error: string; off?: boolean };

/** Puxa o arquivo, junta com o local, grava nos dois lados. Uma rodada por vez. */
export function syncNow(): Promise<SyncResult> {
  running ??= (async (): Promise<SyncResult> => {
    try {
      const res = await fetch(api('/api/sync'));
      const body = (await res.json().catch(() => ({}))) as { data?: unknown; error?: string };
      if (!res.ok) return { ok: false, error: body.error ?? `HTTP ${res.status}`, off: body.error === 'sincronizacao desligada' };
      const before = JSON.stringify(localPayload(0));
      const remote = asPayload(body.data);
      const merged = remote ? mergePayloads(localPayload(), remote) : localPayload();
      store.favorites = merged.favorites;
      store.progress = merged.progress;
      store.read = merged.read;
      store.bookmarks = merged.bookmarks;
      store.removed = merged.removed;
      const changed = JSON.stringify(localPayload(0)) !== before;
      if (changed) persist();
      const put = await fetch(api('/api/sync'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ data: merged }) });
      if (!put.ok) return { ok: false, error: ((await put.json().catch(() => ({}))) as { error?: string }).error ?? `HTTP ${put.status}` };
      return { ok: true, changed };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    } finally {
      running = null;
    }
  })();
  return running;
}

export async function getSyncConfig(): Promise<{ dir: string; enabled: boolean }> {
  const res = await fetch(api('/api/sync/config'));
  return (await res.json()) as { dir: string; enabled: boolean };
}

export async function setSyncConfig(dir: string): Promise<{ dir: string; enabled: boolean }> {
  const res = await fetch(api('/api/sync/config'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ dir }) });
  const body = (await res.json()) as { dir: string; enabled: boolean; error?: string };
  if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
  return body;
}
