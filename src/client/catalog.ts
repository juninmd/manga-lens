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
import { debounce, el, langLabel, plural, STATUS_LABEL, toast, TYPE_LABEL } from './ui.ts';
import {
  bookmarks,
  exportStore,
  favorites,
  importStore,
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
  ['manga', 'Manga'],
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
  private drawerBackdrop!: HTMLElement;
  private providerModal!: HTMLElement;
  private aiDrawer!: HTMLElement;
  private aiBackdrop!: HTMLElement;
  private aiData?: { active: AiProviderName; providers: AiProviderInfo[] };
  private selectedAiProvider: AiProviderName = 'ollama';
  private providerBtn?: HTMLElement;
  private providerLabel?: HTMLElement;
  private filtersBtn?: HTMLElement;
  private favBtn?: HTMLElement;
  private searchInput!: HTMLInputElement;
  private sortSelect!: HTMLSelectElement;
  /** quem tinha o foco antes de um drawer/modal abrir — devolvido ao fechar */
  private lastFocus?: HTMLElement;
  /** ticket da busca em voo: resposta de uma busca antiga nao pode pintar por cima da nova */
  private seq = 0;
  private tagsLoading = false;
  private tagsSeq = 0;
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
      this.drawerBackdrop,
      this.buildProviderModal(),
      this.buildAiDrawer(),
      this.aiBackdrop,
      (this.statusBar = el('div', { class: 'ml-status' })),
      (this.grid = el('div', { class: 'ml-grid' })),
    );

    this.providers = await getProviders().catch((e) => {
      toast(`falha ao listar fontes: ${e.message}`, 'error');
      return [];
    });
    this.renderTypeTabs();
    this.renderProviders();
    void this.loadTags();
    await this.run();

    // painel de serie sem capitulos pede "buscar em outras fontes"
    window.addEventListener('ml:search', (e) => {
      const q = (e as CustomEvent<{ q?: string }>).detail?.q ?? '';
      if (this.showFavorites) this.favBtn?.click();
      this.filters.q = q;
      this.filters.providers = [];
      this.filters.page = 1;
      this.syncToolbar();
      this.renderProviders();
      void this.run();
    });

    // `capture`: leitor e painel de serie registram o keydown antes e fecham
    // sincronamente — sem captura, quando este listener rodava eles ja' tinham
    // sumido e o Esc fechava duas camadas de uma vez
    document.addEventListener(
      'keydown',
      (e) => {
        if (e.key !== 'Escape') return;
        // leitor e painel de serie ficam por cima: o Esc deles nao pode fechar o que esta' atras
        if (document.body.classList.contains('is-reading') || document.querySelector('.ml-series.is-open')) return;
        // so' a camada mais alta fecha — um Esc, um overlay
        if (this.aiDrawer?.classList.contains('is-open')) void this.openAiDrawer(false);
        else if (this.providerModal.classList.contains('is-open')) this.openProviders(false);
        else if (this.drawer.classList.contains('is-open')) this.openDrawer(false);
        else return;
        e.stopImmediatePropagation();
      },
      { capture: true },
    );
  }

  /** Guarda o foco atual e leva o foco para o primeiro controle do overlay. */
  private focusInto(overlay: HTMLElement): void {
    this.lastFocus = (document.activeElement as HTMLElement | null) ?? undefined;
    overlay.querySelector<HTMLElement>('button, input, select, textarea')?.focus();
  }

  /** Devolve o foco a quem abriu o overlay (ou ao botao indicado). */
  private restoreFocus(fallback?: HTMLElement): void {
    const target = this.lastFocus?.isConnected ? this.lastFocus : fallback;
    this.lastFocus = undefined;
    target?.focus();
  }

  private async loadTags(): Promise<void> {
    const online = this.providersOfType(this.activeType)
      .filter((p) => p.kind === 'online')
      .map((p) => p.id);
    // trocar de aba rapido deixava duas cargas em voo; a mais lenta gravava as tags da aba errada
    const ticket = ++this.tagsSeq;
    this.tagsLoading = true;
    this.renderTagPickers();
    const lists = await Promise.all(online.map((p) => getTags(p).catch(() => [] as TagInfo[])));
    if (ticket !== this.tagsSeq) return;
    const byName = new Map<string, TagInfo>();
    for (const list of lists) for (const t of list) byName.set(t.name.toLowerCase(), t);
    this.tags = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
    this.tagsLoading = false;
    this.renderTagPickers();
  }

  // ---------- toolbar ----------

  private buildToolbar(): HTMLElement {
    // debounce proprio (nao o de ui.ts) para o Enter poder cancelar o disparo pendente
    let typing: number | undefined;
    const applyQuery = (value: string): void => {
      clearTimeout(typing);
      typing = undefined;
      this.filters.q = value;
      this.filters.page = 1;
      void this.run();
    };
    this.searchInput = el('input', {
      class: 'ml-search',
      type: 'search',
      placeholder: 'Buscar manga, manhwa, HQ...',
      'aria-label': 'Buscar no catalogo',
      value: this.filters.q,
      oninput: (e: Event) => {
        clearTimeout(typing);
        typing = window.setTimeout(() => applyQuery((e.target as HTMLInputElement).value), 420);
      },
      onkeydown: (e: KeyboardEvent) => {
        if (e.key === 'Enter') applyQuery((e.target as HTMLInputElement).value);
      },
    });

    this.sortSelect = el(
      'select',
      {
        class: 'ml-select',
        'aria-label': 'Ordenar por',
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
      this.searchInput,
      this.sortSelect,
      (this.filtersBtn = el(
        'button',
        {
          class: 'ml-btn',
          'aria-label': 'Abrir filtros',
          'aria-expanded': 'false',
          onclick: () => this.openDrawer(!this.drawer.classList.contains('is-open')),
        },
        '☰ ',
        el('span', { class: 'ml-btn-label' }, 'Filtros'),
      )),
      (this.providerBtn = el(
        'button',
        { class: 'ml-btn', 'aria-label': 'Escolher fontes', onclick: () => this.openProviders(true) },
        '⊞ ',
        (this.providerLabel = el('span', { class: 'ml-btn-label' }, 'Fontes')),
      )),
      el(
        'button',
        {
          class: 'ml-btn ml-btn-ai-config',
          title: 'Configurar IA (Ollama, OpenRouter, OpenAI)',
          'aria-label': 'Configurar IA',
          onclick: () => void this.openAiDrawer(true),
        },
        '🤖 ',
        el('span', { class: 'ml-btn-label' }, 'IA'),
      ),
      el(
        'button',
        {
          // acao rara: no celular sai da barra (CSS esconde `.ml-btn-rare`)
          class: 'ml-btn ml-btn-rare',
          title: 'Baixar um arquivo com favoritos, progresso, marcadores e capitulos lidos',
          'aria-label': 'Baixar backup',
          onclick: () => this.exportBackup(),
        },
        '⭳ ',
        el('span', { class: 'ml-btn-label' }, 'Backup'),
      ),
      this.buildImportBackupInput(),
      (this.favBtn = el(
        'button',
        {
          class: 'ml-btn',
          title: 'mostrar so os favoritos',
          'aria-pressed': 'false',
          onclick: () => {
            this.showFavorites = !this.showFavorites;
            this.favBtn?.classList.toggle('is-on', this.showFavorites);
            this.favBtn?.setAttribute('aria-pressed', String(this.showFavorites));
            void this.run();
          },
        },
        '★ ',
        el('span', { class: 'ml-btn-label' }, 'Favoritos'),
      )),
    );
  }

  /** Baixa favoritos/progresso/marcadores/lidos como um `.json` — para levar pra outra maquina. */
  private exportBackup(): void {
    const blob = new Blob([exportStore()], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = el('a', { href: url, download: `manga-lens-backup-${Date.now()}.json` });
    document.body.append(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    toast('Backup baixado');
  }

  /** Input de arquivo escondido pro botao "Importar backup" — evita reinventar file picker. */
  private buildImportBackupInput(): HTMLElement {
    const input = el('input', {
      type: 'file',
      accept: 'application/json',
      style: { display: 'none' },
      onchange: async (e: Event) => {
        const file = (e.target as HTMLInputElement).files?.[0];
        (e.target as HTMLInputElement).value = '';
        if (!file) return;
        // substitui o estado inteiro e recarrega: nao ha' desfazer
        if (!confirm('Substituir favoritos, progresso, marcadores e capitulos lidos atuais pelo backup?')) return;
        const result = importStore(await file.text());
        if (result.ok) {
          toast('Backup importado — recarregando...');
          setTimeout(() => location.reload(), 600);
        } else {
          toast(`Backup invalido: ${result.error}`, 'error');
        }
      },
    });
    return el(
      'label',
      {
        class: 'ml-btn ml-btn-rare',
        title: 'Restaurar favoritos, progresso, marcadores e capitulos lidos de um backup',
        'aria-label': 'Importar backup',
      },
      '⭱ ',
      el('span', { class: 'ml-btn-label' }, 'Importar'),
      input,
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
      { class: 'ml-typetabs', role: 'tablist', 'aria-label': 'Tipo de conteudo' },
      ...TYPE_TABS.map(([type, label]) =>
        el(
          'button',
          {
            class: `ml-typetab ml-typetab-${type}`,
            role: 'tab',
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
      const on = (btn as HTMLElement).dataset['type'] === this.activeType;
      (btn as HTMLElement).classList.toggle('is-on', on);
      btn.setAttribute('aria-selected', String(on));
    }
  }

  /** Caixa de busca e ordenacao sao uma so' para todas as abas: refletem o filtro ativo. */
  private syncToolbar(): void {
    this.searchInput.value = this.filters.q;
    this.sortSelect.value = this.filters.sort;
  }

  private switchType(type: ContentType): void {
    if (this.activeType === type) return;
    this.activeType = type;
    this.renderTypeTabs();
    this.syncToolbar();
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
    if (open) this.focusInto(this.providerModal);
    else this.restoreFocus(this.providerBtn);
  }

  private openDrawer(open: boolean): void {
    this.drawer.classList.toggle('is-open', open);
    this.drawerBackdrop.classList.toggle('is-open', open);
    this.drawerBackdrop.hidden = !open;
    this.filtersBtn?.setAttribute('aria-expanded', String(open));
    if (open) this.focusInto(this.drawer);
    else this.restoreFocus(this.filtersBtn);
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
        { class: 'ml-modal-card', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Fontes' },
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
          el(
            'button',
            { class: 'ml-btn ml-btn-ghost', 'aria-label': 'Fechar fontes', onclick: () => this.openProviders(false) },
            '✕',
          ),
        ),
        el('div', { class: 'ml-modal-body', id: 'provider-list' }),
      ),
    );
    return this.providerModal;
  }

  private syncProviderBtn(): void {
    const pool = this.providersOfType(this.activeType);
    const active = this.activeProviders().length;
    if (!this.providerBtn) return;
    const todas = active === pool.length;
    // so' o rotulo muda: o icone antes dele e' o que sobra na tela estreita
    if (this.providerLabel) this.providerLabel.textContent = todas ? 'Fontes' : `Fontes (${active}/${pool.length})`;
    this.providerBtn.title = todas ? 'todas as fontes' : `${active} de ${pool.length} fontes selecionadas`;
    this.providerBtn.classList.toggle('is-on', !todas);
  }

  /** marcar quatro fontes seguidas nao pode virar quatro buscas: junta os cliques */
  private runAfterSourceToggle = debounce(() => void this.run(), 400);

  private renderProviders(): void {
    const pool = this.providersOfType(this.activeType);
    const active = new Set(this.activeProviders());
    this.syncProviderBtn();

    const host = this.providerModal?.querySelector('#provider-list');
    if (!host) return;
    host.innerHTML = '';

    for (const p of pool) {
      const on = active.has(p.id);
      const mark = el('span', { class: 'ml-source-mark' }, on ? '✓' : '');
      host.append(
        el(
          'button',
          {
            class: `ml-source ${on ? 'is-on' : ''}`,
            'aria-pressed': String(on),
            onclick: (e: Event) => {
              const set = new Set(this.activeProviders());
              if (set.has(p.id)) set.delete(p.id);
              else set.add(p.id);
              // nenhuma marcada nao pode virar busca vazia: volta a valer todas
              if (!set.size) this.filters.providers = [];
              else this.filters.providers = set.size === pool.length ? [] : [...set];
              this.filters.page = 1;
              // so' o botao clicado muda: reconstruir a lista jogava o scroll do modal ao topo
              const nowOn = this.activeProviders().includes(p.id);
              const btn = e.currentTarget as HTMLElement;
              btn.classList.toggle('is-on', nowOn);
              btn.setAttribute('aria-pressed', String(nowOn));
              mark.textContent = nowOn ? '✓' : '';
              // "nenhuma" virou "todas": as outras tambem acendem
              if (!set.size) this.renderProviders();
              this.syncProviderBtn();
              this.runAfterSourceToggle();
            },
          },
          mark,
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
    // sem LOCAL_LIBRARY o provider local nem aparece: o recurso ficava invisivel
    if (!pool.some((p) => p.kind === 'local') && !this.providers.some((p) => p.kind === 'local')) {
      host.append(
        el(
          'p',
          { class: 'ml-field-hint' },
          'Biblioteca local (CBZ/pastas): desativada. Defina LOCAL_LIBRARY=<pasta> no ambiente do servidor e reinicie para ler arquivos do computador.',
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
              'aria-pressed': String(current.includes(value)),
              onclick: (e: Event) => {
                const arr = this.filters[key] as string[];
                const i = arr.indexOf(value);
                if (i >= 0) arr.splice(i, 1);
                else arr.push(value);
                const on = (e.currentTarget as HTMLElement).classList.toggle('is-on');
                (e.currentTarget as HTMLElement).setAttribute('aria-pressed', String(on));
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
    this.drawerBackdrop = el('div', {
      class: 'ml-drawer-backdrop',
      hidden: true,
      onclick: () => this.openDrawer(false),
    });
    this.drawer = el(
      'aside',
      { class: 'ml-drawer', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Filtro completo' },
      el(
        'div',
        { class: 'ml-drawer-head' },
        el('strong', {}, 'Filtro completo'),
        el(
          'button',
          {
            class: 'ml-btn ml-btn-ghost',
            onclick: () => this.clearFilters(),
          },
          'Limpar',
        ),
        el(
          'button',
          { class: 'ml-btn ml-btn-ghost', 'aria-label': 'Fechar filtros', onclick: () => this.openDrawer(false) },
          '✕',
        ),
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
            this.filters.page = 1;
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
            this.filters.page = 1;
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
              'aria-pressed': String(this.filters.order !== 'asc'),
              onclick: (e: Event) => {
                this.filters.order = this.filters.order === 'asc' ? 'desc' : 'asc';
                const desc = this.filters.order !== 'asc';
                (e.currentTarget as HTMLElement).classList.toggle('is-on', desc);
                (e.currentTarget as HTMLElement).setAttribute('aria-pressed', String(desc));
                this.filters.page = 1;
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
        const on = (this.filters[key] as string[]).includes(t.name);
        chips.append(
          el(
            'button',
            {
              class: `ml-chip ${on ? 'is-on' : ''}`,
              'aria-pressed': String(on),
              onclick: (e: Event) => {
                const arr = this.filters[key] as string[];
                const i = arr.indexOf(t.name);
                if (i >= 0) arr.splice(i, 1);
                else arr.push(t.name);
                const nowOn = (e.currentTarget as HTMLElement).classList.toggle('is-on');
                (e.currentTarget as HTMLElement).setAttribute('aria-pressed', String(nowOn));
                this.filters.page = 1;
                void this.run();
              },
            },
            t.name,
          ),
        );
      }
      // sem isso o campo aparecia vazio e nao dava para saber se ainda vinha algo
      if (!this.tags.length) {
        chips.append(
          el('small', { class: 'ml-field-hint' }, this.tagsLoading ? 'carregando tags...' : 'esta fonte nao expoe tags'),
        );
      }
      host.append(el('label', {}, label), filterInput, chips);
    }
  }

  // ---------- busca ----------

  /** Nenhum filtro alem do padrao (paginacao nao conta). */
  private isDefaultFilters(): boolean {
    const base = emptyFilters();
    const norm = (v: unknown): string => (Array.isArray(v) ? [...v].sort().join(',') : String(v));
    return (Object.keys(base) as (keyof Filters)[]).every((k) => {
      if (k === 'page') return true;
      // o chip de ordem alterna asc/desc e nunca volta a '': desc e' o padrao
      if (k === 'order') return this.filters.order === '' || this.filters.order === 'desc';
      return norm(this.filters[k]) === norm(base[k]);
    });
  }

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
    // favorito nao vem da busca: ele vive no localStorage e pode nem estar no
    // resultado atual, entao filtrar a resposta deixaria a lista incompleta.
    // Vem antes do `loading`: a lista e' local, nao precisa esperar busca nenhuma.
    if (this.showFavorites) {
      // uma busca em voo nao pode pintar por cima dos favoritos quando voltar
      this.seq++;
      this.pending = false;
      this.renderFavorites();
      return;
    }
    // Sem a repescagem, um filtro clicado durante a busca em voo era simplesmente perdido.
    if (this.loading) {
      this.pending = true;
      return;
    }

    this.loading = true;
    const ticket = ++this.seq;
    // resultado anterior fica visivel (so' esmaece) — sem o susto do grid vazio
    // toda vez que um filtro e' clicado
    this.grid.classList.add('is-loading');
    this.statusBar.innerHTML = '';
    const q = this.filters.q.trim();
    this.statusBar.append(
      el('div', { class: 'ml-spinner ml-spinner-sm' }),
      el('span', {}, q ? `buscando "${q}"...` : 'buscando...'),
    );
    try {
      const res = await search(this.toParams());
      // aba/filtro mudou enquanto esperava (`pending`) ou favoritos entraram na
      // frente (`seq`): a resposta e' de outra busca, o `finally` refaz a certa
      if (ticket !== this.seq || this.pending) return;
      this.lastResponse = res;
      this.render(res);
    } catch (err) {
      if (ticket !== this.seq || this.pending) return;
      this.statusBar.innerHTML = '';
      this.statusBar.append(
        el('span', { class: 'ml-status-error' }, `erro na busca: ${(err as Error).message}`),
        el('button', { class: 'ml-btn ml-btn-sm', onclick: () => void this.run() }, 'tentar de novo'),
      );
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
  private clearFilters(): void {
    this.filters = emptyFilters();
    this.syncToolbar();
    this.rebuildDrawer();
    this.renderProviders();
    void this.run();
  }

  /** Grade vazia sem explicacao parecia bug: diz o que houve e oferece a saida. */
  private emptyState(text: string, action?: { label: string; onclick: () => void }): HTMLElement {
    return el(
      'div',
      { class: 'ml-empty', role: 'status' },
      el('p', {}, text),
      action ? el('button', { class: 'ml-btn ml-btn-sm', onclick: action.onclick }, action.label) : null,
    );
  }

  private renderFavorites(): void {
    const list = favorites().filter((f) => this.isActiveType(f.provider));
    this.statusBar.innerHTML = '';
    this.statusBar.append(
      el('span', {}, list.length ? plural(list.length, 'favorito') : 'nenhum favorito ainda'),
    );

    this.grid.innerHTML = '';
    if (!list.length) {
      this.grid.append(
        this.emptyState('nenhum favorito ainda — toque na ★ de uma obra para ela aparecer aqui.', {
          label: 'ver o catalogo',
          onclick: () => this.favBtn?.click(),
        }),
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
      // por fonte fica no title e some no celular: quebrava em duas linhas
      el('span', { title: counts }, plural(res.items.length, 'resultado'), el('span', { class: 'ml-status-detail' }, ` — ${counts}`)),
      ...res.errors.map((e) => el('span', { class: 'ml-status-error' }, `${e.provider}: ${e.message}`)),
    );

    this.grid.innerHTML = '';
    // "continuar lendo"/marcadores/favoritos so' na home de verdade: com qualquer
    // filtro ativo eles empurravam o resultado para baixo da dobra
    const home = this.filters.page === 1 && this.isDefaultFilters();
    const recent = home ? recentReads((r) => this.isActiveType(r.provider)) : [];
    if (home) {
      if (recent.length) {
        this.grid.append(el('h2', { class: 'ml-section' }, 'Continuar lendo'));
        const row = el('div', { class: 'ml-row' });
        for (const r of recent) {
          row.append(
            el(
              'button',
              {
                class: 'ml-resume',
                title: `${r.title} — ${r.chapterLabel}, pagina ${r.page + 1}`,
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

    if (!res.items.length) {
      const selected = this.activeProviders().length;
      if (res.errors.length && res.errors.length >= selected) {
        this.grid.append(
          this.emptyState('todas as fontes falharam — pode ser rede ou o site fora do ar.', {
            label: 'tentar de novo',
            onclick: () => void this.run(),
          }),
        );
      } else if (this.filters.page > 1) {
        this.grid.append(
          this.emptyState('esta pagina esta vazia.', {
            label: 'voltar ao inicio',
            onclick: () => {
              this.filters.page = 1;
              void this.run();
            },
          }),
        );
      } else {
        const q = this.filters.q.trim();
        this.grid.append(
          this.emptyState(
            q ? `nada encontrado para "${q}" — tente outra fonte ou limpe os filtros.` : 'nada encontrado com estes filtros.',
            this.isDefaultFilters() ? undefined : { label: 'limpar filtros', onclick: () => this.clearFilters() },
          ),
        );
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
            // a busca nao devolve total e madara/mangapill nao respeitam `limit`:
            // so' da' para desabilitar quando a pagina veio vazia
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

    const favOn = isFavorite(current().provider, current().id);
    const fav = el(
      'button',
      {
        class: `ml-fav ${favOn ? 'is-on' : ''}`,
        title: favOn ? 'desfavoritar' : 'favoritar',
        'aria-label': favOn ? 'desfavoritar' : 'favoritar',
        'aria-pressed': String(favOn),
        onclick: (e: Event) => {
          e.stopPropagation();
          const src = current();
          const on = toggleFavorite({ provider: src.provider, id: src.id, title: item.title, cover: item.cover });
          sync();
          toast(on ? `★ ${item.title} nos favoritos` : `☆ ${item.title} removido dos favoritos`);
          // na listagem de favoritos o card desfavoritado tem que sumir na hora
          if (this.showFavorites) this.renderFavorites();
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
          'aria-pressed': String(i === active),
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
      const on = isFavorite(src.provider, src.id);
      fav.classList.toggle('is-on', on);
      fav.title = on ? 'desfavoritar' : 'favoritar';
      fav.setAttribute('aria-label', fav.title);
      fav.setAttribute('aria-pressed', String(on));
      const read = readCount(src.provider, src.id);
      readFlag.textContent = read ? plural(read, 'lido') : '';
      readFlag.hidden = !read;
      tabs.forEach((t, i) => {
        t.classList.toggle('is-on', i === active);
        t.setAttribute('aria-pressed', String(i === active));
      });
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
      ...(item.rating
        ? [el('span', { class: 'ml-rating' }, `★ ${item.rating.toLocaleString('pt-BR', { maximumFractionDigits: 1 })}`)]
        : []),
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
          // `article` nao e' botao: Espaco rolaria a pagina em vez de abrir
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            open();
          }
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
        item.type ? el('span', {}, TYPE_LABEL[item.type] ?? item.type) : null,
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
      { class: 'ml-drawer ml-ai-drawer', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Provedores de IA' },
      el(
        'div',
        { class: 'ml-drawer-head' },
        el('strong', {}, '🤖 Provedores de IA / LLM'),
        el(
          'button',
          {
            class: 'ml-btn ml-btn-ghost',
            onclick: () => void this.openAiDrawer(false),
            title: 'Fechar painel',
            'aria-label': 'Fechar painel de IA',
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
    if (open) this.focusInto(this.aiDrawer);
    else this.restoreFocus();
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
          isActiveDefault ? el('span', { class: 'ml-ai-active-badge' }, 'Padrao') : '',
        );
      }),
    );

    // Header do provedor selecionado
    const isCurrentActive = this.selectedAiProvider === currentActive;
    const activeToggle = el(
      'div',
      { class: 'ml-ai-status-row' },
      el('span', { class: 'ml-ai-subhead' }, `Configuracao: ${provConfig.name}`),
      el(
        'button',
        {
          class: `ml-btn ml-btn-sm ${isCurrentActive ? 'is-on' : ''}`,
          'aria-pressed': String(isCurrentActive),
          disabled: isCurrentActive,
          // grava no servidor na hora: so' mudar em memoria deixava a tela dizendo
          // "ativo" enquanto o servidor seguia no provedor antigo
          onclick: async (e: Event) => {
            const btn = e.currentTarget as HTMLButtonElement;
            btn.disabled = true;
            btn.textContent = '⏳ ativando...';
            try {
              this.aiData = await saveAiConfig({ active: this.selectedAiProvider });
              store.settings.aiProvider = this.aiData.active;
              persist();
              toast(`${provConfig.name} agora e o provedor ativo`);
            } catch (err) {
              toast(`Erro ao ativar provedor: ${(err as Error).message}`, 'error');
            } finally {
              this.renderAiDrawer();
            }
          },
        },
        isCurrentActive ? '✓ provedor ativo' : 'usar este provedor',
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
        // o servidor consulta o endpoint com a config gravada: nao tem como listar
        // sem salvar URL/chave antes — o rotulo avisa em vez de esconder isso
        title: 'Salva URL e chave, depois consulta o endpoint para listar os modelos',
        onclick: async () => {
          fetchModelsBtn.disabled = true;
          fetchModelsBtn.textContent = '⏳ buscando...';
          try {
            await saveAiConfig({
              provider: this.selectedAiProvider,
              baseUrl: baseUrlInput.value,
              apiKey: apiKeyInput.value,
            });
            const res = await getAiModels(this.selectedAiProvider);
            if (res.ok && res.models?.length) {
              modelSelect.innerHTML = '<option value="">selecione um modelo</option>';
              for (const m of res.models) {
                const opt = document.createElement('option');
                opt.value = m;
                opt.textContent = m;
                if (m === modelInput.value) opt.selected = true;
                modelSelect.appendChild(opt);
              }
              modelSelect.style.display = 'block';
              toast(plural(res.models.length, 'modelo encontrado', 'modelos encontrados'));
            } else {
              toast('Nenhum modelo retornado pelo endpoint', 'error');
            }
          } catch (err) {
            toast(`Erro ao buscar modelos: ${(err as Error).message}`, 'error');
          } finally {
            fetchModelsBtn.disabled = false;
            fetchModelsBtn.textContent = '🔄 buscar modelos (salva antes)';
          }
        },
      },
      '🔄 buscar modelos (salva antes)',
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
        title: 'Salva a configuracao deste provedor e testa o endpoint',
        onclick: async () => {
          testBtn.disabled = true;
          testBtn.textContent = '⏳ testando conexao...';
          testResultEl.hidden = false;
          testResultEl.className = 'ml-ai-test-result ml-ai-testing';
          testResultEl.textContent = 'enviando requisicao ao endpoint...';
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
              testResultEl.textContent = `🟢 conexao OK (${elapsed}ms). Modelo: ${health.model} · ${plural(
                health.models?.length ?? 0,
                'modelo encontrado',
                'modelos encontrados',
              )}.`;
            } else {
              testResultEl.className = 'ml-ai-test-result ml-ai-error';
              testResultEl.textContent = `🔴 falha: ${health.error ?? 'sem resposta'}`;
            }
          } catch (err) {
            testResultEl.className = 'ml-ai-test-result ml-ai-error';
            testResultEl.textContent = `🔴 erro: ${(err as Error).message}`;
          } finally {
            testBtn.disabled = false;
            testBtn.textContent = '⚡ testar conexao (salva antes)';
          }
        },
      },
      '⚡ testar conexao (salva antes)',
    );

    const saveBtn = el(
      'button',
      {
        class: 'ml-btn ml-btn-action-primary',
        style: 'width: 100%; margin-top: 8px;',
        onclick: async () => {
          saveBtn.disabled = true;
          saveBtn.textContent = '⏳ salvando...';
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
            toast('configuracoes de IA salvas');
            this.renderAiDrawer();
          } catch (err) {
            toast(`Erro ao salvar: ${(err as Error).message}`, 'error');
          } finally {
            saveBtn.disabled = false;
            saveBtn.textContent = '💾 salvar';
          }
        },
      },
      '💾 salvar',
    );

    // Monta o container
    container.append(
      tabs,
      activeToggle,
      // Endpoint Base URL
      el(
        'div',
        { class: 'ml-field' },
        el('label', {}, 'URL base do endpoint'),
        baseUrlInput,
        el(
          'small',
          { class: 'ml-field-hint' },
          provConfig.id === 'ollama'
            ? 'Padrao Ollama local: http://127.0.0.1:11434/v1'
            : provConfig.id === 'openrouter'
            ? 'Padrao OpenRouter: https://openrouter.ai/api/v1'
            : 'Qualquer API compativel com OpenAI (ex: vLLM, LMStudio, FastChat)',
        ),
      ),
      // API Key / Token
      el(
        'div',
        { class: 'ml-field' },
        el('label', {}, 'Chave de API (token)'),
        el('div', { class: 'ml-input-with-btn' }, apiKeyInput, toggleKeyVisibilityBtn),
        el(
          'small',
          { class: 'ml-field-hint' },
          provConfig.id === 'openrouter'
            ? 'Precisa do token da sua conta em openrouter.ai'
            : 'Opcional para servidores locais sem autenticacao',
        ),
      ),
      // Modelo Principal
      el(
        'div',
        { class: 'ml-field' },
        el('label', {}, 'Modelo principal (traducao e chat)'),
        el('div', { class: 'ml-input-with-btn' }, modelInput, fetchModelsBtn),
        modelSelect,
      ),
      // Modelo de Visão
      el(
        'div',
        { class: 'ml-field' },
        el('label', {}, 'Modelo de visao (opcional)'),
        visionModelInput,
        el('small', { class: 'ml-field-hint' }, 'Usado pelo botao "Visao" do leitor (ex: llava, qwen2-vl)'),
      ),
      // Botões de Teste e Salvar
      el('div', { class: 'ml-ai-actions' }, testBtn, testResultEl, saveBtn),
    );
  }

  get response(): SearchResponse | undefined {
    return this.lastResponse;
  }
}
