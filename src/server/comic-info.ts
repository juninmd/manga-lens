/**
 * ComicInfo.xml e' o padrao de metadados que acompanha CBZ/CBR desde o ComicRack;
 * Calibre, Komga, Kavita e os scrapers de HQ gravam ele. Ler daqui e' melhor que
 * adivinhar pelo nome do arquivo: o campo `Manga` diz o sentido de leitura, que e'
 * a diferenca pratica entre abrir uma HQ e abrir um manga.
 */
export interface ComicInfo {
  series?: string;
  number?: string;
  volume?: string;
  title?: string;
  summary?: string;
  year?: number;
  writer?: string;
  publisher?: string;
  genres?: string[];
  /** idioma da edicao (ISO-639), como o arquivo declara */
  lang?: string;
  /** `Manga` = YesAndRightToLeft: le da direita para a esquerda. `undefined` = nao declarado */
  rtl?: boolean;
  /** `Manga` = Yes/YesAndRightToLeft. `undefined` = o arquivo nao diz, nao "e' HQ" */
  manga?: boolean;
  pageCount?: number;
}

/** Nome da entrada dentro do arquivo, em qualquer caixa e em qualquer pasta. */
export const COMIC_INFO_RE = /(^|\/)comicinfo\.xml$/i;

const unescapeXml = (s: string): string =>
  s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, '&');

/**
 * Leitor proprio em vez de parser de XML: o ComicInfo e' plano (um nivel de
 * elementos de texto sob <ComicInfo>) e trazer uma dependencia de XML para ler
 * uma dezena de campos custaria mais que o que resolve.
 */
function field(xml: string, name: string): string | undefined {
  // `\\s` e nao `\\b`: dentro de template literal `\b` e' o caractere de backspace,
  // nao a borda de palavra do regex — a busca nunca casava com <Series attr="...">
  const m = new RegExp(`<${name}(?:\\s[^>]*)?>([^]*?)</${name}>`, 'i').exec(xml);
  const value = m?.[1] ? unescapeXml(m[1]).trim() : '';
  return value || undefined;
}

const int = (v: string | undefined): number | undefined => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : undefined;
};

export function parseComicInfo(xml: string): ComicInfo {
  // CDATA no Summary e' comum nos scrapers e levaria o texto do wrapper junto
  const clean = xml.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, (_, inner: string) => inner);
  // ausente e' diferente de "No": ComicInfo minimo (so Series/Number) e' comum, e
  // trata-lo como HQ jogava todo CBZ de manga assim na aba errada, em LTR
  const mangaField = field(clean, 'Manga')?.toLowerCase();
  const genres = (field(clean, 'Genre') ?? '')
    .split(',')
    .map((g) => g.trim())
    .filter(Boolean);
  return {
    series: field(clean, 'Series'),
    number: field(clean, 'Number'),
    volume: field(clean, 'Volume'),
    title: field(clean, 'Title'),
    summary: field(clean, 'Summary'),
    year: int(field(clean, 'Year')),
    writer: field(clean, 'Writer'),
    publisher: field(clean, 'Publisher'),
    genres: genres.length ? genres : undefined,
    lang: field(clean, 'LanguageISO')?.toLowerCase(),
    manga: mangaField === undefined ? undefined : mangaField.startsWith('yes'),
    rtl: mangaField === undefined ? undefined : mangaField === 'yesandrighttoleft',
    pageCount: int(field(clean, 'PageCount')),
  };
}
