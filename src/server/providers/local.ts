import { readdir, stat } from 'node:fs/promises';
import { join, resolve, basename, extname, sep } from 'node:path';
import { config } from '../config.ts';
import { readZipEntry, readZipIndex } from '../zip.ts';
import { readRarEntry, readRarIndex } from '../rar.ts';
import { COMIC_INFO_RE, parseComicInfo, type ComicInfo } from '../comic-info.ts';
import { pdfPageCount } from '../pdf.ts';
import { readEpub, readEpubChapter, type TextBlock } from '../epub.ts';
import type { ChapterRef, ContentType, PageRef, Provider, SeriesCard, SeriesDetail } from './types.ts';

const IMAGE_RE = /\.(jpe?g|png|webp|gif|bmp|avif)$/i;
const RAR_RE = /\.(cbr|rar)$/i;
const PDF_RE = /\.pdf$/i;
const EPUB_RE = /\.epub$/i;
/** todo arquivo compactado que vale como capitulo */
const ARCHIVE_RE = /\.(cbz|zip|cbr|rar)$/i;
/** tudo que e' um capitulo num arquivo so' (compactado ou documento) */
const FILE_RE = /\.(cbz|zip|cbr|rar|pdf|epub)$/i;

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
      .filter((e) => e.isFile() && FILE_RE.test(e.name))
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

/**
 * Metadados do capitulo quando o arquivo traz ComicInfo.xml. Sem ele, `null` — o
 * nome do arquivo continua valendo. Erro de leitura tambem vira `null`: arquivo
 * exotico nao pode impedir a HQ de abrir.
 */
export async function comicInfoOf(path: string): Promise<ComicInfo | null> {
  try {
    if (RAR_RE.test(path)) {
      const entry = (await readRarIndex(path)).find((e) => COMIC_INFO_RE.test(e.name));
      if (!entry) return null;
      return parseComicInfo(new TextDecoder().decode(await readRarEntry(path, entry.name)));
    }
    if (!ARCHIVE_RE.test(path)) return null;
    const entries = await readZipIndex(path);
    const entry = entries.find((e) => COMIC_INFO_RE.test(e.name));
    if (!entry) return null;
    return parseComicInfo((await readZipEntry(path, entry)).toString('utf8'));
  } catch {
    return null;
  }
}

export async function localPagePaths(chapterId: string): Promise<{ kind: 'dir' | 'zip' | 'rar' | 'pdf'; base: string; names: string[] }> {
  const path = assertInsideLibrary(decodePath(chapterId));
  const st = await stat(path);
  if (st.isDirectory()) {
    const { images } = await listChapterFiles(path);
    return { kind: 'dir', base: path, names: images.map((i) => basename(i)) };
  }
  if (PDF_RE.test(path)) {
    // o PDF nao tem "nomes" de pagina: o indice e' a propria pagina, e a extensao
    // .png e' o que a rota usa para decidir o Content-Type
    const count = await pdfPageCount(path);
    return { kind: 'pdf', base: path, names: Array.from({ length: count }, (_, i) => `${i + 1}.png`) };
  }
  if (EPUB_RE.test(path)) {
    // livro nao tem paginas de imagem; a unica entrada util e' a capa, que a
    // grade do catalogo pede como `i=0`
    const { cover } = await readEpub(path);
    return { kind: 'zip', base: path, names: cover ? [cover] : [] };
  }
  const rar = RAR_RE.test(path);
  const names = rar ? (await readRarIndex(path)).map((e) => e.name) : (await readZipIndex(path)).map((e) => e.name);
  return {
    kind: rar ? 'rar' : 'zip',
    base: path,
    // o CBR guarda a pagina com o separador do Windows; a ordem e' a do nome cheio
    names: names.filter((n) => IMAGE_RE.test(n)).sort(natural),
  };
}

/**
 * Id de capitulo de livro: os dois base64url separados por ponto. Ponto nao
 * existe no alfabeto base64url, entao o corte nunca e' ambiguo — e nem o
 * caminho nem o href precisam de escape.
 */
const bookChapterId = (path: string, href: string): string => `${encodePath(path)}.${encodePath(href)}`;

/**
 * Paragrafos de um capitulo de livro. O href nunca vira caminho de disco: ele e'
 * procurado no indice do proprio EPUB, entao "../../etc/passwd" nao existe como
 * entrada e a leitura falha em vez de sair da biblioteca.
 */
export async function localBookBlocks(chapterId: string): Promise<TextBlock[]> {
  const [raw = '', href = ''] = chapterId.split('.');
  const path = assertInsideLibrary(decodePath(raw));
  if (!EPUB_RE.test(path)) throw new Error('este capitulo nao pertence a um livro');
  return readEpubChapter(path, decodePath(href));
}

async function seriesDirs(): Promise<string[]> {
  const out: string[] = [];
  for (const root of config.localRoots) {
    const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      if (e.isDirectory()) out.push(join(root, e.name));
      else if (FILE_RE.test(e.name)) out.push(join(root, e.name));
    }
  }
  return out.sort(natural);
}

/**
 * Sem ComicInfo o que sobra e' a extensao, e ela separa bem na pratica: manga
 * circula em CBZ e HQ ocidental em CBR (heranca do WinRAR nos scans de comic).
 * O palpite so' decide o sentido de leitura e a aba do catalogo — ambos
 * corrigiveis na barra do leitor.
 */
function guessFromName(path: string): { contentType: ContentType; type?: string; origin: string } {
  // PDF e' formato de documento, nao de scan de manga: vai para a aba Livro e
  // abre da esquerda para a direita, que e' o certo para a maioria esmagadora
  if (PDF_RE.test(path)) return { contentType: 'livro', type: 'comic', origin: 'unknown' };
  // EPUB e' texto corrido: nao tem pagina para o OCR, entao o leitor de livro assume
  if (EPUB_RE.test(path)) return { contentType: 'livro', type: 'book', origin: 'unknown' };
  return RAR_RE.test(path)
    ? { contentType: 'hq', type: 'comic', origin: 'en' }
    : { contentType: 'manga', origin: 'unknown' };
}

/**
 * O que o ComicInfo DECLARA vence o palpite pela extensao. O que ele omite nao
 * vence nada: ComicInfo so' com Series/Number e' comum, e ler a omissao do campo
 * `Manga` como "e' HQ" mandava todo CBZ assim para a aba errada, em LTR.
 */
function fromComicInfo(info: ComicInfo): { contentType?: ContentType; type?: string; origin?: string } {
  if (info.manga === undefined) return info.lang ? { origin: info.lang } : {};
  if (info.manga) return { contentType: 'manga', origin: info.lang ?? 'ja' };
  // `Manga: No` declarado e' HQ ocidental: `type: 'comic'` e' o que poe o leitor em LTR
  return { contentType: 'hq', type: 'comic', origin: info.lang ?? 'en' };
}

async function cardFor(path: string, info?: ComicInfo | null): Promise<SeriesCard> {
  // EPUB e' a excecao a regra de nao abrir arquivo na grade: o nome do arquivo
  // costuma ser um slug ("pg1234.epub") e o titulo de verdade so' existe no OPF
  if (EPUB_RE.test(path)) {
    const book = await readEpub(path).catch(() => null);
    return {
      id: encodePath(path),
      provider: 'local',
      title: book?.title || basename(path, extname(path)),
      cover: book?.cover ? `/api/local/page?c=${encodePath(path)}&i=0` : undefined,
      contentType: 'livro',
      type: 'book',
      origin: book?.lang ?? 'unknown',
      tags: [],
    };
  }
  const isArchive = FILE_RE.test(path);
  const id = encodePath(path);
  const firstChapter = isArchive ? id : (await chaptersOf(path))[0]?.id;
  // numa pasta o formato esta' no capitulo, nao no nome da obra: "HQ Teste/Cap 01.cbr"
  // ficava como manga porque a pasta nao tem extensao nenhuma
  const guess = guessFromName(isArchive || !firstChapter ? path : decodePath(firstChapter));
  const declared: { contentType?: ContentType; type?: string; origin?: string } = info ? fromComicInfo(info) : {};
  return {
    id,
    provider: 'local',
    title: info?.series || basename(path, isArchive ? extname(path) : ''),
    cover: firstChapter ? `/api/local/page?c=${firstChapter}&i=0` : undefined,
    description: info?.summary,
    year: info?.year,
    ...guess,
    ...Object.fromEntries(Object.entries(declared).filter(([, v]) => v !== undefined)),
    // `type` fora do spread: manga declarado nao pode herdar o 'comic' do palpite
    type: declared.type ?? (declared.contentType === 'manga' ? undefined : guess.type) ?? 'local',
    tags: info?.genres ?? [],
  };
}

/**
 * O EPUB ja' traz titulo, autor, idioma e a ordem de leitura: aqui o spine vira
 * a lista de capitulos e cada item guarda seu proprio href. `text: true` e' o
 * que manda o app abrir o leitor de livro em vez do leitor de paginas.
 */
async function epubDetail(path: string, id: string): Promise<SeriesDetail> {
  const info = await readEpub(path);
  const chapters: ChapterRef[] = info.spine.map((ref, i) => ({
    id: bookChapterId(path, ref.href),
    provider: 'local',
    seriesId: id,
    number: String(i + 1),
    title: ref.title ?? `Capitulo ${i + 1}`,
    // `lang` aqui e' o idioma da PUBLICACAO no painel, que filtra a lista por ele;
    // o idioma do livro vai em `origin`, que e' quem escolhe o pipeline de traducao
    lang: 'local',
    text: true,
  }));
  return {
    id,
    provider: 'local',
    title: info.title || basename(path, extname(path)),
    authors: info.author ? [info.author] : undefined,
    cover: info.cover ? `/api/local/page?c=${id}&i=0` : undefined,
    contentType: 'livro',
    type: 'book',
    origin: info.lang ?? 'unknown',
    tags: [],
    chapters,
    availableLangs: ['local'],
  };
}

export const local: Provider = {
  id: 'local',
  name: 'Biblioteca local',
  kind: 'local',
  // padrao: pastas/CBZ locais sao mangá/HQ por convenção do app; itens
  // .epub/.pdf sobrescrevem para 'livro' no SeriesCard (ver passo 5 do plano)
  contentType: 'manga',
  supports: ['q', 'page'],

  async search(f) {
    const dirs = await seriesDirs();
    const q = (f.q ?? '').toLowerCase();
    const matched = dirs.filter((d) => !q || basename(d).toLowerCase().includes(q));
    const limit = f.limit ?? 24;
    const start = ((f.page ?? 1) - 1) * limit;
    // a grade NAO le ComicInfo: seriam N arquivos abertos por pagina de busca.
    // O palpite pela extensao ja' poe cada obra na aba certa; o detalhe refina.
    // Numa aba especifica o corte vem ANTES da paginacao: cortar depois devolvia
    // 3 livros numa pagina de 24 porque os outros 21 eram manga.
    if (f.contentType) {
      const all = await Promise.all(matched.map((d) => cardFor(d)));
      const only = all.filter((c) => c.contentType === f.contentType);
      return { items: only.slice(start, start + limit), total: only.length };
    }
    const items = await Promise.all(matched.slice(start, start + limit).map((d) => cardFor(d)));
    return { items, total: matched.length };
  },

  async series(id) {
    const path = assertInsideLibrary(decodePath(id));
    if (EPUB_RE.test(path)) return epubDetail(path, id);
    const chapters = FILE_RE.test(path) ? null : await chaptersOf(path);
    // o ComicInfo mora no arquivo do capitulo, nao na pasta da obra
    const infoSource = chapters?.length ? decodePath(chapters[0]!.id) : path;
    const info = await comicInfoOf(infoSource);
    const card = await cardFor(path, info);
    return {
      ...card,
      chapters: chapters ?? [{ id, provider: 'local', seriesId: id, number: info?.number ?? '1', title: info?.title || card.title, lang: info?.lang ?? 'local' } satisfies ChapterRef],
      availableLangs: ['local'],
    };
  },

  async pages(chapterId) {
    const { names } = await localPagePaths(chapterId);
    const out: PageRef[] = names.map((_, i) => ({ url: `/api/local/page?c=${chapterId}&i=${i}` }));
    return out;
  },
};
