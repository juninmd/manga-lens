export interface SearchFilters {
  q?: string;
  /** idioma da traducao publicada (pt-br, en, ja...) */
  langs?: string[];
  /** idioma original da obra (ja, ko, zh, en) — define o pipeline de OCR */
  origin?: string[];
  includeTags?: string[];
  excludeTags?: string[];
  status?: string[];
  demographic?: string[];
  contentRating?: string[];
  type?: string[];
  yearFrom?: number;
  yearTo?: number;
  sort?: 'relevance' | 'latest' | 'rating' | 'follows' | 'title' | 'year';
  order?: 'asc' | 'desc';
  page?: number;
  limit?: number;
}

export interface SeriesCard {
  id: string;
  provider: string;
  title: string;
  altTitles?: string[];
  cover?: string;
  coverReferer?: string;
  year?: number;
  status?: string;
  /** idioma original — usado para escolher os idiomas do OCR */
  origin?: string;
  type?: string;
  demographic?: string;
  contentRating?: string;
  rating?: number;
  follows?: number;
  tags?: string[];
  description?: string;
  url?: string;
}

export interface ChapterRef {
  id: string;
  provider: string;
  seriesId: string;
  number?: string;
  volume?: string;
  title?: string;
  lang?: string;
  group?: string;
  pages?: number;
  publishedAt?: string;
}

export interface SeriesDetail extends SeriesCard {
  authors?: string[];
  chapters: ChapterRef[];
  /** idiomas de traducao disponiveis neste titulo */
  availableLangs?: string[];
}

export interface PageRef {
  url: string;
  referer?: string;
  width?: number;
  height?: number;
}

export interface TagInfo {
  id: string;
  name: string;
  group?: string;
}

export interface Provider {
  id: string;
  name: string;
  kind: 'online' | 'local';
  /** filtros que este provider realmente aplica no upstream */
  supports: Array<keyof SearchFilters>;
  languages?: string[];
  tags?(): Promise<TagInfo[]>;
  search(f: SearchFilters): Promise<{ items: SeriesCard[]; total?: number }>;
  series(id: string): Promise<SeriesDetail>;
  pages(chapterId: string): Promise<PageRef[]>;
}
