import { readdir, stat } from 'node:fs/promises';
import { join, resolve, basename, extname, sep } from 'node:path';
import { config } from '../config.ts';
import { readZipIndex } from '../zip.ts';
import type { ChapterRef, PageRef, Provider, SeriesCard, SeriesDetail } from './types.ts';

const IMAGE_RE = /\.(jpe?g|png|webp|gif|bmp|avif)$/i;
const ARCHIVE_RE = /\.(cbz|zip)$/i;

export const encodePath = (p: string): string => Buffer.from(p, 'utf8').toString('base64url');
export const decodePath = (t: string): string => Buffer.from(t, 'base64url').toString('utf8');

/** So devolve caminho que esteja dentro de LOCAL_LIBRARY — barreira contra path traversal. */
export function assertInsideLibrary(path: string): string {
  const abs = resolve(path);
  const ok = config.localRoots.some((root) => {
    const r = resolve(root);
    return abs === r || abs.startsWith(r.endsWith(sep) ? r : r + sep);
  });
  if (!ok) throw new Error('caminho fora da biblioteca local');
  return abs;
}

const collator = new Intl.Collator('pt-BR', { numeric: true, sensitivity: 'base' });
const natural = (a: string, b: string): number => collator.compare(a, b);

async function listChapterFiles(dir: string): Promise<{ dirs: string[]; archives: string[]; images: string[] }> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  return {
    dirs: entries.filter((e) => e.isDirectory()).map((e) => join(dir, e.name)).sort(natural),
    archives: entries
      .filter((e) => e.isFile() && ARCHIVE_RE.test(e.name))
      .map((e) => join(dir, e.name))
      .sort(natural),
    images: entries
      .filter((e) => e.isFile() && IMAGE_RE.test(e.name))
      .map((e) => join(dir, e.name))
      .sort(natural),
  };
}

async function chaptersOf(seriesDir: string): Promise<ChapterRef[]> {
  const { dirs, archives, images } = await listChapterFiles(seriesDir);
  const out: ChapterRef[] = [];
  for (const p of [...archives, ...dirs]) {
    const name = basename(p, extname(p));
    out.push({
      id: encodePath(p),
      provider: 'local',
      seriesId: encodePath(seriesDir),
      number: /(\d+(?:\.\d+)?)/.exec(name)?.[1],
      title: name,
      lang: 'local',
    });
  }
  // Pasta com imagens soltas conta como capitulo unico.
  if (!out.length && images.length) {
    out.push({
      id: encodePath(seriesDir),
      provider: 'local',
      seriesId: encodePath(seriesDir),
      number: '1',
      title: basename(seriesDir),
      lang: 'local',
      pages: images.length,
    });
  }
  return out.sort((a, b) => natural(a.title ?? '', b.title ?? ''));
}

export async function localPagePaths(chapterId: string): Promise<{ kind: 'dir' | 'zip'; base: string; names: string[] }> {
  const path = assertInsideLibrary(decodePath(chapterId));
  const st = await stat(path);
  if (st.isDirectory()) {
    const { images } = await listChapterFiles(path);
    return { kind: 'dir', base: path, names: images.map((i) => basename(i)) };
  }
  const entries = await readZipIndex(path);
  return {
    kind: 'zip',
    base: path,
    names: entries
      .map((e) => e.name)
      .filter((n) => IMAGE_RE.test(n))
      .sort(natural),
  };
}

async function seriesDirs(): Promise<string[]> {
  const out: string[] = [];
  for (const root of config.localRoots) {
    const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      if (e.isDirectory()) out.push(join(root, e.name));
      else if (ARCHIVE_RE.test(e.name)) out.push(join(root, e.name));
    }
  }
  return out.sort(natural);
}

async function cardFor(path: string): Promise<SeriesCard> {
  const isArchive = ARCHIVE_RE.test(path);
  const id = encodePath(path);
  const firstChapter = isArchive ? id : (await chaptersOf(path))[0]?.id;
  return {
    id,
    provider: 'local',
    title: basename(path, isArchive ? extname(path) : ''),
    cover: firstChapter ? `/api/local/page?c=${firstChapter}&i=0` : undefined,
    type: 'local',
    origin: 'unknown',
    tags: [],
  };
}

export const local: Provider = {
  id: 'local',
  name: 'Biblioteca local',
  kind: 'local',
  supports: ['q', 'page'],

  async search(f) {
    const dirs = await seriesDirs();
    const q = (f.q ?? '').toLowerCase();
    const matched = dirs.filter((d) => !q || basename(d).toLowerCase().includes(q));
    const limit = f.limit ?? 24;
    const start = ((f.page ?? 1) - 1) * limit;
    const items = await Promise.all(matched.slice(start, start + limit).map(cardFor));
    return { items, total: matched.length };
  },

  async series(id) {
    const path = assertInsideLibrary(decodePath(id));
    const card = await cardFor(path);
    const chapters = ARCHIVE_RE.test(path)
      ? [{ id, provider: 'local', seriesId: id, number: '1', title: card.title, lang: 'local' } satisfies ChapterRef]
      : await chaptersOf(path);
    return { ...card, chapters, availableLangs: ['local'] };
  },

  async pages(chapterId) {
    const { names } = await localPagePaths(chapterId);
    const out: PageRef[] = names.map((_, i) => ({ url: `/api/local/page?c=${chapterId}&i=${i}` }));
    return out;
  },
};
