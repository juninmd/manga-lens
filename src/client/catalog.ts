import { getProviders, getTags, search, type ProviderInfo, type SearchResponse, type SeriesCard, type TagInfo } from './api.ts';
import { debounce, el, langLabel, STATUS_LABEL, toast } from './ui.ts';
import { bookmarks, favorites, isFavorite, readCount, recentReads, toggleFavorite } from './state.ts';

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
  private root!: HTMLElement;
  private grid!: HTMLElement;
  private statusBar!: HTMLElement;
  private drawer!: HTMLElement;
  private providerModal!: HTMLElement;
  private providerBtn?: HTMLElement;
  private favBtn?: HTMLElement;
  /** favoritos vivem no localStorage, nao na busca: viram uma listagem propria */
  private showFavorites = false;
  private providers: ProviderInfo[] = [];
  private tags: TagInfo[] = [];
  filters: Filters = emptyFilters();
  private loading = false;
  private pending = false;
  private lastResponse?: SearchResponse;

  constructor(private handlers: CatalogHandlers) {}

  async mount(root: HTMLElement): Promise<void> {
    this.root = root;
    root.innerHTML = '';
    root.append(
      this.buildToolbar(),
      this.buildDrawer(),
      this.buildProviderModal(),
      (this.statusBar = el('div', { class: 'ml-status' })),
      (this.grid = el('div', { class: 'ml-grid' })),
    );

    this.providers = await getProviders().catch((e) => {
      toast(`falha ao listar providers: ${e.message}`, 'error');
      return [];
    });
    this.renderProviders();
    void this.loadTags();
    await this.run();
  }

  private async loadTags(): Promise<void> {
    const online = this.providers.filter((p) => p.kind === 'online').map((p) => p.id);
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

  /** Quantas fontes estao valendo agora — lista vazia significa "todas". */
  private activeProviders(): string[] {
    return this.filters.providers.length ? this.filters.providers : this.providers.map((p) => p.id);
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
    const active = new Set(this.activeProviders());
    if (this.providerBtn) {
      const todas = active.size === this.providers.length;
      this.providerBtn.textContent = todas ? 'Fontes' : `Fontes (${active.size}/${this.providers.length})`;
      this.providerBtn.classList.toggle('is-on', !todas);
    }

    const host = this.providerModal?.querySelector('#provider-list');
    if (!host) return;
    host.innerHTML = '';

    for (const p of this.providers) {
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
              else this.filters.providers = set.size === this.providers.length ? [] : [...set];
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
    this.statusBar.textContent = 'buscando...';
    try {
      const res = await search(this.toParams());
      this.lastResponse = res;
      this.render(res);
    } catch (err) {
      this.statusBar.textContent = `erro na busca: ${(err as Error).message}`;
    } finally {
      this.loading = false;
      if (this.pending) {
        this.pending = false;
        void this.run();
      }
    }
  }

  /** Listagem dos favoritos, montada do proprio armazenamento local. */
  private renderFavorites(): void {
    const list = favorites();
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
    const recent = !this.filters.q && this.filters.page === 1 ? recentReads() : [];
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
              r.cover ? el('img', { src: r.cover, loading: 'lazy', alt: '' }) : el('div', { class: 'ml-nocover' }),
              el('span', {}, `${r.title}`),
              el('small', {}, `${r.chapterLabel} · pag. ${r.page + 1}`),
            ),
          );
        }
        this.grid.append(row);
      }

      const marks = bookmarks();
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
              m.cover ? el('img', { src: m.cover, loading: 'lazy', alt: '' }) : el('div', { class: 'ml-nocover' }),
              el('span', {}, m.title),
              el('small', {}, `🔖 ${m.chapterLabel} · pag. ${m.page + 1}`),
            ),
          );
        }
        this.grid.append(row);
      }

      const favs = favorites();
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
              f.cover ? el('img', { src: f.cover, loading: 'lazy', alt: '' }) : el('div', { class: 'ml-nocover' }),
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
      el(
        'div',
        { class: 'ml-cover' },
        item.cover
          ? el('img', { src: item.cover, loading: 'lazy', alt: item.title })
          : el('div', { class: 'ml-nocover' }, '?'),
        fav,
        badge,
        item.rating ? el('span', { class: 'ml-rating' }, `★ ${item.rating}`) : null,
        readFlag,
        // titulo tambem sobre a capa: nao some quando a grade fica apertada
        el('div', { class: 'ml-cover-title' }, item.title),
      ),
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

  get response(): SearchResponse | undefined {
    return this.lastResponse;
  }
}
