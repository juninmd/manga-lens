import { httpFetch } from '../http.ts';
import { registerImageHost } from '../config.ts';
import { cached, defaultTtl } from '../cache.ts';
import type { ChapterRef, PageRef, Provider, SearchFilters, SeriesCard, SeriesDetail } from './types.ts';

const BASE = 'https://archive.org';

/** Onde procurar. O recorte que importa nao e' esse — e' a lista de series abaixo. */
const SCOPE = ['comics', 'folkscanomy', 'fawcett-comics', 'ace-comics'];

/**
 * Series da Golden Age em dominio publico (copyright nao renovado), o mesmo
 * recorte que o Digital Comic Museum e o Comic Book Plus publicam.
 *
 * A lista existe porque a colecao `comics` do Archive e' deposito aberto: buscar
 * nela sem filtro devolve edicao protegida subida por usuario (Amazing Spider-Man
 * #1, Dark Knight Returns). Filtrar por ano nao resolve — as editoras grandes
 * renovaram o registro justamente dos titulos famosos. Casar o titulo com uma
 * serie sabidamente livre e' o unico corte que separa os dois acervos.
 *
 * Inclui Timely (a Marvel dos anos 40) nos titulos que caducaram; Captain America
 * Comics e Marvel Mystery ficam de fora porque a Marvel renovou os dois.
 *
 * Para entrar aqui nao basta ser dominio publico: o casamento e' por SUBSTRING
 * do titulo, entao o nome tambem tem de ser distintivo. Titulo generico de uma
 * palavra ("Beyond", "Attack", "Danger") casa com centenas de itens sem relacao,
 * e nome ainda em uso por editora viva ("Strange Adventures", da DC) arrasta
 * edicao protegida — nenhum dos dois e' pego por MODERN_FRANCHISES.
 *
 * Para ampliar por conta propria: ARCHIVE_SERIES=Serie Um;Serie Dois.
 */
const PUBLIC_DOMAIN_SERIES = [
  // Fawcett
  'Whiz Comics', 'Master Comics', 'Bulletman', 'Spy Smasher', 'Captain Midnight',
  'Nickel Comics', 'Wow Comics', 'Hopalong Cassidy', 'Captain Video',
  // Quality
  'Plastic Man', 'Police Comics', 'Smash Comics', 'National Comics', 'Doll Man',
  'Feature Comics', 'Crack Comics', 'Military Comics',
  // Nedor / Standard
  'Black Terror', 'Exciting Comics', 'Startling Comics', 'Fighting Yank',
  'Wonder Comics', 'Americas Best Comics', 'Thrilling Comics',
  // Fox
  'Blue Beetle', 'Phantom Lady', 'Mystery Men Comics', 'Fantastic Comics',
  // Fiction House
  'Planet Comics', 'Jungle Comics', 'Wings Comics', 'Fight Comics', 'Rangers Comics',
  // Lev Gleason
  'Crime Does Not Pay', 'Silver Streak Comics', 'Boy Comics',
  // Centaur
  'Amazing Man Comics', 'Keen Detective Funnies', 'Masked Marvel',
  // Ace
  'Super Mystery Comics', 'Four Favorites', 'Web of Mystery', 'Lightning Comics',
  // Prize / Youthful / Avon
  // (a "Black Cat" da Harvey ficou de fora de proposito: o nome colide com a
  //  personagem da Marvel e arrastava edicao moderna protegida para a busca)
  'Frankenstein Comics', 'Headline Comics', 'Eerie Comics',
  'Strange Worlds', 'Captain Flight',
  // Timely (Marvel dos anos 40) — apenas os titulos que caducaram
  'Daring Mystery Comics', 'Mystic Comics',
  // MLJ (a Archie dos anos 40), so' os super-herois: 'Pep Comics' fica de fora
  // porque e' onde o Archie estreia, e a marca segue viva e defendida
  'Zip Comics', 'Top-Notch Comics', 'Shield Wizard Comics', 'Blue Ribbon Comics',
  'Black Hood Comics', 'Hangman Comics', 'Jackpot Comics',
  // Holyoke / Continental
  'Cat-Man Comics', 'Captain Aero Comics', 'Terrific Comics', 'Punch Comics',
  'Dynamic Comics', 'Yankee Comics',
  // Spark / Fox
  'Green Lama', 'Weird Comics',
  // ACG — sem renovacao de registro, e a base do acervo de horror livre
  'Adventures into the Unknown', 'Forbidden Worlds',
  // horror pre-Codigo (Fawcett, Star, Comic Media, Ajax)
  'This Magazine Is Haunted', 'Startling Terror Tales', 'Weird Terror',
  'Tales of Horror', 'Ghostly Weird Stories',
  // policial e ficcao cientifica (Trojan, Youthful, Ziff-Davis)
  'Crime Smashers', 'Crimes by Women', 'Captain Science', 'Lars of Mars',
  // faroeste (Magazine Enterprises, Fawcett)
  'Durango Kid', 'Red Mask', 'Rocky Lane Western', 'Straight Arrow', 'Tim Holt',
];


/**
 * Franquias vivas cujo nome cruza com serie livre. Um titulo da Golden Age nunca
 * carrega esses termos, e edicao moderna quase sempre carrega — barrar aqui evita
 * que uma coincidencia de nome arraste obra protegida para dentro do catalogo.
 */
const MODERN_FRANCHISES = [
  'spider-man', 'spider man', 'x-men', 'avengers', 'batman', 'superman', 'wolverine',
  'iron man', 'hulk', 'deadpool', 'justice league', 'daredevil', 'punisher', 'thor',
];

const isModern = (title: string): boolean => {
  const t = title.toLowerCase();
  return MODERN_FRANCHISES.some((f) => t.includes(f));
};

const seriesList = (): string[] => {
  const extra = (process.env['ARCHIVE_SERIES'] ?? '')
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);
  return [...PUBLIC_DOMAIN_SERIES, ...extra];
};

interface SearchDoc {
  identifier: string;
  title?: string | string[];
  year?: number;
  date?: string;
  creator?: string | string[];
  description?: string | string[];
  subject?: string | string[];
}

const one = (v: string | string[] | undefined): string | undefined =>
  Array.isArray(v) ? v[0] : (v ?? undefined);

const listOf = (v: string | string[] | undefined): string[] =>
  Array.isArray(v) ? v : v ? [v] : [];

async function getJson<T>(url: string, timeoutMs = 20_000): Promise<T> {
  const res = await httpFetch(url, { accept: 'application/json', timeoutMs, retries: 2 });
  if (!res.ok) throw new Error(`upstream ${res.status} em ${url}`);
  return (await res.json()) as T;
}

const cardOf = (doc: SearchDoc): SeriesCard => ({
  id: doc.identifier,
  provider: 'archive',
  title: one(doc.title) ?? doc.identifier,
  cover: `${BASE}/services/img/${doc.identifier}`,
  year: doc.year,
  // e' HQ ocidental: o leitor usa isso para ler da esquerda para a direita
  type: 'comic',
  origin: 'en',
  status: 'completed',
  contentRating: 'safe',
  tags: listOf(doc.subject).slice(0, 8),
  description: one(doc.description)?.replace(/<[^>]+>/g, '').slice(0, 900),
  url: `${BASE}/details/${doc.identifier}`,
});

/** O Archive indexa por palavra solta; aspas viram busca de frase e derrubam o recall. */
const escapeQuery = (q: string): string => q.replace(/[:"()[\]{}~^\\]/g, ' ').trim();

async function search(f: SearchFilters): Promise<{ items: SeriesCard[]; total?: number }> {
  const scope = `collection:(${SCOPE.join(' OR ')}) AND mediatype:texts`;
  // o titulo TEM de casar com uma serie livre; a busca do usuario so' restringe mais
  const allowed = `title:(${seriesList().map((s) => `"${s}"`).join(' OR ')})`;
  const blocked = `NOT title:(${MODERN_FRANCHISES.map((s) => `"${s}"`).join(' OR ')})`;
  const term = escapeQuery(f.q ?? '');
  const base = `${scope} AND ${allowed} AND ${blocked}`;
  const q = term ? `${base} AND title:(${term})` : base;
  const limit = Math.min(f.limit ?? 24, 100);
  const page = Math.max(f.page ?? 1, 1);
  const sort = f.sort === 'year' ? 'year' : f.sort === 'title' ? 'titleSorter' : 'downloads';
  const url =
    `${BASE}/advancedsearch.php?q=${encodeURIComponent(q)}` +
    ['identifier', 'title', 'year', 'creator', 'description', 'subject'].map((k) => `&fl[]=${k}`).join('') +
    `&rows=${limit}&page=${page}&output=json&sort[]=${sort}+${f.order === 'asc' ? 'asc' : 'desc'}`;

  const data = await getJson<{ response?: { numFound?: number; docs?: SearchDoc[] } }>(url);
  // segunda barreira: o parser do Archive as vezes afrouxa o NOT, entao o corte
  // final acontece aqui, sobre o titulo que voltou de fato
  const items = (data.response?.docs ?? [])
    .map(cardOf)
    .filter((item) => !isModern(item.title));
  return { items, total: data.response?.numFound };
}

interface Metadata {
  metadata?: { title?: string | string[]; year?: number; creator?: string | string[]; description?: string | string[]; subject?: string | string[] };
  files?: { name: string; format?: string }[];
}

/** Cada item do Archive e' uma edicao fechada: vira uma obra com um capitulo so'. */
async function series(id: string): Promise<SeriesDetail> {
  const meta = await getJson<Metadata>(`${BASE}/metadata/${encodeURIComponent(id)}`);
  if (!meta.metadata) throw new Error(`item ${id} nao existe no Archive`);
  const card = cardOf({ identifier: id, ...meta.metadata } as SearchDoc);
  const chapter: ChapterRef = {
    id,
    provider: 'archive',
    seriesId: id,
    title: 'Edicao completa',
    lang: 'en',
    number: '1',
  };
  return { ...card, authors: listOf(meta.metadata.creator), chapters: [chapter], availableLangs: ['en'] };
}

/**
 * O numero de paginas vem do scandata do proprio item; sem ele nao da' para saber
 * onde a edicao termina e o leitor pediria pagina inexistente ate' o 404.
 */
async function pageCount(id: string): Promise<number> {
  const meta = await getJson<Metadata>(`${BASE}/metadata/${encodeURIComponent(id)}`);
  // scandata e' o mais barato; nem toda edicao tem, e ai o djvu.xml serve de reserva
  const sources: { name: string; marker: RegExp }[] = [];
  const scandata = meta.files?.find((f) => f.name.endsWith('_scandata.xml'));
  const djvu = meta.files?.find((f) => f.name.endsWith('_djvu.xml'));
  if (scandata) sources.push({ name: scandata.name, marker: /<page\b/g });
  if (djvu) sources.push({ name: djvu.name, marker: /<OBJECT\b/g });

  for (const src of sources) {
    const res = await httpFetch(`${BASE}/download/${encodeURIComponent(id)}/${src.name}`, { timeoutMs: 30_000 });
    if (!res.ok) continue;
    const count = ((await res.text()).match(src.marker) ?? []).length;
    if (count > 0) return count;
  }
  throw new Error(`item ${id} nao expoe contagem de paginas`);
}

async function pages(chapterId: string): Promise<PageRef[]> {
  const count = await cached(`archive:pages:${chapterId}`, defaultTtl(), () => pageCount(chapterId));
  return Array.from({ length: count }, (_, i) => ({
    url: `${BASE}/download/${encodeURIComponent(chapterId)}/page/n${i}_w1600.jpg`,
  }));
}

registerImageHost('archive.org');

export const archive: Provider = {
  id: 'archive',
  name: 'Internet Archive (HQ dominio publico)',
  kind: 'online',
  contentType: 'hq',
  supports: ['q', 'page', 'limit', 'sort', 'order'],
  languages: ['en'],
  search,
  series,
  pages,
};
