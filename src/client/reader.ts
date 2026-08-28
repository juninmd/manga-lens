import {
  aiHealth,
  explain,
  getAiProviders,
  getEngines,
  getPages,
  getTargets,
  visionTranslate,
  type ChapterRef,
  type PageRef,
  type SeriesDetail,
  type TargetLangInfo,
  type TranslateEngineInfo,
} from './api.ts';
import { el, langLabel, toast } from './ui.ts';
import {
  hasBookmark,
  markChapterRead,
  persist,
  saveProgress,
  store,
  toggleBookmark,
  type AiProviderName,
  type FitMode,
  type LetterFont,
  type ReadingMode,
  type TranslateEngine,
} from './state.ts';
import { Viewer } from './viewer.ts';
import { langFor, paintPage, recognizePage, translateBlocks, type OcrBlock } from './ocr.ts';

/**
 * Espera a imagem do sheet ficar utilizavel. Ouvir so' `load` era uma armadilha:
 * pagina que responde 404 (ou host bloqueado no proxy) nunca emite `load`, a
 * promessa nunca resolvia e o leitor ficava com `busy = true` para sempre — OCR,
 * traducao e fila morriam no capitulo inteiro ate' recarregar o app.
 */
function imageReady(img: HTMLImageElement, timeoutMs = 20_000): Promise<boolean> {
  if (img.complete) return Promise.resolve(img.naturalWidth > 0);
  return new Promise((resolve) => {
    const done = (ok: boolean): void => {
      clearTimeout(timer);
      img.removeEventListener('load', onLoad);
      img.removeEventListener('error', onError);
      resolve(ok);
    };
    const onLoad = (): void => done(img.naturalWidth > 0);
    const onError = (): void => done(false);
    const timer = window.setTimeout(() => done(false), timeoutMs);
    img.addEventListener('load', onLoad);
    img.addEventListener('error', onError);
  });
}

const MODES: [ReadingMode, string][] = [
  ['single', 'pagina'],
  ['double', 'dupla'],
  ['strip', 'tira'],
];
const FITS: [FitMode, string][] = [
  ['page', 'ajustar'],
  ['width', 'largura'],
  ['height', 'altura'],
];

export class Reader {
  private host = el('section', { class: 'ml-reader' });
  private stage = el('div', { class: 'ml-stage' });
  private stageLoading = el(
    'div',
    { class: 'ml-stage-loading' },
    el('div', { class: 'ml-spinner' }),
    el('span', {}, 'carregando capitulo...'),
  );
  private viewer: Viewer;
  private film = el('div', { class: 'ml-film' });
  private zoomLabel = el('span', { class: 'ml-zoom-label' }, '100%');
  private zoomRange = el('input', { class: 'ml-range', type: 'range', min: '5', max: '600', value: '100' });
  private pageLabel = el('span', { class: 'ml-page-label' }, '');
  private chat = el('aside', { class: 'ml-chat' });
  private chatLog = el('div', { class: 'ml-chat-log' });
  private ocrStatus = el('span', { class: 'ml-ocr-status' }, '');
  private aiDot = el('span', { class: 'ml-dot' });
  private aiLabel = el('span', {}, 'IA: verificando...');
  private tooltipEl = el('div', { class: 'ml-balloon-tooltip', hidden: true });
  private highlightBox = el('div', { class: 'ml-balloon-highlight', hidden: true });
  private popoverEl = el('div', { class: 'ml-popover', hidden: true });
  private popoverBackdrop = el('div', { class: 'ml-popover-backdrop', hidden: true });
  private popoverOpen = false;
  private aiTimer?: number;

  private detail?: SeriesDetail;
  private chapter?: ChapterRef;
  /** sentido efetivo da obra aberta: HQ ocidental le ao contrario de manga */
  private rtl = true;
  private pages: PageRef[] = [];
  private ocrCache = new Map<string, OcrBlock[]>();
  /**
   * Com que motor+idioma cada pagina do cache foi traduzida. Antes, trocar o
   * idioma de destino limpava o cache inteiro e refazia o Tesseract da pagina —
   * a parte cara — sendo que o texto reconhecido continua valendo: so' a traducao
   * envelhece. Com o carimbo, trocar de idioma so' retraduz.
   */
  private translatedAs = new Map<string, string>();
  private busy = false;
  private paintHandle = 0;
  private history: { role: 'user' | 'assistant'; content: string }[] = [];

  private engines: TranslateEngineInfo[] = [{ id: 'auto', name: 'Automatico (sem IA primeiro)', needsAi: false, note: '' }];
  private targets: TargetLangInfo[] = [{ id: 'pt-BR', name: 'Portugues (Brasil)' }];
  private aiProviders: { id: string; name: string; baseUrl: string; model: string; hasKey: boolean }[] = [];

  constructor(private onExit: () => void) {
    this.viewer = new Viewer({
      onPageChange: (p) => this.onPageChange(p),
      onTransform: ({ scale }) => {
        this.zoomLabel.textContent = `${Math.round(scale * 100)}%`;
        this.zoomRange.value = String(Math.round(scale * 100));
        this.hideTooltip();
      },
      onSheetsChange: () => {
        this.paintOverlays();
        this.hideTooltip();
      },
    });
    this.build();
    document.body.append(this.host);
    document.addEventListener('keydown', this.onKey);
    this.popoverBackdrop.addEventListener('click', () => this.togglePopover(false));
    (window as unknown as { __mangaLens?: unknown }).__mangaLens = {
      translatedKeys: (): string[] => [...this.ocrCache.keys()],
      blocksFor: (key: string): OcrBlock[] => this.ocrCache.get(key) ?? [],
    };
    void Promise.all([
      getEngines().catch(() => []),
      getTargets().catch(() => []),
      getAiProviders().catch(() => ({ active: 'ollama' as const, providers: [] })),
    ]).then(([engines, targets, provData]) => {
      if (engines.length) this.engines = engines;
      if (targets.length) this.targets = targets;
      if (provData.providers?.length) {
        this.aiProviders = provData.providers;
        if (!store.settings.aiProvider && provData.active) {
          store.settings.aiProvider = provData.active;
        }
      }
      this.refreshBars();
    });
  }

  // ---------- montagem ----------

  private build(): void {
    this.host.append(this.buildTopBar(), this.stage, this.buildStatusBar(), this.buildBottomBar(), this.chat, this.tooltipEl, this.popoverBackdrop, this.popoverEl);
    this.viewer.mount(this.stage);
    // mount() reescreve o innerHTML do palco — o overlay so' pode entrar depois
    this.stage.append(this.stageLoading);
    this.viewer.mode = store.settings.mode;
    this.viewer.fit = store.settings.fit;
    this.viewer.rtl = store.settings.rtl;

    this.stage.addEventListener('pointermove', this.onStagePointerMove);
    this.stage.addEventListener('pointerleave', this.onStagePointerLeave);

    this.zoomRange.addEventListener('input', () => this.viewer.setZoom(Number(this.zoomRange.value) / 100));
    this.chat.append(
      el(
        'div',
        { class: 'ml-chat-head' },
        el('strong', {}, 'Assistente de leitura'),
        el('button', { class: 'ml-btn ml-btn-ghost', onclick: () => this.chat.classList.remove('is-open') }, '✕'),
      ),
      this.chatLog,
      this.buildChatInput(),
    );
  }

  private onStagePointerMove = (e: PointerEvent): void => {
    this.checkBalloonHover(e.clientX, e.clientY);
  };

  private onStagePointerLeave = (): void => {
    this.hideTooltip();
  };

  private checkBalloonHover(clientX: number, clientY: number): void {
    if (this.viewer.isDragging()) {
      this.hideTooltip();
      return;
    }
    const hit = this.findBlockAt(clientX, clientY);
    if (!hit) {
      this.hideTooltip();
      return;
    }
    this.showTooltip(hit.block, clientX, clientY, hit.sheet);
  }

  private findBlockAt(clientX: number, clientY: number): { block: OcrBlock; sheet: { page: number; el: HTMLDivElement; x: number; y: number; w: number; h: number } } | null {
    const stageRect = this.stage.getBoundingClientRect();
    const stageX = clientX - stageRect.left;
    const stageY = clientY - stageRect.top;

    const transform = this.viewer.getTransform();
    const canvasX = (stageX - transform.tx) / transform.scale;
    const canvasY = (stageY - transform.ty) / transform.scale;

    for (const sheet of this.viewer.getSheets()) {
      if (canvasX >= sheet.x && canvasX <= sheet.x + sheet.w && canvasY >= sheet.y && canvasY <= sheet.y + sheet.h) {
        const imgX = canvasX - sheet.x;
        const imgY = canvasY - sheet.y;
        const blocks = this.ocrCache.get(this.pageKey(sheet.page));
        if (!blocks || !blocks.length) continue;

        for (let i = blocks.length - 1; i >= 0; i--) {
          const b = blocks[i]!;
          if (imgX >= b.x && imgX <= b.x + b.w && imgY >= b.y && imgY <= b.y + b.h) {
            return { block: b, sheet };
          }
        }
      }
    }
    return null;
  }

  private showTooltip(block: OcrBlock, clientX: number, clientY: number, sheet: { el: HTMLDivElement }): void {
    const origText = block.text?.trim();
    if (!origText) {
      this.hideTooltip();
      return;
    }

    this.highlightBox.style.left = `${block.x}px`;
    this.highlightBox.style.top = `${block.y}px`;
    this.highlightBox.style.width = `${block.w}px`;
    this.highlightBox.style.height = `${block.h}px`;
    if (this.highlightBox.parentElement !== sheet.el) {
      sheet.el.append(this.highlightBox);
    }
    this.highlightBox.hidden = false;

    this.tooltipEl.innerHTML = '';
    const header = el(
      'div',
      { class: 'ml-tooltip-header' },
      el('span', { class: 'ml-tooltip-tag' }, 'Texto original'),
      block.confidence ? el('span', { class: 'ml-tooltip-confidence' }, `${Math.round(block.confidence)}% conf.`) : el('span', {}),
    );
    const origEl = el('div', { class: 'ml-tooltip-original' }, origText);
    this.tooltipEl.append(header, origEl);

    if (block.pt && block.pt.trim() && block.pt.trim() !== origText) {
      const transEl = el(
        'div',
        { class: 'ml-tooltip-translated' },
        el('span', { class: 'ml-tooltip-subtag' }, 'Tradução:'),
        block.pt.trim(),
      );
      this.tooltipEl.append(transEl);
    }

    this.tooltipEl.hidden = false;

    const pad = 16;
    const ttW = this.tooltipEl.offsetWidth || 240;
    const ttH = this.tooltipEl.offsetHeight || 80;
    const vpW = window.innerWidth;
    const vpH = window.innerHeight;

    let left = clientX + 16;
    let top = clientY + 16;

    if (left + ttW > vpW - pad) {
      left = Math.max(pad, clientX - ttW - 16);
    }
    if (top + ttH > vpH - pad) {
      top = Math.max(pad, clientY - ttH - 16);
    }

    this.tooltipEl.style.left = `${left}px`;
    this.tooltipEl.style.top = `${top}px`;
  }

  private hideTooltip(): void {
    this.tooltipEl.hidden = true;
    this.highlightBox.hidden = true;
  }

  private toggle(label: string, on: boolean, onclick: () => void, title?: string): HTMLElement {
    return el('button', { class: `ml-btn ml-btn-sm ${on ? 'is-on' : ''}`, title: title ?? label, onclick }, label);
  }

  private togglePopover(open?: boolean): void {
    this.popoverOpen = open !== undefined ? open : !this.popoverOpen;
    this.popoverEl.classList.toggle('is-open', this.popoverOpen);
    this.popoverBackdrop.classList.toggle('is-open', this.popoverOpen);
    this.popoverEl.hidden = !this.popoverOpen;
    this.popoverBackdrop.hidden = !this.popoverOpen;
    const btn = document.getElementById('ml-btn-options');
    if (btn) btn.classList.toggle('is-on', this.popoverOpen);
    if (this.popoverOpen) {
      this.buildPopover();
    }
  }

  private buildTopBar(): HTMLElement {
    const s = store.settings;
    const detectedLang = this.chapter?.lang ?? this.detail?.origin;
    const originName = detectedLang ? langLabel(detectedLang) : 'Auto';
    const originBadge = el('span', { class: 'ml-lang-badge', title: `Idioma original detectado: ${originName}` }, `Origem: ${originName}`);

    const modes = el(
      'div',
      { class: 'ml-group' },
      ...MODES.map(([m, label]) =>
        this.toggle(label, s.mode === m, () => {
          s.mode = m;
          persist();
          this.viewer.setMode(m);
          this.refreshBars();
        }),
      ),
    );
    const fits = el(
      'div',
      { class: 'ml-group' },
      ...FITS.map(([f, label]) =>
        this.toggle(label, s.fit === f, () => {
          s.fit = f;
          persist();
          this.viewer.applyFit(f);
          this.refreshBars();
        }),
      ),
      this.toggle('1:1', false, () => this.viewer.setZoom(1)),
    );
    const rtlBtn = this.toggle('RTL', this.rtl, () => {
      this.rtl = !this.rtl;
      s.rtl = this.rtl;
      persist();
      this.viewer.setRtl(this.rtl);
      this.refreshBars();
    }, 'Sentido de leitura japonês (direita para esquerda)');

    return el(
      'header',
      { class: 'ml-reader-top' },
      // Esquerda: Navegação e Informações
      el(
        'div',
        { class: 'ml-top-left' },
        el('button', { class: 'ml-btn ml-btn-ghost', onclick: () => this.close(), title: 'Voltar ao catálogo' }, '‹ voltar'),
        el('div', { class: 'ml-reader-title', id: 'reader-title' }),
        originBadge,
        this.pageLabel,
      ),
      // Centro: Modos de Leitura/Ajuste + Ações de Tradução
      el(
        'div',
        { class: 'ml-top-center' },
        modes,
        fits,
        rtlBtn,
        el('button', {
          class: 'ml-btn ml-btn-sm ml-btn-action-primary',
          onclick: () => void this.runTranslate(),
          title: 'Traduzir os balões da página atual (Atalho: tecla R)',
        }, '🪄 Traduzir'),
        el('button', {
          class: 'ml-btn ml-btn-sm',
          onclick: () => void this.runOcrOnly(),
          title: 'Executar reconhecimento OCR apenas (Atalho: tecla O)',
        }, '🔍 OCR'),
        this.toggle(
          s.showOriginal ? '👁️ Original: Ligado' : '👁️ Original',
          s.showOriginal,
          () => {
            s.showOriginal = !s.showOriginal;
            persist();
            this.refreshBars();
            this.paintOverlays();
          },
          'Alternar entre exibir o mangá original limpo ou balões traduzidos (Atalho: tecla T)',
        ),
      ),
      // Direita: Configurações, Assistente e Ferramentas
      el(
        'div',
        { class: 'ml-top-right' },
        el('button', {
          id: 'ml-btn-options',
          class: `ml-btn ml-btn-sm ${this.popoverOpen ? 'is-on' : ''}`,
          onclick: (e: MouseEvent) => {
            e.stopPropagation();
            this.togglePopover();
          },
          title: 'Configurações de Tradução (Modo IA, OCR, Provedores, Idiomas e Fontes)',
        }, '⚙️ Opções'),
        el('button', {
          class: 'ml-btn ml-btn-sm',
          onclick: () => void this.visionRead(),
          title: 'IA analisa e descreve a página inteira com visão computacional',
        }, '🤖 Visão'),
        el('button', {
          class: 'ml-btn ml-btn-sm',
          onclick: () => this.chat.classList.toggle('is-open'),
          title: 'Assistente e explicador de mangá',
        }, '💬 Explicar'),
        this.bookmarkButton(),
        el('button', {
          class: 'ml-btn ml-btn-sm',
          onclick: () => void this.toggleFullscreen(),
          title: 'Alternar tela cheia',
        }, '⛶'),
      ),
    );
  }

  private buildPopover(): void {
    const s = store.settings;
    this.popoverEl.innerHTML = '';

    const head = el(
      'div',
      { class: 'ml-popover-head' },
      el('span', { class: 'ml-popover-title' }, 'Configurações de Tradução'),
      el('button', {
        class: 'ml-btn ml-btn-ghost ml-btn-sm',
        onclick: (e: MouseEvent) => {
          e.stopPropagation();
          this.togglePopover(false);
        },
        title: 'Fechar opções',
      }, '✕'),
    );

    const isAi = s.translateMode === 'ai';
    const modeSection = el(
      'div',
      { class: 'ml-popover-section' },
      el('span', { class: 'ml-popover-label' }, 'Modo de Tradução'),
      el(
        'div',
        { class: 'ml-segmented' },
        el('button', {
          class: `ml-segmented-btn ${isAi ? 'is-active' : ''}`,
          onclick: (e: MouseEvent) => {
            e.stopPropagation();
            s.translateMode = 'ai';
            persist();
            this.invalidateTranslations();
            this.buildPopover();
          },
        }, '✨ IA (Contextual)'),
        el('button', {
          class: `ml-segmented-btn ${!isAi ? 'is-active' : ''}`,
          onclick: (e: MouseEvent) => {
            e.stopPropagation();
            s.translateMode = 'ocr';
            persist();
            this.invalidateTranslations();
            this.buildPopover();
          },
        }, '🌐 Tradutor Web'),
      ),
    );

    const providerSection = el(
      'div',
      { class: 'ml-popover-section' },
      el('span', { class: 'ml-popover-label' }, isAi ? 'Provedor de IA' : 'Motor de Tradução'),
      isAi ? this.providerSelect() : this.engineSelect(),
    );

    const targetSection = el(
      'div',
      { class: 'ml-popover-section' },
      el('span', { class: 'ml-popover-label' }, 'Traduzir Para'),
      this.targetSelect(),
    );

    const fontSection = el(
      'div',
      { class: 'ml-popover-section' },
      el('span', { class: 'ml-popover-label' }, 'Estilo da Fonte no Balão'),
      this.fontSelect(),
    );

    this.popoverEl.append(head, modeSection, providerSection, targetSection, fontSection);
  }

  /** Idioma de chegada: vale para os tres motores; trocar reletreira o capitulo. */
  private targetSelect(): HTMLElement {
    return el(
      'select',
      {
        class: 'ml-select ml-select-sm',
        title: 'idioma de destino da traducao',
        onchange: (e: Event) => {
          store.settings.targetLang = (e.target as HTMLSelectElement).value;
          persist();
          this.invalidateTranslations();
        },
      },
      ...this.targets.map((t) =>
        el('option', { value: t.id, selected: t.id === store.settings.targetLang }, t.name),
      ),
    );
  }

  /** Motor de traducao: Google ou MyMemory (modo OCR tradicional). */
  private engineSelect(): HTMLElement {
    const traditionalEngines = this.engines.filter((eng) => eng.id !== 'llm');
    const select = el(
      'select',
      {
        class: 'ml-select ml-select-sm',
        title: 'motor de tradução dos balões (modo OCR tradicional)',
        onchange: (e: Event) => {
          store.settings.engine = (e.target as HTMLSelectElement).value as TranslateEngine;
          persist();
          this.invalidateTranslations();
        },
      },
      ...(traditionalEngines.length ? traditionalEngines : this.engines).map((eng) =>
        el('option', { value: eng.id, selected: eng.id === store.settings.engine, title: eng.note }, eng.name),
      ),
    );
    return select;
  }

  private fontSelect(): HTMLElement {
    const fonts: [LetterFont, string, string][] = [
      ['comic', 'Balão HQ (Quadrinhos)', 'Fonte estilo revista em quadrinhos / mangá'],
      ['sans', 'Moderna (Limpa)', 'Fonte limpa e moderna sem serifa'],
      ['serif', 'Clássica (Livro)', 'Fonte clássica estilo livro impresso'],
    ];
    return el(
      'select',
      {
        class: 'ml-select ml-select-sm',
        title: 'estilo da fonte para os balões traduzidos',
        onchange: (e: Event) => {
          store.settings.font = (e.target as HTMLSelectElement).value as LetterFont;
          persist();
          this.paintOverlays();
        },
      },
      ...fonts.map(([id, label, desc]) =>
        el('option', { value: id, selected: id === store.settings.font, title: desc }, label),
      ),
    );
  }

  /** Provider de IA: openrouter, ollama, openaicompatible (via AI SDK). */
  private providerSelect(): HTMLElement {
    return el(
      'select',
      {
        class: 'ml-select ml-select-sm',
        title: 'provedor de IA (modo IA)',
        onchange: (e: Event) => {
          store.settings.aiProvider = (e.target as HTMLSelectElement).value as AiProviderName;
          persist();
          this.invalidateTranslations();
          this.checkAi();
        },
      },
      ...this.aiProviders.map((p) =>
        el('option', { value: p.id, selected: p.id === store.settings.aiProvider }, `IA: ${p.name}`),
      ),
    );
  }

  private bookmarkButton(): HTMLElement {
    const marked =
      this.chapter !== undefined && hasBookmark(this.chapter.provider, this.chapter.id, this.viewer.currentPage);
    return el(
      'button',
      {
        class: `ml-btn ml-btn-sm ${marked ? 'is-on' : ''}`,
        title: 'marcar esta pagina',
        onclick: () => {
          if (!this.detail || !this.chapter) return;
          const on = toggleBookmark({
            provider: this.detail.provider,
            seriesId: this.detail.id,
            chapterId: this.chapter.id,
            chapterLabel: this.chapterLabel(),
            page: this.viewer.currentPage,
            title: this.detail.title,
            cover: this.detail.cover,
          });
          toast(on ? 'pagina marcada' : 'marcador removido');
          this.refreshBars();
        },
      },
      marked ? '🔖 marcado' : '🔖 marcar',
    );
  }

  /**
   * Manga/manhwa le da direita para a esquerda; HQ ocidental, da esquerda para a
   * direita. Abrir uma HQ com o RTL do manga inverte a ordem das paginas na visao
   * dupla e as setas do teclado — por isso a obra decide, e o botao ainda corrige.
   */
  private rtlFor(detail: SeriesDetail | undefined): boolean {
    const western = ['en', 'pt-br', 'pt', 'es', 'fr', 'it', 'de'];
    if (detail?.type === 'comic' || western.includes((detail?.origin ?? '').toLowerCase())) return false;
    return store.settings.rtl;
  }

  private chapterLabel(): string {
    return this.chapter?.number ? `Cap. ${this.chapter.number}` : (this.chapter?.title ?? '');
  }

  /**
   * Barra fixa de status. Sem ela o `traduzir` fica ligado no armazenamento e o
   * leitor segue reconhecendo e traduzindo capitulos que o usuario nunca abriu,
   * sem nenhum sinal na tela nem como interromper.
   */
  private buildStatusBar(): HTMLElement {
    return el(
      'div',
      { class: 'ml-statusbar' },
      el('span', { class: 'ml-status-item' }, this.aiDot, this.aiLabel),
      el('span', { class: 'ml-status-item ml-status-grow' }, this.ocrStatus),
    );
  }

  /** Reflete na barra o que a fila esta' fazendo agora. */
  private syncStatus(): void {
    // no-op: mantido para compatibilidade
  }

  /** Estado do endpoint de IA — so' importa quando o motor cai nela. */
  private async checkAi(): Promise<void> {
    try {
      const h = await aiHealth(store.settings.aiProvider);
      this.aiDot.classList.toggle('is-on', Boolean(h.ok));
      const provPrefix = h.provider ? `[${h.provider}] ` : '';
      this.aiLabel.textContent = h.ok ? `IA: ${provPrefix}${h.model}` : `IA: ${provPrefix}offline`;
      this.aiLabel.title = h.ok ? `${h.baseUrl} — ${h.models?.length ?? 0} modelos` : (h.error ?? '');
    } catch {
      this.aiDot.classList.remove('is-on');
      this.aiLabel.textContent = 'IA: offline';
    }
  }

  private buildBottomBar(): HTMLElement {
    return el(
      'footer',
      { class: 'ml-reader-bottom' },
      el(
        'div',
        { class: 'ml-bottom-nav' },
        el('button', { class: 'ml-btn ml-btn-ghost', onclick: () => this.prevChapter(), title: 'Capítulo anterior' }, '« cap'),
        el('button', { class: 'ml-btn ml-btn-ghost', onclick: () => this.viewer.prev(), title: 'Página anterior' }, '‹'),
      ),
      this.film,
      el(
        'div',
        { class: 'ml-bottom-nav' },
        el('button', { class: 'ml-btn ml-btn-ghost', onclick: () => this.viewer.next(), title: 'Próxima página' }, '›'),
        el('button', { class: 'ml-btn ml-btn-ghost', onclick: () => this.nextChapter(), title: 'Próximo capítulo' }, 'cap »'),
      ),
      el(
        'div',
        { class: 'ml-zoom' },
        el('button', { class: 'ml-btn ml-btn-ghost', onclick: () => this.viewer.setZoom(this.viewer.zoom / 1.25) }, '−'),
        this.zoomRange,
        el('button', { class: 'ml-btn ml-btn-ghost', onclick: () => this.viewer.setZoom(this.viewer.zoom * 1.25) }, '+'),
        this.zoomLabel,
      ),
    );
  }

  private buildChatInput(): HTMLElement {
    const input = el('textarea', { class: 'ml-chat-input', rows: '2', placeholder: 'pergunte sobre a cena, personagem, referencia...' });
    const send = (): void => {
      const q = input.value.trim();
      if (!q) return;
      input.value = '';
      void this.ask(q);
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        send();
      }
    });
    return el(
      'div',
      { class: 'ml-chat-foot' },
      input,
      el('button', { class: 'ml-btn ml-btn-primary', onclick: send }, 'perguntar'),
      el('button', { class: 'ml-btn ml-btn-ghost', onclick: () => void this.ask('Explique o que esta acontecendo nesta pagina.') }, 'explicar pagina'),
    );
  }

  private refreshBars(): void {
    const top = this.host.querySelector('.ml-reader-top');
    // a barra e' reconstruida inteira a cada troca de modo/ajuste/marcador, e o
    // controle que o usuario acabou de acionar deixa de existir: sem devolver o
    // foco, navegar so' pelo teclado volta para o inicio do documento a cada clique
    const before = top ? [...top.querySelectorAll('button, select')] : [];
    const focused = before.indexOf(document.activeElement as Element);
    const next = this.buildTopBar();
    top?.replaceWith(next);
    if (focused >= 0) {
      const after = next.querySelectorAll<HTMLElement>('button, select');
      after[focused]?.focus();
    }
    this.host.querySelector('#reader-title')!.textContent = this.titleText();
  }

  // ---------- ciclo de leitura ----------

  private titleText(): string {
    if (!this.detail || !this.chapter) return '';
    const num = this.chapter.number ? `Cap. ${this.chapter.number}` : (this.chapter.title ?? '');
    return `${this.detail.title} — ${num}${this.chapter.lang ? ` (${langLabel(this.chapter.lang)})` : ''}`;
  }

  get isOpen(): boolean {
    return this.host.classList.contains('is-open');
  }

  /** O roteador de hash reabriria o mesmo capitulo por cima da leitura em curso. */
  isShowing(provider: string, seriesId: string, chapterId: string): boolean {
    return (
      this.host.classList.contains('is-open') &&
      this.detail?.provider === provider &&
      this.detail?.id === seriesId &&
      this.chapter?.id === chapterId
    );
  }

  async open(detail: SeriesDetail, chapter: ChapterRef, startPage = 0): Promise<void> {
    const sameSeries = this.detail?.provider === detail.provider && this.detail?.id === detail.id;
    this.detail = detail;
    this.chapter = chapter;
    if (!sameSeries) {
      this.ocrCache.clear();
      this.translatedAs.clear();
    }
    this.rtl = this.rtlFor(detail);
    this.viewer.setRtl(this.rtl);
    this.history = [];
    this.chatLog.innerHTML = '';
    this.host.classList.add('is-open');
    document.body.classList.add('is-reading');
    this.refreshBars();
    this.syncStatus();
    // o endpoint pode cair no meio da leitura: reconsulta enquanto o leitor vive
    void this.checkAi();
    clearInterval(this.aiTimer);
    this.aiTimer = window.setInterval(() => void this.checkAi(), 60_000);
    this.film.innerHTML = '';
    this.pageLabel.textContent = 'carregando...';
    this.stageLoading.classList.add('is-visible');

    try {
      const { pages } = await getPages(chapter.provider, chapter.id);
      if (!pages.length) throw new Error('capitulo sem paginas');
      this.pages = pages;
      this.viewer.setPages(pages, startPage);
      this.viewer.applyFit(store.settings.fit);
      this.buildFilm();
      this.paintOverlays();
    } catch (err) {
      // `this.chapter` ja' aponta para o capitulo novo: deixar as paginas do
      // anterior no palco faria o OCR gravar pagina velha sob a chave do novo
      this.pages = [];
      this.viewer.setPages([], 0);
      this.film.innerHTML = '';
      this.pageLabel.textContent = 'falhou';
      toast(`capitulo nao abriu: ${(err as Error).message}`, 'error');
    } finally {
      this.stageLoading.classList.remove('is-visible');
    }
  }

  close(): void {
    this.hideTooltip();
    clearInterval(this.aiTimer);
    this.host.classList.remove('is-open');
    document.body.classList.remove('is-reading');
    this.onExit();
  }

  private buildFilm(): void {
    this.film.innerHTML = '';
    this.pages.forEach((p, i) => {
      this.film.append(
        el(
          'button',
          { class: 'ml-thumb', dataset: { page: String(i) }, onclick: () => this.viewer.goToPage(i) },
          el('img', { src: p.url, loading: 'lazy', alt: `pagina ${i + 1}` }),
          el('span', {}, String(i + 1)),
        ),
      );
    });
  }

  private onPageChange(page: number): void {
    // capitulo que nao abriu nao tem pagina: sem esta guarda o `page >= length-1`
    // abaixo daria verdadeiro em 0 >= -1 e marcaria como lido o que nunca abriu
    if (!this.pages.length) return;
    this.hideTooltip();
    this.pageLabel.textContent = `${page + 1} / ${this.pages.length}`;
    for (const t of this.film.children) t.classList.toggle('is-current', t.getAttribute('data-page') === String(page));
    this.film.querySelector('.is-current')?.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'smooth' });
    if (this.detail && this.chapter) {
      saveProgress({
        provider: this.detail.provider,
        seriesId: this.detail.id,
        chapterId: this.chapter.id,
        chapterLabel: this.chapterLabel(),
        page,
        title: this.detail.title,
        cover: this.detail.cover,
        at: Date.now(),
      });
      // chegou na ultima pagina: o capitulo conta como lido
      if (page >= this.pages.length - 1) {
        markChapterRead(this.detail.provider, this.detail.id, this.chapter.id);
      }
    }
    this.paintOverlays();
  }

  /**
   * Virar a pagina disparava duas repinturas completas (`onSheetsChange` e depois
   * `onPageChange`), e cada uma refaz a busca binaria de corpo de letra balao a
   * balao. Juntar no proximo quadro faz o trabalho uma vez so'.
   */
  private paintOverlays(): void {
    if (this.paintHandle) return;
    this.paintHandle = requestAnimationFrame(() => {
      this.paintHandle = 0;
      this.repaintNow();
    });
  }

  private repaintNow(): void {
    for (const sheet of this.viewer.visibleSheets()) {
      const blocks = this.ocrCache.get(this.pageKey(sheet.page));
      const width = sheet.img.naturalWidth || 1;
      const height = sheet.img.naturalHeight || 1;
      paintPage(sheet.ocr, blocks ?? [], {
        showOriginal: store.settings.showOriginal,
        font: store.settings.font,
        width,
        height,
      });
    }
  }

  /** Cache por capitulo: a fila adianta paginas de capitulos que ainda nem abriram. */
  private pageKey(page: number, chapterId = this.chapter?.id ?? ''): string {
    return `${chapterId}:${page}`;
  }

  // ---------- OCR + traducao ----------

  /** Motor + idioma + provider com que uma traducao foi feita; muda um, a traducao vence. */
  private stamp(): string {
    const mode = store.settings.translateMode;
    const prov = mode === 'ai' ? store.settings.aiProvider : store.settings.engine;
    return `${mode}|${prov}|${store.settings.targetLang}`;
  }

  /**
   * Trocar motor ou idioma de destino invalida a traducao, nao o reconhecimento:
   * o cache continua servindo de entrada e so' a chamada ao tradutor se repete.
   */
  private invalidateTranslations(): void {
    this.translatedAs.clear();
    this.paintOverlays();
  }

  /** Executa OCR apenas na página atual, sem traduzir. */
  private async runOcrOnly(): Promise<void> {
    if (this.busy) return;
    const targets = this.viewer.visibleSheets();
    if (!targets.length) return;
    this.busy = true;

    try {
      let totalBalloons = 0;
      for (const sheet of targets) {
        try {
          if (!(await imageReady(sheet.img))) {
            this.ocrStatus.textContent = `pag. ${sheet.page + 1} nao carregou`;
            continue;
          }
          const key = this.pageKey(sheet.page);
          const detectedLang = this.chapter?.lang ?? this.detail?.origin;
          const langDisplay = detectedLang ? langLabel(detectedLang) : 'auto';
          const lang = langFor(this.chapter?.lang, this.detail?.origin, store.settings.ocrLang);
          this.ocrStatus.textContent = `OCR pag. ${sheet.page + 1} (${langDisplay})...`;
          const blocks = await recognizePage(sheet.img, lang, (p) => {
            this.ocrStatus.textContent = `pag. ${sheet.page + 1}: ${p.stage} ${Math.round(p.ratio * 100)}%`;
          });
          this.ocrCache.set(key, blocks);
          this.trimCache();
          totalBalloons += blocks.length;
          this.paintOverlays();
        } catch (err) {
          toast(`OCR falhou: ${(err as Error).message}`, 'error');
        }
      }
      this.ocrStatus.textContent = totalBalloons
        ? `OCR: ${totalBalloons} balão(ões) detectado(s)`
        : 'sem texto detectado nesta página';
    } finally {
      this.busy = false;
    }
  }

  /** Traduz os balões da página atual (executa OCR antes se ainda não tiver sido feito). */
  private async runTranslate(): Promise<void> {
    if (this.busy) return;
    const targets = this.viewer.visibleSheets();
    if (!targets.length) return;
    this.busy = true;
    if (store.settings.translateMode === 'ai') void this.checkAi();

    try {
      let translatedBalloons = 0;
      for (const sheet of targets) {
        try {
          if (!(await imageReady(sheet.img))) {
            this.ocrStatus.textContent = `pag. ${sheet.page + 1} nao carregou`;
            continue;
          }
          const key = this.pageKey(sheet.page);
          let blocks = this.ocrCache.get(key);
          if (!blocks) {
            const detectedLang = this.chapter?.lang ?? this.detail?.origin;
            const langDisplay = detectedLang ? langLabel(detectedLang) : 'auto';
            const lang = langFor(this.chapter?.lang, this.detail?.origin, store.settings.ocrLang);
            this.ocrStatus.textContent = `OCR pag. ${sheet.page + 1} (${langDisplay})...`;
            blocks = await recognizePage(sheet.img, lang, (p) => {
              this.ocrStatus.textContent = `pag. ${sheet.page + 1}: ${p.stage} ${Math.round(p.ratio * 100)}%`;
            });
            this.ocrCache.set(key, blocks);
            this.trimCache();
          }
          if (!blocks.length) {
            this.translatedAs.set(key, this.stamp());
            continue;
          }

          const mode = store.settings.translateMode;
          const modeLabel = mode === 'ai' ? `IA (${store.settings.aiProvider})` : `motor (${store.settings.engine})`;
          this.ocrStatus.textContent = `pag. ${sheet.page + 1}: traduzindo ${blocks.length} balões via ${modeLabel}...`;
          const stamp = this.stamp();
          const activeEngine = mode === 'ai' ? 'llm' : store.settings.engine;
          const translated = await translateBlocks(blocks, {
            sourceLang: this.chapter?.lang ?? this.detail?.origin,
            series: this.detail?.title,
            chapter: this.chapter?.number,
            engine: activeEngine,
            target: store.settings.targetLang,
            provider: mode === 'ai' ? store.settings.aiProvider : undefined,
          });
          this.ocrCache.set(key, translated);
          this.trimCache();
          this.translatedAs.set(key, stamp);
          translatedBalloons += translated.length;
          this.paintOverlays();
        } catch (err) {
          toast(`Tradução falhou: ${(err as Error).message}`, 'error');
        }
      }
      this.ocrStatus.textContent = translatedBalloons
        ? `Traduzido: ${translatedBalloons} balão(ões)`
        : 'sem balões para traduzir';
    } finally {
      this.busy = false;
    }
  }

  private static readonly CACHE_LIMIT = 3000;

  private trimCache(): void {
    while (this.ocrCache.size > Reader.CACHE_LIMIT) {
      const oldest = this.ocrCache.keys().next().value;
      if (oldest === undefined) break;
      this.ocrCache.delete(oldest);
      this.translatedAs.delete(oldest);
    }
  }

  /** Caminho paralelo ao OCR: manda a pagina inteira para um modelo com visao. */
  private async visionRead(): Promise<void> {
    const sheet = this.viewer.visibleSheets()[0];
    if (!sheet) return;
    this.chat.classList.add('is-open');
    const bubble = this.pushMessage('assistant', 'lendo a pagina com o modelo de visao...');
    try {
      const canvas = document.createElement('canvas');
      const scale = Math.min(1, 1400 / (sheet.img.naturalWidth || 1400));
      canvas.width = Math.round(sheet.img.naturalWidth * scale);
      canvas.height = Math.round(sheet.img.naturalHeight * scale);
      canvas.getContext('2d')!.drawImage(sheet.img, 0, 0, canvas.width, canvas.height);
      const { balloons } = await visionTranslate({
        imageDataUrl: canvas.toDataURL('image/jpeg', 0.85),
        series: this.detail?.title,
        chapter: this.chapter?.number,
        provider: store.settings.aiProvider,
      });
      bubble.textContent = balloons.length
        ? balloons.map((b, i) => `${i + 1}. ${b.pt}\n   (${b.original})`).join('\n')
        : 'o modelo nao encontrou texto na pagina';
    } catch (err) {
      bubble.textContent = `falhou: ${(err as Error).message}`;
    }
  }

  // ---------- assistente ----------

  private pushMessage(role: 'user' | 'assistant', text: string): HTMLElement {
    const body = el('div', { class: 'ml-msg-body' }, text);
    this.chatLog.append(el('div', { class: `ml-msg is-${role}` }, body));
    this.chatLog.scrollTop = this.chatLog.scrollHeight;
    return body;
  }

  private async ask(question: string): Promise<void> {
    this.chat.classList.add('is-open');
    this.pushMessage('user', question);
    const bubble = this.pushMessage('assistant', '');
    const pageText = this.viewer
      .visibleSheets()
      .flatMap((s) => this.ocrCache.get(this.pageKey(s.page)) ?? [])
      .map((b) => b.pt || b.text)
      .filter(Boolean);

    try {
      let full = '';
      for await (const chunk of explain({
        series: this.detail?.title,
        description: this.detail?.description,
        chapter: this.chapter?.number,
        pageText,
        question,
        history: this.history.slice(-6),
        provider: store.settings.aiProvider,
      })) {
        full += chunk;
        bubble.textContent = full;
        this.chatLog.scrollTop = this.chatLog.scrollHeight;
      }
      this.history.push({ role: 'user', content: question }, { role: 'assistant', content: full });
      if (!full.trim()) bubble.textContent = '(o modelo devolveu vazio — confira AI_MODEL e AI_MAX_TOKENS)';
    } catch (err) {
      bubble.textContent = `falhou: ${(err as Error).message}`;
    }
  }

  // ---------- navegacao ----------

  private siblingChapters(): ChapterRef[] {
    const lang = this.chapter?.lang;
    return (this.detail?.chapters ?? []).filter((c) => c.lang === lang);
  }

  private stepChapter(delta: number): void {
    const list = this.siblingChapters();
    const i = list.findIndex((c) => c.id === this.chapter?.id);
    const next = list[i + delta];
    if (!next || !this.detail) return toast('nao ha capitulo nessa direcao');
    void this.open(this.detail, next, 0);
  }

  private nextChapter(): void {
    this.stepChapter(1);
  }
  private prevChapter(): void {
    this.stepChapter(-1);
  }

  private async toggleFullscreen(): Promise<void> {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await this.host.requestFullscreen().catch(() => undefined);
  }

  private onKey = (e: KeyboardEvent): void => {
    if (!this.host.classList.contains('is-open')) return;
    if ((e.target as HTMLElement)?.tagName === 'TEXTAREA' || (e.target as HTMLElement)?.tagName === 'INPUT') return;
    const rtl = this.rtl;
    switch (e.key) {
      case 'ArrowRight':
        if (rtl) this.viewer.prev();
        else this.viewer.next();
        break;
      case 'ArrowLeft':
        if (rtl) this.viewer.next();
        else this.viewer.prev();
        break;
      case 'ArrowDown':
      case ' ':
        e.preventDefault();
        this.viewer.next();
        break;
      case 'ArrowUp':
        this.viewer.prev();
        break;
      case '+':
      case '=':
        this.viewer.setZoom(this.viewer.zoom * 1.25);
        break;
      case '-':
        this.viewer.setZoom(this.viewer.zoom / 1.25);
        break;
      case '0':
        this.viewer.applyFit('page');
        break;
      case '1':
        this.viewer.setZoom(1);
        break;
      case 'o':
      case 'O':
        void this.runOcrOnly();
        break;
      case 'r':
      case 'R':
        void this.runTranslate();
        break;
      case 't':
      case 'T':
        store.settings.showOriginal = !store.settings.showOriginal;
        persist();
        this.refreshBars();
        this.paintOverlays();
        break;
      case 'f':
        void this.toggleFullscreen();
        break;
      case 'Escape':
        if (document.fullscreenElement) void document.exitFullscreen();
        else this.close();
        break;
      default:
        return;
    }
  };
}
