import { mkdir, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { config } from './config.ts';

export type Gender = 'm' | 'f' | '?';

export interface GlossaryEntry {
  orig: string;
  pt: string;
  gender: Gender;
}

export interface PageNote {
  chapter: string;
  page: number;
  note: string;
}

export interface SeriesMemory {
  glossary: GlossaryEntry[];
  notes: PageNote[];
}

/** Tetos fixos: o paper de traducao de manga (COLING 2025) mostrou que contexto longo piora. */
export const MAX_GLOSSARY = 80;
export const MAX_NOTES = 60;
export const NOTES_IN_PROMPT = 5;
const MAX_TERM = 40;
const MAX_NOTE = 240;

const cleanText = (v: unknown, max: number): string =>
  typeof v === 'string' ? v.replace(/[\p{Cc}\p{Cf}]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : '';

/** Modelo pequeno joga falas inteiras no glossario e elas viram forma fixa para sempre. */
const isTerm = (s: string): boolean => !/[?!.,;:…？！。、]/u.test(s) && s.split(' ').length <= 4;

/** Obra + idioma de chegada: "Naruto" em pt-BR e em ingles tem glossarios diferentes. */
const keyOf = (series: string, target: string): string =>
  `${series.trim().toLowerCase()}|${target.trim().toLowerCase()}`;

const fileOf = (key: string): string =>
  join(config.cacheDir, 'series-memory', `${createHash('sha1').update(key).digest('hex')}.json`);

const memo = new Map<string, SeriesMemory>();
/** gravacoes da mesma obra em fila: duas paginas traduzidas juntas nao se atropelam */
const writes = new Map<string, Promise<void>>();

async function load(key: string): Promise<SeriesMemory> {
  const hit = memo.get(key);
  if (hit) return hit;
  let mem: SeriesMemory = { glossary: [], notes: [] };
  const file = Bun.file(fileOf(key));
  if (await file.exists()) {
    try {
      const raw = (await file.json()) as Partial<SeriesMemory>;
      mem = { glossary: Array.isArray(raw.glossary) ? raw.glossary : [], notes: Array.isArray(raw.notes) ? raw.notes : [] };
    } catch {
      /* arquivo corrompido: recomeca vazio em vez de derrubar a traducao */
    }
  }
  memo.set(key, mem);
  return mem;
}

async function persist(key: string, mem: SeriesMemory): Promise<void> {
  const path = fileOf(key);
  await mkdir(join(config.cacheDir, 'series-memory'), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  await Bun.write(tmp, JSON.stringify(mem));
  await rename(tmp, path);
}

const chapterNum = (c: string): number => {
  const n = Number.parseFloat(c);
  return Number.isFinite(n) ? n : Number.NaN;
};

/** A nota vem antes da posicao atual? Capitulo sem numero so' conta dentro do proprio capitulo. */
function before(n: PageNote, chapter: string, page: number): boolean {
  if (n.chapter === chapter) return n.page < page;
  const a = chapterNum(n.chapter);
  const b = chapterNum(chapter);
  return Number.isFinite(a) && Number.isFinite(b) && a < b;
}

const position = (n: PageNote): number => (chapterNum(n.chapter) || 0) * 10_000 + n.page;

/** Contexto para traduzir a pagina: glossario inteiro + as ultimas notas ANTERIORES (sem spoiler). */
export async function contextFor(
  series: string,
  target: string,
  chapter: string,
  page: number,
): Promise<{ glossary: GlossaryEntry[]; notes: PageNote[] }> {
  const mem = await load(keyOf(series, target));
  const notes = mem.notes
    .filter((n) => before(n, chapter, page))
    .sort((a, b) => position(a) - position(b))
    .slice(-NOTES_IN_PROMPT);
  return { glossary: mem.glossary, notes };
}

/**
 * Funde o que o LLM aprendeu nesta pagina. Nome ja' registrado nao muda de forma:
 * consistencia vale mais que a "melhor" grafia da vez. Genero so' sai de '?' para
 * m/f. Tudo vem de saida de modelo (e o modelo le texto de OCR): tamanho e
 * caracteres de controle sao podados antes de persistir.
 */
export function remember(
  series: string,
  target: string,
  chapter: string,
  page: number,
  learned: { glossary?: unknown; note?: unknown },
): Promise<void> {
  const key = keyOf(series, target);
  const run = (writes.get(key) ?? Promise.resolve()).then(async () => {
    const mem = await load(key);
    let changed = false;
    for (const raw of Array.isArray(learned.glossary) ? (learned.glossary as Record<string, unknown>[]) : []) {
      const orig = cleanText(raw?.orig, MAX_TERM);
      const pt = cleanText(raw?.pt, MAX_TERM);
      if (!orig || !pt || !isTerm(orig)) continue;
      const gender: Gender = raw.gender === 'm' || raw.gender === 'f' ? raw.gender : '?';
      const known = mem.glossary.find((g) => g.orig.toLowerCase() === orig.toLowerCase());
      if (known) {
        if (known.gender === '?' && gender !== '?') {
          known.gender = gender;
          changed = true;
        }
      } else if (mem.glossary.length < MAX_GLOSSARY) {
        mem.glossary.push({ orig, pt, gender });
        changed = true;
      }
    }
    const note = cleanText(learned.note, MAX_NOTE);
    if (note) {
      mem.notes = mem.notes.filter((n) => !(n.chapter === chapter && n.page === page));
      mem.notes.push({ chapter, page, note });
      if (mem.notes.length > MAX_NOTES) mem.notes.splice(0, mem.notes.length - MAX_NOTES);
      changed = true;
    }
    if (changed) await persist(key, mem);
  });
  const settled = run.catch((err) => console.error(`[memoria] falha ao gravar: ${(err as Error).message}`));
  writes.set(key, settled);
  return settled;
}

export async function memorySummary(series: string, target: string): Promise<SeriesMemory> {
  return await load(keyOf(series, target));
}

export async function forget(series: string, target: string): Promise<void> {
  const key = keyOf(series, target);
  await writes.get(key);
  memo.delete(key);
  await rm(fileOf(key), { force: true });
}
