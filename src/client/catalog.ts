import {
  aiHealth,
  getAiModels,
  getAiProviders,
  getProviders,
  getSeries,
  getTags,
  saveAiConfig,
  search,
  type AiProviderInfo,
  type AiProviderName,
  type ContentType,
  type ProviderInfo,
  type SearchResponse,
  type SeriesCard,
  type TagInfo,
} from './api.ts';
import { debounce, el, langLabel, STATUS_LABEL, toast } from './ui.ts';
import {
  bookmarks,
  favorites,
  isFavorite,
  persist,
  readCount,
  recentReads,
  store,
  toggleFavorite,
  updateStoredCover,
} from './state.ts';

export interface Filters {
  q: string;
  providers: string[];
  langs: string[];
  origin: string[];
  type: string[];
  status: string[];
  demographic: string[];
  contentRating: string[];
  includeTags: string[];
  excludeTags: string[];
  yearFrom: string;
  yearTo: string;
  sort: string;
  order: string;
  page: number;
}

export const emptyFilters = (): Filters => ({
  q: '',
  providers: [],
  langs: [],
  origin: [],
  type: [],
  status: [],
  demographic: [],
  contentRating: ['safe', 'suggestive'],
  includeTags: [],
  excludeTags: [],
  yearFrom: '',
  yearTo: '',
  sort: '',
  order: '',
  page: 1,
});

const LANGS = ['pt-br', 'en', 'ja', 'es-la', 'es', 'fr', 'it', 'de', 'ru', 'id', 'ko', 'zh'];
const ORIGINS = [
  ['ja', 'Japones (manga)'],
  ['ko', 'Coreano (manhwa)'],
  ['zh', 'Chines (manhua)'],
  ['en', 'Ingles (HQ/OEL)'],
];
const TYPES = [
  ['manga', 'Manga'],
  ['manhwa', 'Manhwa'],
  ['manhua', 'Manhua'],
  ['comic', 'HQ / OEL'],
];
const STATUSES = ['ongoing', 'completed', 'hiatus', 'cancelled'];
const DEMOGRAPHICS = [
  ['shounen', 'Shounen'],
  ['shoujo', 'Shoujo'],
  ['seinen', 'Seinen'],
  ['josei', 'Josei'],
];
const RATINGS = [
  ['safe', 'Seguro'],
  ['suggestive', 'Sugestivo'],
  ['erotica', 'Erotico'],
  ['pornographic', 'Adulto'],
];
const TYPE_TABS: [ContentType, string][] = [
  ['manga', 'Mangá'],
  ['hq', 'HQ'],
  ['livro', 'Livro'],
];
const SORTS = [
  ['', 'Relevancia'],
  ['follows', 'Mais seguidos'],
  ['rating', 'Melhor nota'],
  ['latest', 'Atualizados agora'],
  ['title', 'Titulo A-Z'],
  ['year', 'Ano'],
];

export interface CatalogHandlers {
  onOpenSeries: (provider: string, id: string) => void;
  onResume: (provider: string, seriesId: string) => void;
  onOpenBookmark: (provider: string, seriesId: string, chapterId: string, page: number) => void;
}

export class Catalog {
  private grid!: HTMLElement;
  private statusBar!: HTMLElement;
  private drawer!: HTMLElement;
  private providerModal!: HTMLElement;
  private aiDrawer!: HTMLElement;
  private aiBackdrop!: HTMLElement;
  private aiData?: { active: AiProviderName; providers: AiProviderInfo[] };
  private selectedAiProvider: AiProviderName = 'ollama';
  private providerBtn?: HTMLElement;
  private favBtn?: HTMLElement;
  /** favoritos vivem no localStorage, nao na busca: viram uma listagem propria */
  private showFavorites = false;
  private providers: ProviderInfo[] = [];
  private tags: TagInfo[] = [];
  private typeTabs!: HTMLElement;
  /** cada aba (mangá/HQ/livro) mantém seu próprio filtro e paginação, sem misturar */
  private activeType: ContentType = 'manga';
  private filtersByType: Record<ContentType, Filters> = {
    manga: emptyFilters(),
    hq: emptyFilters(),
    livro: emptyFilters(),
  };
  get filters(): Filters {
    return this.filtersByType[this.activeType];
  }
  set filters(v: Filters) {
    this.filtersByType[this.activeType] = v;
  }
  private loading = false;
  private pending = false;
  private lastResponse?: SearchResponse;

  constructor(private handlers: CatalogHandlers) {}

  async mount(root: HTMLElement): Promise<void> {
    root.innerHTML = '';
    root.append(
      this.buildToolbar(),
      (this.typeTabs = this.buildTypeTabs()),
      this.buildDrawer(),
      this.buildProviderModal(),
      this.buildAiDrawer(),
      this.aiBackdrop,
      (this.statusBar = el('div', { class: 'ml-status' })),
      (this.grid = el('div', { class: 'ml-grid' })),
    );

    this.providers = await getProviders().catch((e) => {
      toast(`falha ao listar providers: ${e.message}`, 'error');
      return [];
    });
    this.renderTypeTabs();
    this.renderProviders();
    void this.loadTags();
    await this.run();

    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      if (this.aiDrawer?.classList.contains('is-open')) this.openAiDrawer(false);
      else if (this.providerModal.classList.contains('is-open')) this.openProviders(false);
      else if (this.drawer.classList.contains('is-open')) this.drawer.classList.remove('is-open');
    });
  }

  private async loadTags(): Promise<void> {
    const online = this.providersOfType(this.activeType)
      .filter((p) => p.kind === 'online')
      .map((p) => p.id);
    const lists = await Promise.all(online.map((p) => getTags(p).catch(() => [] as TagInfo[])));
    const byName = new Map<string, TagInfo>();
    for (const list of lists) for (const t of list) byName.set(t.name.toLowerCase(), t);
    this.tags = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
    this.renderTagPickers();
  }

  // ---------- toolbar ----------

  private buildToolbar(): HTMLElement {
    const input = el('input', {
      class: 'ml-search',
      type: 'search',
      placeholder: 'Buscar manga, manhwa, HQ...',
      value: this.filters.q,
      oninput: debounce((e: Event) => {
        this.filters.q = (e.target as HTMLInputElement).value;
        this.filters.page = 1;
        void this.run();
      }, 420),
    });

    const sort = el(
      'select',
      {
        class: 'ml-select',
        onchange: (e: Event) => {
          this.filters.sort = (e.target as HTMLSelectElement).value;
          this.filters.page = 1;
          void this.run();
        },
      },
      ...SORTS.map(([v, label]) => el('option', { value: v! }, label!)),
    );

    return el(
      'header',
      { class: 'ml-toolbar' },
      el('div', { class: 'ml-brand' }, el('span', { class: 'ml-logo' }, '◧'), 'MangaLens'),
      input,
      sort,
      el('button', { class: 'ml-btn', onclick: () => this.drawer.classList.toggle('is-open') }, 'Filtros'),
      (this.providerBtn = el(
        'button',
        { class: 'ml-btn', onclick: () => this.openProviders(true) },
        'Fontes',
      )),
      el(
        'button',
        {
          class: 'ml-btn ml-btn-ai-config',
          title: 'Configurar Provedores de IA / LLM (Ollama, OpenRouter, OpenAI, Modelos, Endpoints e Tokens)',
          onclick: () => void this.openAiDrawer(true),
        },
        '🤖 IA / LLM',
      ),
      (this.favBtn = el(
        'button',
        {
          class: 'ml-btn',
          title: 'mostrar so os favoritos',
          onclick: () => {
            this.showFavorites = !this.showFavorites;
            this.favBtn?.classList.toggle('is-on', this.showFavorites);
            void this.run();
          },
        },
        '★ Favoritos',
      )),
    );
  }

  private providersOfType(type: ContentType): ProviderInfo[] {
    return this.providers.filter((p) => p.contentType === type);
  }

  /** Provider desconhecido (ex. antes dos providers carregarem) entra por padrão — nunca some da tela. */
  private isActiveType(providerId: string): boolean {
    const p = this.providers.find((x) => x.id === providerId);
    return !p || p.contentType === this.activeType;
  }

  /** Barra de abas Mangá/HQ/Livro — cada uma e' um catalogo independente. */
  private buildTypeTabs(): HTMLElement {
    return el(
      'div',
      { class: 'ml-typetabs' },
      ...TYPE_TABS.map(([type, label]) =>
        el(
          'button',
          {
            class: `ml-typetab ml-typetab-${type}`,
            'data-type': type,
            onclick: () => this.switchType(type),
          },
          label,
        ),
      ),
    );
  }

  private renderTypeTabs(): void {
    for (const btn of this.typeTabs.children) {
      (btn as HTMLElement).classList.toggle('is-on', (btn as HTMLElement).dataset['type'] === this.activeType);
    }
  }

  private switchType(type: ContentType): void {
    if (this.activeType === type) return;
    this.activeType = type;
    this.renderTypeTabs();
    this.renderProviders();
    this.rebuildDrawer();
    void this.loadTags();
    void this.run();
  }

  /** Quantas fontes estao valendo agora — lista vazia significa "todas [do tipo ativo]". */
  private activeProviders(): string[] {
    const pool = this.providersOfType(this.activeType).map((p) => p.id);
    const chosen = this.filters.providers.length
      ? this.filters.providers.filter((id) => pool.includes(id))
      : pool;
    return chosen.length ? chosen : pool;
  }

  private openProviders(open: boolean): void {
    this.providerModal.classList.toggle('is-open', open);
  }

  /**
   * Fontes em modal proprio: como chip na toolbar, a lista crescia junto com os
   * providers e empurrava a busca para fora da barra. Aqui cabe o que o chip nao
   * mostrava — o tipo de cada fonte e quais filtros ela aplica no servidor.
   */
  private buildProviderModal(): HTMLElement {
    this.providerModal = el(
      'div',
      {
        class: 'ml-modal',
        // clicar no fundo fecha; clique dentro do cartao nao pode vazar para ca'
        onclick: (e: Event) => {
          if (e.target === this.providerModal) this.openProviders(false);
        },
      },
      el(
        'div',
        { class: 'ml-modal-card', role: 'dialog', 'aria-label': 'Fontes' },
        el(
          'div',
          { class: 'ml-modal-head' },
          el('strong', {}, 'Fontes'),
          el(
            'button',
            {
              class: 'ml-btn ml-btn-sm ml-btn-ghost',
              onclick: () => {
                this.filters.providers = [];
                this.filters.page = 1;
                this.renderProviders();
                void this.run();
              },
            },
            'Todas',
          ),
          el('button', { class: 'ml-btn ml-btn-ghost', onclick: () => this.openProviders(false) }, '✕'),
        ),
        el('div', { class: 'ml-modal-body', id: 'provider-list' }),
      ),
    );
    return this.providerModal;
  }

  private renderProviders(): void {
    const pool = this.providersOfType(this.activeType);
    const active = new Set(this.activeProviders());
    if (this.providerBtn) {
      const todas = active.size === pool.length;
      this.providerBtn.textContent = todas ? 'Fontes' : `Fontes (${active.size}/${pool.length})`;
      this.providerBtn.classList.toggle('is-on', !todas);
    }

    const host = this.providerModal?.querySelector('#provider-list');
    if (!host) return;
    host.innerHTML = '';

    for (const p of pool) {
      const on = active.has(p.id);
      host.append(
        el(
          'button',
          {
            class: `ml-source ${on ? 'is-on' : ''}`,
            onclick: () => {
              const set = new Set(this.activeProviders());
              if (set.has(p.id)) set.delete(p.id);
              else set.add(p.id);
              // nenhuma marcada nao pode virar busca vazia: volta a valer todas
              if (!set.size) this.filters.providers = [];
              else this.filters.providers = set.size === pool.length ? [] : [...set];
              this.filters.page = 1;
              this.renderProviders();
              void this.run();
            },
          },
          el('span', { class: 'ml-source-mark' }, on ? '✓' : ''),
          el(
            'span',
            { class: 'ml-source-text' },
            el('strong', {}, p.name),
            el(
              'small',
              {},
              `${p.kind === 'local' ? 'biblioteca local' : 'online'} · filtra no servidor: ${
                p.supports.length ? p.supports.join(', ') : 'nada'
              }`,
            ),
          ),
        ),
      );
    }
  }

  // ---------- filtros ----------

  private multi(label: string, options: [string, string][], key: keyof Filters): HTMLElement {
    const current = this.filters[key] as string[];
    return el(
      'div',
      { class: 'ml-field' },
      el('label', {}, label),
      el(
        'div',
        { class: 'ml-chips' },
        ...options.map(([value, text]) =>
          el(
            'button',
            {
              class: `ml-chip ${current.includes(value) ? 'is-on' : ''}`,
              onclick: (e: Event) => {
                const arr = this.filters[key] as string[];
                const i = arr.indexOf(value);
                if (i >= 0) arr.splice(i, 1);
                else arr.push(value);
                (e.currentTarget as HTMLElement).classList.toggle('is-on');
                this.filters.page = 1;
                void this.run();
              },
            },
            text,
          ),
        ),
      ),
    );
  }

  private buildDrawer(): HTMLElement {
    this.drawer = el(
      'aside',
      { class: 'ml-drawer' },
      el(
        'div',
        { class: 'ml-drawer-head' },
        el('strong', {}, 'Filtro completo'),
        el(
          'button',
          {
            class: 'ml-btn ml-btn-ghost',
            onclick: () => {
              this.filters = emptyFilters();
              this.rebuildDrawer();
              this.renderProviders();
              void this.run();
            },
          },
          'Limpar',
        ),
        el('button', { class: 'ml-btn ml-btn-ghost', onclick: () => this.drawer.classList.remove('is-open') }, '✕'),
      ),
      el('div', { class: 'ml-drawer-body' }),
    );
    this.rebuildDrawer();
    return this.drawer;
  }

  private rebuildDrawer(): void {
    const body = this.drawer.querySelector('.ml-drawer-body');
    if (!body) return;
    body.innerHTML = '';
    body.append(
      this.multi(
        'Idioma da traducao',
        LANGS.map((l) => [l, langLabel(l)] as [string, string]),
        'langs',
      ),
      this.multi('Idioma original', ORIGINS as [string, string][], 'origin'),
      this.multi('Tipo', TYPES as [string, string][], 'type'),
      this.multi(
        'Status',
        STATUSES.map((s) => [s, STATUS_LABEL[s] ?? s] as [string, string]),
        'status',
      ),
      this.multi('Demografia', DEMOGRAPHICS as [string, string][], 'demographic'),
      this.multi('Classificacao', RATINGS as [string, string][], 'contentRating'),
      el(
        'div',
        { class: 'ml-field ml-field-row' },
        el('label', {}, 'Ano'),
        el('input', {
          class: 'ml-input',
          type: 'number',
          placeholder: 'de',
          value: this.filters.yearFrom,
          oninput: debounce((e: Event) => {
            this.filters.yearFrom = (e.target as HTMLInputElement).value;
            void this.run();
          }, 500),
        }),
        el('input', {
          class: 'ml-input',
          type: 'number',
          placeholder: 'ate',
          value: this.filters.yearTo,
          oninput: debounce((e: Event) => {
            this.filters.yearTo = (e.target as HTMLInputElement).value;
            void this.run();
          }, 500),
        }),
      ),
      el(
        'div',
        { class: 'ml-field' },
        el('label', {}, 'Ordem'),
        el(
          'div',
          { class: 'ml-chips' },
          el(
            'button',
            {
              class: `ml-chip ${this.filters.order !== 'asc' ? 'is-on' : ''}`,
              onclick: (e: Event) => {
                this.filters.order = this.filters.order === 'asc' ? 'desc' : 'asc';
                (e.currentTarget as HTMLElement).classList.toggle('is-on', this.filters.order !== 'asc');
                void this.run();
              },
            },
            'decrescente / crescente',
          ),
        ),
      ),
      el('div', { class: 'ml-field', id: 'tags-include' }),
      el('div', { class: 'ml-field', id: 'tags-exclude' }),
    );
    this.renderTagPickers();
  }

  private renderTagPickers(): void {
    for (const [id, key, label] of [
      ['#tags-include', 'includeTags', 'Incluir tags'],
      ['#tags-exclude', 'excludeTags', 'Excluir tags'],
    ] as const) {
      const host = this.drawer.querySelector(id);
      if (!host) continue;
      host.innerHTML = '';
      const chips = el('div', { class: 'ml-chips ml-chips-scroll' });
      const filterInput = el('input', {
        class: 'ml-input',
        placeholder: 'filtrar tags...',
        oninput: (e: Event) => {
          const term = (e.target as HTMLInputElement).value.toLowerCase();
          for (const c of chips.children) {
            (c as HTMLElement).hidden = Boolean(term) && !(c.textContent ?? '').toLowerCase().includes(term);
          }
        },
      });
      for (const t of this.tags) {
        chips.append(
          el(
            'button',
            {
              class: `ml-chip ${(this.filters[key] as string[]).includes(t.name) ? 'is-on' : ''}`,
              onclick: (e: Event) => {
                const arr = this.filters[key] as string[];
                const i = arr.indexOf(t.name);
                if (i >= 0) arr.splice(i, 1);
                else arr.push(t.name);
                (e.currentTarget as HTMLElement).classList.toggle('is-on');
                this.filters.page = 1;
                void this.run();
              },
            },
            t.name,
          ),
        );
      }
      host.append(el('label', {}, label), filterInput, chips);
    }
  }

  // ---------- busca ----------

  toParams(): URLSearchParams {
    const f = this.filters;
    const p = new URLSearchParams();
    const put = (k: string, v: string | number | string[]): void => {
      const s = Array.isArray(v) ? v.join(',') : String(v);
      if (s) p.set(k, s);
    };
    put('q', f.q);
    put('contentType', this.activeType);
    put('providers', f.providers);
    put('langs', f.langs);
    put('origin', f.origin);
    put('type', f.type);
    put('status', f.status);
    put('demographic', f.demographic);
    put('contentRating', f.contentRating);
    put('includeTags', f.includeTags);
    put('excludeTags', f.excludeTags);
    put('yearFrom', f.yearFrom);
    put('yearTo', f.yearTo);
    put('sort', f.sort);
    put('order', f.order);
    put('page', f.page);
    return p;
  }

  async run(): Promise<void> {
    // Sem a repescagem, um filtro clicado durante a busca em voo era simplesmente perdido.
    if (this.loading) {
      this.pending = true;
      return;
    }
    // favorito nao vem da busca: ele vive no localStorage e pode nem estar no
    // resultado atual, entao filtrar a resposta deixaria a lista incompleta
    if (this.showFavorites) {
      this.renderFavorites();
      return;
    }

    this.loading = true;
    // resultado anterior fica visivel (so' esmaece) — sem o susto do grid vazio
    // toda vez que um filtro e' clicado
    this.grid.classList.add('is-loading');
    this.statusBar.innerHTML = '';
    this.statusBar.append(el('div', { class: 'ml-spinner ml-spinner-sm' }), el('span', {}, 'buscando...'));
    try {
      const res = await search(this.toParams());
      this.lastResponse = res;
      this.render(res);
    } catch (err) {
      this.statusBar.textContent = `erro na busca: ${(err as Error).message}`;
    } finally {
      this.loading = false;
      this.grid.classList.remove('is-loading');
      if (this.pending) {
        this.pending = false;
        void this.run();
      }
    }
  }

  /** Listagem dos favoritos, montada do proprio armazenamento local. */
  private renderFavorites(): void {
    const list = favorites().filter((f) => this.isActiveType(f.provider));
    this.statusBar.innerHTML = '';
    this.statusBar.append(
      el('span', {}, list.length ? `${list.length} favorito(s)` : 'nenhum favorito ainda'),
    );

    this.grid.innerHTML = '';
    if (!list.length) {
      this.grid.append(
        el('p', { class: 'ml-empty' }, 'Marque a estrela em qualquer titulo para ele aparecer aqui.'),
      );
      return;
    }

    const cards = el('div', { class: 'ml-cards' });
    for (const f of list) {
      cards.append(this.card({ provider: f.provider, id: f.id, title: f.title, cover: f.cover } as SeriesCard));
    }
    this.grid.append(cards);
  }

  private render(res: SearchResponse): void {
    const counts = Object.entries(res.perProvider)
      .map(([k, v]) => `${k}: ${v}`)
      .join(' · ');
    this.statusBar.innerHTML = '';
    this.statusBar.append(
      el('span', {}, `${res.items.length} resultados — ${counts}`),
      ...res.errors.map((e) => el('span', { class: 'ml-status-error' }, `${e.provider}: ${e.message}`)),
    );

    this.grid.innerHTML = '';
    const recent = !this.filters.q && this.filters.page === 1
      ? recentReads().filter((r) => this.isActiveType(r.provider))
      : [];
    if (!this.filters.q && this.filters.page === 1) {
      if (recent.length) {
        this.grid.append(el('h2', { class: 'ml-section' }, 'Continuar lendo'));
        const row = el('div', { class: 'ml-row' });
        for (const r of recent) {
          row.append(
            el(
              'button',
              {
                class: 'ml-resume',
                onclick: () => this.handlers.onResume(r.provider, r.seriesId),
              },
              this.storedCover(r.provider, r.seriesId, r.cover),
              el('span', {}, `${r.title}`),
              el('small', {}, `${r.chapterLabel} · pag. ${r.page + 1}`),
            ),
          );
        }
        this.grid.append(row);
      }

      const marks = bookmarks().filter((m) => this.isActiveType(m.provider));
      if (marks.length) {
        this.grid.append(el('h2', { class: 'ml-section' }, 'Marcadores'));
        const row = el('div', { class: 'ml-row' });
        for (const m of marks.slice(0, 16)) {
          row.append(
            el(
              'button',
              {
                class: 'ml-resume',
                title: `${m.title} — ${m.chapterLabel}, pagina ${m.page + 1}`,
                onclick: () => this.handlers.onOpenBookmark(m.provider, m.seriesId, m.chapterId, m.page),
              },
              this.storedCover(m.provider, m.seriesId, m.cover),
              el('span', {}, m.title),
              el('small', {}, `🔖 ${m.chapterLabel} · pag. ${m.page + 1}`),
            ),
          );
        }
        this.grid.append(row);
      }

      const favs = favorites().filter((f) => this.isActiveType(f.provider));
      if (favs.length) {
        this.grid.append(el('h2', { class: 'ml-section' }, 'Favoritos'));
        const row = el('div', { class: 'ml-row' });
        for (const f of favs.slice(0, 16)) {
          row.append(
            el(
              'button',
              {
                class: 'ml-resume',
                title: f.title,
                onclick: () => this.handlers.onOpenSeries(f.provider, f.id),
              },
              this.storedCover(f.provider, f.id, f.cover),
              el('span', {}, f.title),
              el('small', {}, `★ ${f.provider}`),
            ),
          );
        }
        this.grid.append(row);
      }

      if (recent.length || marks.length || favs.length) {
        this.grid.append(el('h2', { class: 'ml-section' }, 'Catalogo'));
      }
    }

    const cards = el('div', { class: 'ml-cards' });
    for (const item of res.items) cards.append(this.card(item));
    this.grid.append(cards);

    this.grid.append(
      el(
        'div',
        { class: 'ml-pager' },
        el(
          'button',
          {
            class: 'ml-btn',
            disabled: this.filters.page <= 1,
            onclick: () => {
              this.filters.page--;
              void this.run();
              window.scrollTo({ top: 0, behavior: 'smooth' });
            },
          },
          '‹ anterior',
        ),
        el('span', {}, `pagina ${this.filters.page}`),
        el(
          'button',
          {
            class: 'ml-btn',
            disabled: res.items.length === 0,
            onclick: () => {
              this.filters.page++;
              void this.run();
              window.scrollTo({ top: 0, behavior: 'smooth' });
            },
          },
          'proxima ›',
        ),
      ),
    );
  }

  /**
   * Capa vinda do armazenamento local. Ela foi salva JA assinada, e assinatura de
   * um servidor antigo responde 403 para sempre: sem reparo o favorito ficaria
   * sem imagem ate' o usuario desfavoritar e favoritar de novo. No erro, busca a
   * serie de novo, troca a imagem e regrava — uma vez so' por obra.
   */
  private storedCover(provider: string, id: string, cover: string | undefined): HTMLElement {
    if (!cover) return el('div', { class: 'ml-nocover' });
    const img = el('img', { src: cover, loading: 'lazy', alt: '' });
    img.addEventListener('error', () => void this.healCover(provider, id, img), { once: true });
    return img;
  }

  private async healCover(provider: string, id: string, img: HTMLImageElement): Promise<void> {
    const fresh = await getSeries(provider, id)
      .then((d) => d.cover)
      .catch(() => undefined);
    // mesma URL de volta significa que a capa em si morreu, nao a assinatura:
    // reatribuir dispararia o erro outra vez, em laco
    if (!fresh || fresh === img.getAttribute('src')) {
      img.replaceWith(el('div', { class: 'ml-nocover' }));
      return;
    }
    img.src = fresh;
    updateStoredCover(provider, id, fresh);
  }

  private card(item: SeriesCard): HTMLElement {
    // a busca agregada junta a mesma obra de varios sites; sem `sources` (favoritos,
    // continuar lendo) o proprio card e' a unica origem
    const sources = item.sources?.length
      ? item.sources
      : [{ provider: item.provider, id: item.id, title: item.title }];
    let active = 0;
    const current = (): { provider: string; id: string; title: string } => sources[active]!;

    const fav = el(
      'button',
      {
        class: `ml-fav ${isFavorite(current().provider, current().id) ? 'is-on' : ''}`,
        title: 'favoritar',
        onclick: (e: Event) => {
          e.stopPropagation();
          const src = current();
          const on = toggleFavorite({ provider: src.provider, id: src.id, title: item.title, cover: item.cover });
          (e.currentTarget as HTMLElement).classList.toggle('is-on', on);
        },
      },
      '★',
    );

    const alt = (item.altTitles ?? []).filter((t) => t && t !== item.title).slice(0, 3);
    const badge = el('span', { class: 'ml-badge' }, current().provider);
    const readFlag = el('span', { class: 'ml-read-flag' });

    const tabs = sources.map((src, i) =>
      el(
        'button',
        {
          class: `ml-tab ${i === active ? 'is-on' : ''}`,
          // o titulo exato daquele site: e' o que explica por que os dois casaram
          title: src.title,
          onclick: (e: Event) => {
            e.stopPropagation(); // trocar de fonte nao pode abrir a serie
            active = i;
            sync();
          },
        },
        src.provider,
      ),
    );

    const sync = (): void => {
      const src = current();
      badge.textContent = src.provider;
      fav.classList.toggle('is-on', isFavorite(src.provider, src.id));
      const read = readCount(src.provider, src.id);
      readFlag.textContent = read ? `${read} lidos` : '';
      readFlag.hidden = !read;
      tabs.forEach((t, i) => t.classList.toggle('is-on', i === active));
    };
    sync();

    const open = (): void => this.handlers.onOpenSeries(current().provider, current().id);

    const cover = el('div', { class: `ml-cover ${item.cover ? 'is-loading' : ''}` });
    if (item.cover) {
      const img = el('img', {
        src: item.cover,
        loading: 'lazy',
        alt: item.title,
        // onda no lugar da capa ate' a imagem chegar; some com um fade suave
        onload: (e: Event) => {
          (e.currentTarget as HTMLElement).classList.add('is-loaded');
          cover.classList.remove('is-loading');
        },
        onerror: () => cover.classList.remove('is-loading'),
      });
      // a aba de favoritos monta o card com a capa guardada, que pode ter sido
      // assinada por um servidor antigo — repara uma vez e regrava
      img.addEventListener('error', () => void this.healCover(current().provider, current().id, img), {
        once: true,
      });
      cover.append(img);
    } else {
      cover.append(el('div', { class: 'ml-nocover' }, '?'));
    }
    cover.append(
      fav,
      badge,
      ...(item.rating ? [el('span', { class: 'ml-rating' }, `★ ${item.rating}`)] : []),
      readFlag,
      // titulo tambem sobre a capa: nao some quando a grade fica apertada
      el('div', { class: 'ml-cover-title' }, item.title),
    );

    return el(
      'article',
      {
        class: 'ml-card',
        tabindex: '0',
        title: [item.title, ...alt].join('\n'),
        onclick: open,
        onkeydown: (e: KeyboardEvent) => {
          if (e.key === 'Enter') open();
        },
      },
      cover,
      el('h3', {}, item.title),
      alt.length ? el('p', { class: 'ml-alt' }, alt[0]!) : null,
      el(
        'div',
        { class: 'ml-meta' },
        item.year ? el('span', {}, String(item.year)) : null,
        item.status ? el('span', {}, STATUS_LABEL[item.status] ?? item.status) : null,
        item.type ? el('span', {}, item.type) : null,
      ),
      // uma unica origem nao vira aba: seria ruido em quase todo card
      sources.length > 1 ? el('div', { class: 'ml-tabs' }, ...tabs) : null,
      el('div', { class: 'ml-tags' }, ...(item.tags ?? []).slice(0, 4).map((t) => el('span', {}, t))),
    );
  }

  // ---------- drawer de provedores de IA / LLM ----------

  private buildAiDrawer(): HTMLElement {
    this.aiBackdrop = el('div', {
      class: 'ml-ai-backdrop',
      hidden: true,
      onclick: () => this.openAiDrawer(false),
    });

    this.aiDrawer = el(
      'aside',
      { class: 'ml-drawer ml-ai-drawer' },
      el(
        'div',
        { class: 'ml-drawer-head' },
        el('strong', {}, '🤖 Provedores de IA / LLM'),
        el(
          'button',
          {
            class: 'ml-btn ml-btn-ghost',
            onclick: () => this.openAiDrawer(false),
            title: 'Fechar painel',
          },
          '✕',
        ),
      ),
      el('div', { class: 'ml-drawer-body ml-ai-drawer-body', id: 'ai-drawer-content' }),
    );
    return this.aiDrawer;
  }

  async openAiDrawer(open = true): Promise<void> {
    this.aiDrawer.classList.toggle('is-open', open);
    this.aiBackdrop.classList.toggle('is-open', open);
    this.aiBackdrop.hidden = !open;
    if (open) {
      const container = this.aiDrawer.querySelector('#ai-drawer-content');
      if (container) container.innerHTML = '<div class="ml-loading-note">Carregando provedores de IA...</div>';
      try {
        this.aiData = await getAiProviders();
        if (this.aiData.active) this.selectedAiProvider = this.aiData.active;
      } catch (err) {
        toast(`Erro ao carregar IA: ${(err as Error).message}`, 'error');
      }
      this.renderAiDrawer();
    }
  }

  private renderAiDrawer(): void {
    const container = this.aiDrawer.querySelector('#ai-drawer-content');
    if (!container || !this.aiData) return;
    container.innerHTML = '';

    const currentActive = this.aiData.active;
    const provConfig =
      this.aiData.providers.find((p) => p.id === this.selectedAiProvider) ?? this.aiData.providers[0];
    if (!provConfig) return;

    // Tabs de seleção do provedor
    const tabs = el(
      'div',
      { class: 'ml-ai-tabs' },
      ...this.aiData.providers.map((p) => {
        const isSelected = p.id === this.selectedAiProvider;
        const isActiveDefault = p.id === currentActive;
        const icon = p.id === 'ollama' ? '🦙' : p.id === 'openrouter' ? '🌐' : '⚡';
        return el(
          'button',
          {
            class: `ml-ai-tab ${isSelected ? 'is-selected' : ''} ${isActiveDefault ? 'is-active-provider' : ''}`,
            onclick: () => {
              this.selectedAiProvider = p.id;
              this.renderAiDrawer();
            },
          },
          `${icon} ${p.name}`,
          isActiveDefault ? el('span', { class: 'ml-ai-active-badge' }, 'Padrão') : '',
        );
      }),
    );

    // Header do provedor selecionado
    const isCurrentActive = this.selectedAiProvider === currentActive;
    const activeToggle = el(
      'div',
      { class: 'ml-ai-status-row' },
      el('span', { class: 'ml-ai-subhead' }, `Configuração: ${provConfig.name}`),
      el(
        'button',
        {
          class: `ml-btn ml-btn-sm ${isCurrentActive ? 'is-on' : ''}`,
          onclick: () => {
            if (this.aiData) {
              this.aiData.active = this.selectedAiProvider;
              store.settings.aiProvider = this.selectedAiProvider;
              persist();
              this.renderAiDrawer();
            }
          },
        },
        isCurrentActive ? '✓ Provedor Ativo' : 'Definir como Ativo',
      ),
    );

    // Form inputs
    const baseUrlInput = el('input', {
      class: 'ml-input',
      type: 'text',
      value: provConfig.baseUrl,
      placeholder: provConfig.id === 'ollama' ? 'http://127.0.0.1:11434/v1' : 'https://openrouter.ai/api/v1',
    }) as HTMLInputElement;

    const apiKeyInput = el('input', {
      class: 'ml-input',
      type: 'password',
      value: provConfig.apiKey,
      placeholder: provConfig.id === 'ollama' ? 'opcional para Ollama local' : 'sk-or-v1-...',
    }) as HTMLInputElement;

    const toggleKeyVisibilityBtn = el(
      'button',
      {
        class: 'ml-btn ml-btn-ghost ml-btn-sm',
        title: 'Mostrar / Ocultar chave',
        onclick: (e: MouseEvent) => {
          e.preventDefault();
          apiKeyInput.type = apiKeyInput.type === 'password' ? 'text' : 'password';
        },
      },
      '👁️',
    );

    const modelInput = el('input', {
      class: 'ml-input',
      type: 'text',
      value: provConfig.model,
      placeholder: 'ex: qwen2.5:7b-instruct, meta-llama/llama-3.3-70b-instruct',
    }) as HTMLInputElement;

    const modelSelect = el('select', {
      class: 'ml-select ml-select-sm',
      style: 'display: none; margin-top: 4px;',
      onchange: (e: Event) => {
        const val = (e.target as HTMLSelectElement).value;
        if (val) modelInput.value = val;
      },
    }) as HTMLSelectElement;

    const fetchModelsBtn = el(
      'button',
      {
        class: 'ml-btn ml-btn-sm',
        title: 'Consultar endpoint para listar modelos instalados/disponíveis',
        onclick: async () => {
          fetchModelsBtn.textContent = '⏳ Buscando...';
          try {
            await saveAiConfig({
              provider: this.selectedAiProvider,
              baseUrl: baseUrlInput.value,
              apiKey: apiKeyInput.value,
            });
            const res = await getAiModels(this.selectedAiProvider);
            if (res.ok && res.models?.length) {
              modelSelect.innerHTML = '<option value="">-- Selecionar modelo disponível --</option>';
              for (const m of res.models) {
                const opt = document.createElement('option');
                opt.value = m;
                opt.textContent = m;
                if (m === modelInput.value) opt.selected = true;
                modelSelect.appendChild(opt);
              }
              modelSelect.style.display = 'block';
              toast(`${res.models.length} modelos encontrados!`);
            } else {
              toast('Nenhum modelo retornado pelo endpoint', 'error');
            }
          } catch (err) {
            toast(`Erro ao buscar modelos: ${(err as Error).message}`, 'error');
          } finally {
            fetchModelsBtn.textContent = '🔄 Buscar Modelos';
          }
        },
      },
      '🔄 Buscar Modelos',
    );

    const visionModelInput = el('input', {
      class: 'ml-input',
      type: 'text',
      value: provConfig.visionModel ?? '',
      placeholder: 'ex: llava, qwen2-vl (opcional)',
    }) as HTMLInputElement;

    const testResultEl = el('div', { class: 'ml-ai-test-result', hidden: true });

    const testBtn = el(
      'button',
      {
        class: 'ml-btn ml-btn-sm',
        onclick: async () => {
          testBtn.textContent = '⏳ Testando conexão...';
          testResultEl.hidden = false;
          testResultEl.className = 'ml-ai-test-result ml-ai-testing';
          testResultEl.textContent = 'Enviando requisição ao endpoint...';
          try {
            await saveAiConfig({
              provider: this.selectedAiProvider,
              baseUrl: baseUrlInput.value,
              apiKey: apiKeyInput.value,
              model: modelInput.value,
              visionModel: visionModelInput.value,
            });
            const start = performance.now();
            const health = await aiHealth(this.selectedAiProvider);
            const elapsed = Math.round(performance.now() - start);
            if (health.ok) {
              testResultEl.className = 'ml-ai-test-result ml-ai-success';
              testResultEl.textContent = `🟢 Conexão OK (${elapsed}ms)! Modelo: ${health.model} · ${
                health.models?.length ?? 0
              } modelos encontrados.`;
            } else {
              testResultEl.className = 'ml-ai-test-result ml-ai-error';
              testResultEl.textContent = `🔴 Falha: ${health.error ?? 'sem resposta'}`;
            }
          } catch (err) {
            testResultEl.className = 'ml-ai-test-result ml-ai-error';
            testResultEl.textContent = `🔴 Erro: ${(err as Error).message}`;
          } finally {
            testBtn.textContent = '⚡ Testar Conexão';
          }
        },
      },
      '⚡ Testar Conexão',
    );

    const saveBtn = el(
      'button',
      {
        class: 'ml-btn ml-btn-action-primary',
        style: 'width: 100%; margin-top: 8px;',
        onclick: async () => {
          saveBtn.textContent = '⏳ Salvando...';
          try {
            const updated = await saveAiConfig({
              active: this.aiData?.active,
              provider: this.selectedAiProvider,
              baseUrl: baseUrlInput.value,
              apiKey: apiKeyInput.value,
              model: modelInput.value,
              visionModel: visionModelInput.value,
            });
            this.aiData = updated;
            if (this.aiData.active) {
              store.settings.aiProvider = this.aiData.active;
              persist();
            }
            toast('Configurações de IA salvas com sucesso!');
            this.renderAiDrawer();
          } catch (err) {
            toast(`Erro ao salvar: ${(err as Error).message}`, 'error');
          } finally {
            saveBtn.textContent = '💾 Salvar Configurações';
          }
        },
      },
      '💾 Salvar Configurações',
    );

    // Monta o container
    container.append(
      tabs,
      activeToggle,
      // Endpoint Base URL
      el(
        'div',
        { class: 'ml-field' },
        el('label', {}, 'Endpoint Base URL:'),
        baseUrlInput,
        el(
          'small',
          { class: 'ml-field-hint' },
          provConfig.id === 'ollama'
            ? 'Padrão Ollama local: http://127.0.0.1:11434/v1'
            : provConfig.id === 'openrouter'
            ? 'Padrão OpenRouter: https://openrouter.ai/api/v1'
            : 'Qualquer API compatível com OpenAI (ex: vLLM, LMStudio, FastChat)',
        ),
      ),
      // API Key / Token
      el(
        'div',
        { class: 'ml-field' },
        el('label', {}, 'Chave de API / Token:'),
        el('div', { class: 'ml-input-with-btn' }, apiKeyInput, toggleKeyVisibilityBtn),
        el(
          'small',
          { class: 'ml-field-hint' },
          provConfig.id === 'openrouter'
            ? 'Necessário token da sua conta em openrouter.ai'
            : 'Opcional para servidores locais sem autenticação',
        ),
      ),
      // Modelo Principal
      el(
        'div',
        { class: 'ml-field' },
        el('label', {}, 'Modelo Principal (Tradução e Chat):'),
        el('div', { class: 'ml-input-with-btn' }, modelInput, fetchModelsBtn),
        modelSelect,
      ),
      // Modelo de Visão
      el(
        'div',
        { class: 'ml-field' },
        el('label', {}, 'Modelo de Visão Computacional (Opcional):'),
        visionModelInput,
        el('small', { class: 'ml-field-hint' }, 'Usado pelo botão [🤖 Visão] no leitor (ex: llava, qwen2-vl)'),
      ),
      // Botões de Teste e Salvar
      el('div', { class: 'ml-ai-actions' }, testBtn, testResultEl, saveBtn),
    );
  }

  get response(): SearchResponse | undefined {
    return this.lastResponse;
  }
}
